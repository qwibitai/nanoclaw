import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  PLUGINS_DIR,
  TIMEZONE,
  WORKTREES_DIR,
  getParentJid,
  parseThreadJid,
} from './config.js';
import { AvailableGroup, withGroupMutex } from './container-runner.js';
import {
  addBacklogItem,
  addShipLogEntry,
  createTask,
  deleteBacklogItem,
  deleteTask,
  findMessageById,
  getBacklog,
  getBacklogItemById,
  getMessagesAroundTimestamp,
  getShipLog,
  getTaskById,
  getThreadMessages,
  getThreadMetadata,
  getThreadOrigin,
  storeMessage,
  updateBacklogItem,
  updateTask,
} from './db.js';
import {
  deleteMemory,
  listMemories,
  saveMemory,
  searchMemoriesKeyword,
  searchMemoriesSemantic,
  updateMemory,
} from './memory-store.js';
import { runCommitDigestForGroup } from './commit-digest.js';
import { getActivitySummary } from './daily-notifications.js';
import { searchThreads } from './thread-search.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { Memory, OutboundFile, RegisteredGroup } from './types.js';

// ── In-memory gate tracking (replaces pending_gates DB table) ───────────────
// Gates are short-lived (10min TTL). Lost on restart = OK — the container's
// plugin hook times out too.
//
// Reference to a posted interactive gate message. Used to clear the approve/
// cancel buttons when the gate is resolved via a path other than a click
// (auto-cancel-on-text, TTL expiry, container teardown). Without this,
// stale buttons can still be clicked and display a misleading
// "Gate approved" UI for a gate that was actually cancelled — a
// safety-relevant misrepresentation for destructive commands.
export interface GatePostedMessageRef {
  /** Channel name from Channel.name (e.g. "slack", "slack:sunday", "discord"). */
  channel: string;
  /** Platform-native channel identifier (Slack channel id, Discord channel id). */
  channelId: string;
  /** Platform-native message identifier (Slack ts, Discord message snowflake). */
  messageId: string;
}

interface InMemoryGate {
  id: string;
  chatJid: string;
  threadJid: string; // full JID with :thread: suffix if applicable
  label: string;
  command?: string;
  requestId: string;
  ipcBaseDir: string;
  sourceGroup: string;
  createdAt: number;
  /** Delivery timestamp; null while send is in flight. Skipped from
   * `getInMemoryGateByJid` within the grace window to prevent a user
   * follow-up from auto-cancelling a gate they haven't seen yet. */
  notifiedAt: number | null;
  /** Posted interactive-gate message reference, once sendInteractiveGate succeeds. */
  postedRef: GatePostedMessageRef | null;
}

const pendingGates = new Map<string, InMemoryGate>();
const GATE_TTL_MS = 10 * 60 * 1000; // 10 min cleanup
// Delivery-race grace: skip auto-cancel-on-text lookups if the gate was
// created within this window and has not been marked notifiedAt yet. The
// typical Slack/Discord network round-trip for chat.postMessage is 200-500ms;
// 2s provides headroom without being noticeable to the user.
const GATE_DELIVERY_GRACE_MS = 2_000;

/**
 * Look up a pending gate for a chat JID. Returns undefined if no gate
 * matches OR if the gate is within its delivery-race grace window (gate
 * created very recently and notification still in flight — the user can't
 * have acted on a gate they haven't seen). Exact-match on threadJid only:
 * the earlier OR-match on chatJid caused cross-thread interference where a
 * top-level channel message would match any child thread's gate.
 */
export function getInMemoryGateByJid(jid: string): InMemoryGate | undefined {
  const now = Date.now();
  for (const gate of pendingGates.values()) {
    if (gate.threadJid !== jid) continue;
    // Skip gates still in the pre-notification grace window. After the
    // notification completes the grace check is moot (notifiedAt is set).
    if (
      gate.notifiedAt === null &&
      now - gate.createdAt < GATE_DELIVERY_GRACE_MS
    ) {
      continue;
    }
    return gate;
  }
  return undefined;
}

/**
 * Record the channel-native message reference of a posted interactive gate
 * so the orchestrator can clear the buttons later when the gate is resolved
 * via a non-click path. Called by Channel.sendInteractiveGate implementations
 * immediately after chat.postMessage / channel.send succeeds.
 */
export function recordGatePostedMessage(
  gateId: string,
  ref: GatePostedMessageRef,
): void {
  const gate = pendingGates.get(gateId);
  if (!gate) return; // gate already resolved or never existed — nothing to do
  gate.postedRef = ref;
  gate.notifiedAt = Date.now();
}

/** Mark a gate as delivered even when we have no posted message ref (text fallback path). */
export function markGateNotified(gateId: string): void {
  const gate = pendingGates.get(gateId);
  if (!gate) return;
  gate.notifiedAt = Date.now();
}

export function resolveInMemoryGate(
  gateId: string,
  decision: 'approved' | 'cancelled',
): boolean {
  // MUST stay synchronous — a yield between get() and delete() would open a
  // double-resolve race with concurrent callers (button click + text reply +
  // TTL cleanup can all race). writeQueryResponse uses writeFileSync/renameSync
  // which do not yield.
  const gate = pendingGates.get(gateId);
  if (!gate) return false;
  writeQueryResponse(gate.ipcBaseDir, gate.sourceGroup, gate.requestId, {
    status: 'ok',
    decision,
  });
  pendingGates.delete(gateId);
  return true;
}

/**
 * Sweep pendingGates for a specific threadJid (e.g. on container teardown)
 * and resolve each match as cancelled so the plugin hook unblocks even if
 * the container is already gone. Returns the set of swept gates with their
 * posted message references so the caller can clear the chat-native
 * buttons. `auto_cancel_text` is intentionally excluded from the reason
 * union — that path runs in-process via resolveInMemoryGate directly and
 * never sweeps.
 */
export function clearGatesForThread(
  threadJid: string,
  reason: Exclude<
    import('./types.js').GateClearReason,
    'auto_cancel_text'
  > = 'teardown',
): Array<{
  gateId: string;
  label: string;
  postedRef: GatePostedMessageRef | null;
}> {
  const swept: Array<{
    gateId: string;
    label: string;
    postedRef: GatePostedMessageRef | null;
  }> = [];
  for (const [id, gate] of pendingGates) {
    if (gate.threadJid !== threadJid) continue;
    try {
      writeQueryResponse(gate.ipcBaseDir, gate.sourceGroup, gate.requestId, {
        status: 'ok',
        decision: 'cancelled',
      });
    } catch (err) {
      // Container may already be gone — swallow.
      logger.debug(
        { gateId: id, err },
        'clearGatesForThread: writeQueryResponse failed (container likely gone)',
      );
    }
    swept.push({ gateId: id, label: gate.label, postedRef: gate.postedRef });
    pendingGates.delete(id);
    logger.info(
      { gateId: id, label: gate.label, reason, threadJid },
      'Gate swept from pending map',
    );
  }
  return swept;
}

// Periodic cleanup of orphaned gates (container crashed / timed out). MUST
// write a cancelled response before deleting the Map entry — otherwise the
// plugin hook polling inside the container hangs indefinitely waiting for
// a response file that never arrives.
setInterval(() => {
  const now = Date.now();
  for (const [id, gate] of pendingGates) {
    if (now - gate.createdAt <= GATE_TTL_MS) continue;
    try {
      writeQueryResponse(gate.ipcBaseDir, gate.sourceGroup, gate.requestId, {
        status: 'ok',
        decision: 'cancelled',
      });
    } catch (err) {
      logger.debug(
        { gateId: id, err },
        'TTL cleanup: writeQueryResponse failed',
      );
    }
    pendingGates.delete(id);
    logger.warn(
      { gateId: id, label: gate.label },
      'Gate expired (TTL) — auto-cancelled',
    );
    // Dangling chat buttons no-op safely — ipc.ts has no Channel reference.
  }
}, 60_000);

const BACKLOG_NOT_OWNED_MSG = 'Backlog item not found or not owned by group';
const VALID_MEMORY_TYPES = [
  'user',
  'feedback',
  'project',
  'reference',
] as const;

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    sender?: string,
    threadId?: string,
  ) => Promise<void>;
  sendFile: (
    jid: string,
    file: OutboundFile,
    caption?: string,
    sender?: string,
    threadId?: string,
  ) => Promise<void>;
  /**
   * Post a destructive-command gate via the channel's native interactive
   * components (Slack Block Kit buttons, Discord components). Returns true
   * when successfully sent via the interactive path; returns false when the
   * channel does not support interactive gates, so the caller can fall back
   * to a plain-text prompt. Implementations MUST also persist the gate
   * prompt to messages.db for thread history.
   */
  sendInteractiveGate?: (
    jid: string,
    gate: import('./types.js').InteractiveGate,
    threadId?: string,
  ) => Promise<boolean>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
}

/** Remap a container path under /workspace/ipc/ to the host-side equivalent. */
function resolveContainerPath(
  containerPath: string,
  sourceGroup: string,
): string {
  return containerPath.replace(
    '/workspace/ipc/',
    path.join(DATA_DIR, 'ipc', sourceGroup) + '/',
  );
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');
      const queriesDir = path.join(ipcBaseDir, sourceGroup, 'queries');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (
                data.type === 'message' &&
                data.chatJid &&
                (data.text || data.files)
              ) {
                // Authorization: verify this group can send to this chatJid
                // Handle thread JIDs by checking parent JID for group resolution
                const targetGroup =
                  registeredGroups[data.chatJid] ||
                  registeredGroups[getParentJid(data.chatJid)];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  // Handle file attachments
                  if (
                    data.files &&
                    Array.isArray(data.files) &&
                    data.files.length > 0
                  ) {
                    let captionSent = false;
                    const expectedBase =
                      path.join(
                        DATA_DIR,
                        'ipc',
                        sourceGroup,
                        'outbound_files',
                      ) + '/';
                    for (const fileRef of data.files) {
                      const hostPath = resolveContainerPath(
                        fileRef.path,
                        sourceGroup,
                      );
                      // Bounds check: prevent path traversal
                      if (!path.resolve(hostPath).startsWith(expectedBase)) {
                        logger.warn(
                          { hostPath, sourceGroup },
                          'Outbound file path outside expected dir, skipping',
                        );
                        continue;
                      }
                      if (!fs.existsSync(hostPath)) {
                        logger.warn(
                          { hostPath, sourceGroup },
                          'Outbound file not found on host',
                        );
                        continue;
                      }
                      // Send caption only with the first file
                      const caption =
                        !captionSent && data.text ? data.text : undefined;
                      captionSent = captionSent || !!data.text;
                      await deps.sendFile(
                        data.chatJid,
                        {
                          hostPath,
                          filename: fileRef.filename,
                          mimeType: fileRef.mimeType,
                        },
                        caption,
                        data.sender,
                        data.threadId,
                      );
                      // Cleanup staging dir
                      try {
                        const fileDir = path.dirname(hostPath);
                        fs.rmSync(fileDir, { recursive: true, force: true });
                      } catch (cleanupErr) {
                        logger.warn(
                          { hostPath, err: cleanupErr },
                          'Failed to cleanup outbound file',
                        );
                      }
                    }
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        fileCount: data.files.length,
                      },
                      'IPC file(s) sent',
                    );
                  } else if (data.text) {
                    // Text-only message (existing path)
                    await deps.sendMessage(
                      data.chatJid,
                      data.text,
                      data.sender,
                      data.threadId,
                    );
                    logger.info(
                      {
                        chatJid: data.chatJid,
                        sourceGroup,
                        sender: data.sender,
                      },
                      'IPC message sent',
                    );
                  }
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // Process queries from this group's IPC directory (request-response pattern)
      try {
        if (fs.existsSync(queriesDir)) {
          const queryFiles = fs
            .readdirSync(queriesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of queryFiles) {
            const filePath = path.join(queriesDir, file);
            let requestId: string | undefined;
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              requestId = data.requestId;
              processQueryIpc(
                data,
                sourceGroup,
                isMain,
                ipcBaseDir,
                registeredGroups,
                deps,
              );
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC query',
              );
              if (requestId) {
                writeQueryResponse(ipcBaseDir, sourceGroup, requestId, {
                  status: 'error',
                  error: 'Internal processing error',
                });
              }
            } finally {
              try {
                fs.unlinkSync(filePath);
              } catch {
                /* already deleted */
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC queries directory',
        );
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    model?: string;
    notifyJid?: string;
    tools?: string[] | null;
    // For ship_log / backlog
    itemId?: string;
    title?: string;
    description?: string;
    pr_url?: string;
    branch?: string;
    tags?: string;
    status?: string;
    priority?: string;
    notes?: string;
    // For memory operations
    memoryId?: string;
    memoryType?: string;
    memoryName?: string;
    memoryDescription?: string;
    memoryContent?: string;
    memoryFields?: Record<string, string>;
    // For gate protocol
    label?: string;
    summary?: string;
    context_data?: string;
    resume_prompt?: string;
    session_key?: string;
    gateId?: string;
    threadId?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'set_group_notify_jid':
    // falls through — notifyJid updates share the same handler as model updates
    // eslint-disable-next-line no-fallthrough
    case 'set_group_model':
      // Only main group can update group model
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized set_group_model attempt blocked',
        );
        break;
      }
      if (data.jid) {
        const existing = registeredGroups[data.jid];
        if (!existing) {
          logger.warn({ jid: data.jid }, 'set_group_model: unknown JID');
          break;
        }
        const updatedConfig = {
          ...existing.containerConfig,
          ...(data.model ? { model: data.model } : {}),
          ...(data.notifyJid !== undefined
            ? { notifyJid: data.notifyJid || undefined }
            : {}),
        };
        // If model is null/empty string, remove the key
        if (!data.model) {
          delete updatedConfig.model;
        }
        // If notifyJid is empty string, remove the key
        if (data.notifyJid === '') {
          delete updatedConfig.notifyJid;
        }
        deps.registerGroup(data.jid, {
          ...existing,
          containerConfig:
            Object.keys(updatedConfig).length > 0 ? updatedConfig : undefined,
        });
        logger.info(
          {
            jid: data.jid,
            model: data.model || '(unchanged)',
            notifyJid: data.notifyJid || '(unchanged)',
          },
          'Group config updated',
        );
      } else {
        logger.warn({ data }, 'set_group_model: missing jid');
      }
      break;

    case 'set_group_tools':
      // Only main group can update group tools
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized set_group_tools attempt blocked',
        );
        break;
      }
      if (data.jid) {
        const existing = registeredGroups[data.jid];
        if (!existing) {
          logger.warn({ jid: data.jid }, 'set_group_tools: unknown JID');
          break;
        }
        // null = remove tools key (all tools enabled), [] or [...] = explicit list
        // undefined (field absent from IPC JSON) = no-op, leave tools unchanged
        const updatedConfig = { ...existing.containerConfig };
        if (data.tools === null) {
          delete updatedConfig.tools;
        } else if (data.tools !== undefined) {
          updatedConfig.tools = data.tools;
        }
        deps.registerGroup(data.jid, {
          ...existing,
          containerConfig:
            Object.keys(updatedConfig).length > 0 ? updatedConfig : undefined,
        });
        const tools = data.tools;
        const label =
          tools === null || tools === undefined
            ? '(cleared — all tools enabled)'
            : tools.length === 0
              ? '(empty — all tools disabled)'
              : tools.join(', ');
        logger.info({ jid: data.jid, tools: label }, 'Group tools updated');
      } else {
        logger.warn({ data }, 'set_group_tools: missing jid');
      }
      break;

    case 'add_ship_log':
      if (data.title) {
        const entryId = `ship-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        addShipLogEntry({
          id: entryId,
          group_folder: sourceGroup,
          title: data.title,
          description: data.description || null,
          pr_url: data.pr_url || null,
          branch: data.branch || null,
          tags: data.tags || null,
          shipped_at: new Date().toISOString(),
        });
        logger.info(
          { entryId, title: data.title, sourceGroup },
          'Ship log entry added via IPC',
        );
      } else {
        logger.warn({ data }, 'add_ship_log missing title');
      }
      break;

    case 'add_backlog_item':
      if (data.title) {
        const itemId = `backlog-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const now = new Date().toISOString();
        const itemPriority =
          (data.priority as 'low' | 'medium' | 'high') || 'medium';
        addBacklogItem({
          id: itemId,
          group_folder: sourceGroup,
          title: data.title,
          description: data.description || null,
          status:
            (data.status as 'open' | 'in_progress' | 'resolved' | 'wont_fix') ||
            'open',
          priority: itemPriority,
          tags: data.tags || null,
          notes: data.notes || null,
          created_at: now,
          updated_at: now,
          resolved_at: null,
        });
        logger.info(
          { itemId, title: data.title, sourceGroup },
          'Backlog item added via IPC',
        );
      } else {
        logger.warn({ data }, 'add_backlog_item missing title');
      }
      break;

    case 'update_backlog_item':
      if (data.itemId) {
        const existingItem = getBacklogItemById(data.itemId);
        if (!existingItem) {
          logger.warn(
            { itemId: data.itemId, sourceGroup },
            'update_backlog_item: item not found',
          );
          break;
        }
        if (!isMain && existingItem.group_folder !== sourceGroup) {
          logger.warn(
            {
              itemId: data.itemId,
              sourceGroup,
              owner: existingItem.group_folder,
            },
            'Unauthorized update_backlog_item attempt blocked',
          );
          break;
        }
        const updates: Parameters<typeof updateBacklogItem>[1] = {};
        if (data.title !== undefined) updates.title = data.title;
        if (data.description !== undefined)
          updates.description = data.description;
        if (data.status !== undefined)
          updates.status = data.status as
            | 'open'
            | 'in_progress'
            | 'resolved'
            | 'wont_fix';
        if (data.priority !== undefined)
          updates.priority = data.priority as 'low' | 'medium' | 'high';
        if (data.tags !== undefined) updates.tags = data.tags;
        if (data.notes !== undefined) updates.notes = data.notes;
        if (data.status === 'resolved' || data.status === 'wont_fix') {
          updates.resolved_at = new Date().toISOString();
        }
        // Non-main groups can only update their own items
        const updateGroupFilter = isMain ? undefined : sourceGroup;
        const updated = updateBacklogItem(
          data.itemId,
          updates,
          updateGroupFilter,
        );
        if (updated) {
          logger.info(
            { itemId: data.itemId, updates },
            'Backlog item updated via IPC',
          );
        } else {
          logger.warn(
            { itemId: data.itemId, sourceGroup },
            BACKLOG_NOT_OWNED_MSG,
          );
        }
      } else {
        logger.warn({ data }, 'update_backlog_item missing itemId');
      }
      break;

    case 'delete_backlog_item':
      if (data.itemId) {
        const deleted = deleteBacklogItem(data.itemId, sourceGroup);
        if (deleted) {
          logger.info({ itemId: data.itemId }, 'Backlog item deleted via IPC');
        } else {
          logger.warn(
            { itemId: data.itemId, sourceGroup },
            BACKLOG_NOT_OWNED_MSG,
          );
        }
      } else {
        logger.warn({ data }, 'delete_backlog_item missing itemId');
      }
      break;

    case 'save_memory':
      if (data.memoryName && data.memoryDescription && data.memoryContent) {
        const memType = (data.memoryType ?? 'reference') as Memory['type'];
        const resolvedType = (
          VALID_MEMORY_TYPES.includes(memType) ? memType : 'reference'
        ) as Memory['type'];
        const memId = saveMemory(
          sourceGroup,
          resolvedType,
          data.memoryName,
          data.memoryDescription,
          data.memoryContent,
        );
        logger.info(
          { memId, sourceGroup, type: resolvedType },
          'Memory saved via IPC',
        );
      } else {
        logger.warn({ data }, 'save_memory missing required fields');
      }
      break;

    case 'delete_memory':
      if (data.memoryId) {
        const deleted = deleteMemory(sourceGroup, data.memoryId);
        if (deleted) {
          logger.info(
            { memoryId: data.memoryId, sourceGroup },
            'Memory deleted via IPC',
          );
        } else {
          logger.warn(
            { memoryId: data.memoryId, sourceGroup },
            'delete_memory: not found or not owned',
          );
        }
      } else {
        logger.warn({ data }, 'delete_memory missing memoryId');
      }
      break;

    case 'update_memory':
      if (data.memoryId && data.memoryFields) {
        const updated = updateMemory(sourceGroup, data.memoryId, {
          ...(data.memoryFields.type !== undefined && {
            type: (VALID_MEMORY_TYPES.includes(
              data.memoryFields.type as Memory['type'],
            )
              ? data.memoryFields.type
              : 'reference') as Memory['type'],
          }),
          ...(data.memoryFields.name !== undefined && {
            name: data.memoryFields.name,
          }),
          ...(data.memoryFields.description !== undefined && {
            description: data.memoryFields.description,
          }),
          ...(data.memoryFields.content !== undefined && {
            content: data.memoryFields.content,
          }),
        });
        logger.info(
          { memoryId: data.memoryId, sourceGroup, updated },
          'Memory updated via IPC',
        );
      } else {
        logger.warn({ data }, 'update_memory missing memoryId or memoryFields');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

// --- IPC Query handling (request-response pattern) ---

export function writeQueryResponse(
  ipcBaseDir: string,
  groupFolder: string,
  requestId: string,
  response: object,
): void {
  const responseDir = path.join(ipcBaseDir, groupFolder, 'query_responses');
  fs.mkdirSync(responseDir, { recursive: true });
  const filepath = path.join(responseDir, `${requestId}.json`);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(response));
  fs.renameSync(tempPath, filepath);
}

/** Convert DB message rows to IPC wire format. */
function formatMessagesForIpc(
  messages: Array<{
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: number;
  }>,
): Array<{
  sender: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
}> {
  return messages.map((m) => ({
    sender: m.sender_name,
    content: m.content,
    timestamp: m.timestamp,
    is_from_me: m.is_from_me === 1,
  }));
}

export function processQueryIpc(
  data: {
    type: string;
    requestId: string;
    channelId?: string;
    threadTs?: string;
    chatJid?: string;
    messageId?: string;
    limit?: number;
    query?: string;
    threadKey?: string;
    // For backlog/ship_log queries
    status?: string;
    // For activity summary
    hours?: number;
    // For memory queries
    memoryId?: string;
    // For gate queries
    gateId?: string;
    // For plugin updates
    plugin?: string;
    // For request_gate
    label?: string;
    summary?: string;
    command?: string;
    context_data?: string;
    threadId?: string;
    // For create_worktree
    repo?: string;
    branch?: string;
    // For clone_repo
    url?: string;
    name?: string;
    // For git_commit
    message?: string;
    // For open_pr
    title?: string;
    body?: string;
  },
  sourceGroup: string,
  isMain: boolean,
  ipcBaseDir: string,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: IpcDeps,
): void {
  if (!data.requestId) {
    logger.warn({ data }, 'IPC query missing requestId');
    return;
  }
  // Sanitize requestId to prevent path traversal (agent-controlled value used in file paths)
  if (/[/\\]/.test(data.requestId) || data.requestId.includes('..')) {
    logger.warn(
      { requestId: data.requestId },
      'IPC query requestId contains path traversal',
    );
    return;
  }

  switch (data.type) {
    case 'read_thread': {
      // Resolve thread JID from Slack channel ID + thread ts
      if (!data.channelId || !data.threadTs) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Missing channelId or threadTs',
        });
        break;
      }

      const parentJid = `slack:${data.channelId}`;
      const threadJid = `slack:${data.channelId}:thread:${data.threadTs}`;

      // Authorization: verify this group can read from this channel
      const targetGroup =
        registeredGroups[parentJid] ||
        registeredGroups[getParentJid(parentJid)];
      if (!isMain && (!targetGroup || targetGroup.folder !== sourceGroup)) {
        logger.warn(
          { sourceGroup, parentJid },
          'Unauthorized read_thread attempt blocked',
        );
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Unauthorized: channel not accessible to this group',
        });
        break;
      }

      const messages = getThreadMessages(threadJid, data.limit || 50);
      logger.info(
        { sourceGroup, threadJid, count: messages.length },
        'IPC read_thread query served',
      );
      writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
        status: 'ok',
        chatJid: threadJid,
        messages: formatMessagesForIpc(messages),
      });
      break;
    }

    case 'read_messages': {
      // Read messages from a specific JID (parent channel or thread)
      if (!data.chatJid) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Missing chatJid',
        });
        break;
      }

      const targetGroup2 =
        registeredGroups[data.chatJid] ||
        registeredGroups[getParentJid(data.chatJid)];
      if (!isMain && (!targetGroup2 || targetGroup2.folder !== sourceGroup)) {
        logger.warn(
          { sourceGroup, chatJid: data.chatJid },
          'Unauthorized read_messages attempt blocked',
        );
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Unauthorized: channel not accessible to this group',
        });
        break;
      }

      const msgs = getThreadMessages(data.chatJid, data.limit || 50);
      logger.info(
        { sourceGroup, chatJid: data.chatJid, count: msgs.length },
        'IPC read_messages query served',
      );
      writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
        status: 'ok',
        chatJid: data.chatJid,
        messages: formatMessagesForIpc(msgs),
      });
      break;
    }

    case 'read_discord': {
      // Read messages from a Discord channel or thread by channel ID.
      // Resolves thread channel IDs via thread_origins table.
      // Cross-group reads allowed — URL-is-authorization model.
      if (!data.channelId) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Missing channelId',
        });
        break;
      }

      // Resolve chat_jid: try direct channel first, then thread_origins
      let chatJid = `dc:${data.channelId}`;
      const threadOrigin = getThreadOrigin(data.channelId);
      if (threadOrigin) {
        chatJid = `${threadOrigin.parent_jid}:thread:${threadOrigin.origin_message_id}`;
      }

      let messages;
      if (data.messageId) {
        // Specific message linked — find it and return context around it.
        // Validate it's a Discord message to prevent cross-platform auth bypass.
        const target = findMessageById(data.messageId);
        if (target && target.chat_jid.startsWith('dc:')) {
          // Use the chat_jid from the found message (most reliable)
          messages = getMessagesAroundTimestamp(
            target.chat_jid,
            target.timestamp,
            data.limit || 50,
          );
          chatJid = target.chat_jid;
        } else {
          // Message not in DB — fall back to latest from the channel
          messages = getThreadMessages(chatJid, data.limit || 50);
        }
      } else {
        messages = getThreadMessages(chatJid, data.limit || 50);
      }

      logger.info(
        {
          sourceGroup,
          chatJid,
          channelId: data.channelId,
          count: messages.length,
        },
        'IPC read_discord query served',
      );
      writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
        status: 'ok',
        chatJid,
        messages: formatMessagesForIpc(messages),
      });
      break;
    }

    case 'read_thread_by_key': {
      // Read thread messages using a thread_key from search_threads results.
      // Resolves the chat_jid by trying each registered parent JID for the group.
      if (!data.threadKey) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Missing threadKey',
        });
        break;
      }

      const meta = getThreadMetadata(data.threadKey);
      if (!meta) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Thread not found in index',
        });
        break;
      }

      // Security: verify the thread belongs to the requesting group
      if (!isMain && meta.group_folder !== sourceGroup) {
        logger.warn(
          { sourceGroup, threadKey: data.threadKey },
          'Unauthorized read_thread_by_key attempt blocked',
        );
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Unauthorized: thread not accessible to this group',
        });
        break;
      }

      // Find the chat_jid by trying each registered parent JID for this group.
      // Thread chat_jids are "{parentJid}:thread:{threadId}" in the messages table.
      const parentJids = Object.entries(registeredGroups)
        .filter(([, g]) => g.folder === meta.group_folder)
        .map(([jid]) => jid);

      let found = false;
      for (const parentJid of parentJids) {
        const chatJid = `${parentJid}:thread:${meta.thread_id}`;
        const msgs = getThreadMessages(chatJid, data.limit || 100);
        if (msgs.length > 0) {
          logger.info(
            { sourceGroup, chatJid, count: msgs.length },
            'IPC read_thread_by_key query served',
          );
          writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
            status: 'ok',
            chatJid,
            threadKey: data.threadKey,
            messages: formatMessagesForIpc(msgs),
          });
          found = true;
          break;
        }
      }

      if (!found) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'ok',
          threadKey: data.threadKey,
          messages: [],
        });
      }
      break;
    }

    case 'list_groups': {
      const groups = Object.entries(registeredGroups).map(([jid, g]) => ({
        jid,
        name: g.name,
        folder: g.folder,
        trigger: g.trigger,
        isMain: g.isMain || false,
        requiresTrigger: g.requiresTrigger,
        // Only expose containerConfig to the group's own entry or main callers
        containerConfig:
          isMain || g.folder === sourceGroup ? g.containerConfig : undefined,
      }));
      logger.info(
        { sourceGroup, count: groups.length },
        'IPC list_groups query served',
      );
      writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
        status: 'ok',
        groups,
      });
      break;
    }

    case 'search_threads': {
      if (!data.query) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Missing query',
        });
        break;
      }

      // Security: scope search to sourceGroup (derived from IPC directory, not payload)
      searchThreads(sourceGroup, data.query, data.limit || 5)
        .then((results) => {
          logger.info(
            { sourceGroup, query: data.query, count: results.length },
            'IPC search_threads query served',
          );
          writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
            status: 'ok',
            results,
          });
        })
        .catch((err) => {
          logger.error({ err, sourceGroup }, 'search_threads query failed');
          writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
            status: 'error',
            error: 'Search failed',
          });
        });
      break;
    }

    case 'list_backlog': {
      const items = getBacklog(sourceGroup, data.status, data.limit || 50);
      logger.info(
        { sourceGroup, count: items.length },
        'IPC list_backlog query served',
      );
      writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
        status: 'ok',
        items,
      });
      break;
    }

    case 'list_ship_log': {
      const entries = getShipLog(sourceGroup, data.limit || 20);
      logger.info(
        { sourceGroup, count: entries.length },
        'IPC list_ship_log query served',
      );
      writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
        status: 'ok',
        entries,
      });
      break;
    }

    case 'get_activity_summary': {
      const sinceHours = data.hours ?? 24;
      const since = new Date(
        Date.now() - sinceHours * 60 * 60 * 1000,
      ).toISOString();
      getActivitySummary(sourceGroup, registeredGroups, since)
        .then((summary) => {
          logger.info(
            {
              sourceGroup,
              shipped: summary.shipped.length,
              teamPRs: summary.teamPRs.length,
              resolved: summary.resolved.length,
            },
            'IPC get_activity_summary query served',
          );
          writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
            status: 'ok',
            ...summary,
          });
        })
        .catch((err) => {
          logger.warn({ sourceGroup, err }, 'Failed to get activity summary');
          writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
            status: 'error',
            error: 'Failed to get activity summary',
          });
        });
      break;
    }

    case 'scan_commits': {
      runCommitDigestForGroup(sourceGroup, registeredGroups)
        .then((result) => {
          logger.info({ sourceGroup, ...result }, 'IPC scan_commits completed');
          writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
            status: 'ok',
            repos: result.repos,
            commits: result.commits,
          });
        })
        .catch((err) => {
          logger.warn({ sourceGroup, err }, 'Failed to scan commits');
          writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
            status: 'error',
            error: 'Failed to scan commits',
          });
        });
      break;
    }

    case 'list_memories': {
      const memories = listMemories(sourceGroup);
      writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
        status: 'ok',
        memories,
      });
      break;
    }

    case 'search_memories': {
      if (!data.query) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Missing query',
        });
        break;
      }
      const limit = data.limit ?? 6;
      const query: string = data.query;
      searchMemoriesSemantic(
        sourceGroup,
        query,
        limit,
        searchMemoriesKeyword,
      ).then((memories) => {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'ok',
          memories,
        });
      });
      break;
    }

    case 'update_plugin': {
      try {
        if (!fs.existsSync(PLUGINS_DIR)) {
          throw new Error(`Plugins directory not found: ${PLUGINS_DIR}`);
        }
        const targetPlugin = data.plugin as string | undefined;
        // Sanitize: reject path traversal attempts
        if (
          targetPlugin &&
          (/[/\\]/.test(targetPlugin) ||
            targetPlugin === '..' ||
            targetPlugin === '.')
        ) {
          throw new Error(`Invalid plugin name: ${targetPlugin}`);
        }
        const results: Record<string, string> = {};
        const entries = targetPlugin
          ? [targetPlugin]
          : fs.readdirSync(PLUGINS_DIR).filter((e) => {
              try {
                return fs.statSync(path.join(PLUGINS_DIR, e)).isDirectory();
              } catch {
                return false;
              }
            });
        for (const entry of entries) {
          const pluginPath = path.join(PLUGINS_DIR, entry);
          if (!fs.existsSync(path.join(pluginPath, '.git'))) continue;
          try {
            results[entry] = execSync('git pull', {
              cwd: pluginPath,
              encoding: 'utf-8',
              timeout: 30_000,
            }).trim();
          } catch (err) {
            results[entry] =
              `error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        logger.info({ sourceGroup, results }, 'Plugins updated via IPC');
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'ok',
          output: JSON.stringify(results, null, 2),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ sourceGroup, error: message }, 'Plugin update failed');
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: message,
        });
      }
      break;
    }

    case 'request_gate': {
      if (!data.label || !data.summary) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Missing label or summary',
        });
        break;
      }
      // Narrow to non-undefined for the async closures below — TypeScript's
      // flow analysis doesn't carry the `!data.label || !data.summary` guard
      // through the IIFE passed to dispatchGateNotification.
      const gateLabel: string = data.label;
      const gateSummary: string = data.summary;
      const gateCommand: string | undefined = data.command;

      let gateChatJid: string | undefined;
      for (const [jid, g] of Object.entries(registeredGroups)) {
        if (g.folder === sourceGroup) {
          gateChatJid = jid;
          break;
        }
      }

      if (!gateChatJid) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'No channel found for group',
        });
        break;
      }

      const gateId = `gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const resolvedChatJid = data.chatJid || gateChatJid;
      // resolvedChatJid may already be thread-scoped (container's
      // NANOCLAW_CHAT_JID for thread-session containers). Don't double the
      // `:thread:` suffix.
      const isAlreadyThreadScoped = parseThreadJid(resolvedChatJid) !== null;
      const threadJid =
        isAlreadyThreadScoped || !data.threadId
          ? resolvedChatJid
          : `${resolvedChatJid}:thread:${data.threadId}`;

      pendingGates.set(gateId, {
        id: gateId,
        chatJid: resolvedChatJid,
        threadJid,
        label: gateLabel,
        command: gateCommand,
        requestId: data.requestId,
        ipcBaseDir,
        sourceGroup,
        createdAt: Date.now(),
        notifiedAt: null,
        postedRef: null,
      });

      // Notify the user. Prefer the channel's interactive (button) path when
      // available — plain-text `approve`/`cancel` is kept as a fallback for
      // channels that don't implement sendInteractiveGate.
      //
      // Fire-and-forget: any failure unblocks the container with an error so
      // the plugin hook doesn't hang forever.
      const commandLine = gateCommand
        ? `\nCommand: \`${gateCommand.slice(0, 200)}\``
        : '';
      const gateTextMsg = `⚠️ **Gate: ${gateLabel}**\n${gateSummary}${commandLine}\n\nReply \`approve\` or \`cancel\`. (A non-approve/cancel reply auto-cancels the gate; the agent will answer but will NOT retry the destructive command — explicitly re-request if you want to proceed.)`;

      // Persist a synthesized text representation of the gate prompt so
      // thread history in messages.db reflects the gate (even on the
      // interactive path where the rendered message is a Block Kit /
      // components payload, not plain text). Uses the same thread-scoped
      // chat_jid that onMessage uses so thread search/resume picks it up.
      const persistGatePrompt = () => {
        try {
          storeMessage({
            id: gateId,
            chat_jid: threadJid,
            sender: 'bot',
            sender_name: 'gate',
            content: gateTextMsg,
            timestamp: new Date().toISOString(),
            is_from_me: true,
            is_bot_message: true,
          });
        } catch (err) {
          logger.warn(
            { gateId, err },
            'Failed to persist gate prompt to messages.db — continuing',
          );
        }
      };

      const dispatchGateNotification = async () => {
        if (deps.sendInteractiveGate) {
          try {
            const sent = await deps.sendInteractiveGate(
              resolvedChatJid,
              {
                gateId,
                label: gateLabel,
                summary: gateSummary,
                command: gateCommand,
              },
              data.threadId,
            );
            if (sent) {
              // sendInteractiveGate implementations call recordGatePostedMessage
              // which sets notifiedAt — nothing more to do here.
              persistGatePrompt();
              return;
            }
            // sent === false means the channel intentionally declined the
            // interactive path. Fall through to the text fallback.
          } catch (err) {
            logger.warn(
              { gateId, sourceGroup, err },
              'sendInteractiveGate threw — falling back to text prompt',
            );
          }
        }
        await deps.sendMessage(
          resolvedChatJid,
          gateTextMsg,
          undefined,
          data.threadId,
        );
        markGateNotified(gateId);
        persistGatePrompt();
      };

      dispatchGateNotification().catch((err: unknown) => {
        logger.error(
          { gateId, sourceGroup, err },
          'Failed to send gate notification — unblocking container with error',
        );
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Failed to send gate notification to channel',
        });
        pendingGates.delete(gateId);
      });

      logger.info(
        { gateId, label: gateLabel, sourceGroup, requestId: data.requestId },
        'Gate created (in-memory) — awaiting user response',
      );
      // Do NOT write a response — the plugin hook polls until the user approves/cancels.
      break;
    }

    case 'create_worktree': {
      if (!data.repo || !data.threadId) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Missing repo or threadId',
        });
        break;
      }
      const cwRepo = data.repo;
      const cwThreadId = data.threadId;
      const cwBranch = data.branch;
      const cwRequestId = data.requestId;

      withGroupMutex(sourceGroup, async () => {
        const groupDir = path.join(GROUPS_DIR, sourceGroup);
        const repoDir = path.resolve(groupDir, cwRepo);

        // MF-3: Path traversal guard — ensure resolved path stays inside groupDir
        if (!repoDir.startsWith(path.resolve(groupDir) + path.sep)) {
          writeQueryResponse(ipcBaseDir, sourceGroup, cwRequestId, {
            status: 'error',
            error: `Invalid repo name: ${cwRepo}`,
          });
          return;
        }

        // Validate repo exists as a git directory in the group folder
        if (
          !fs.existsSync(repoDir) ||
          !fs.existsSync(path.join(repoDir, '.git'))
        ) {
          writeQueryResponse(ipcBaseDir, sourceGroup, cwRequestId, {
            status: 'error',
            error: `Repo not found in group folder: ${cwRepo}`,
          });
          return;
        }

        // Fetch from origin before creating worktree, then resolve HEAD
        try {
          execFileSync('git', ['fetch', 'origin'], {
            cwd: repoDir,
            stdio: 'pipe',
          });
        } catch (err) {
          logger.warn(
            { repoDir, err },
            'create_worktree: git fetch origin failed (continuing)',
          );
        }
        try {
          execFileSync('git', ['remote', 'set-head', 'origin', '--auto'], {
            cwd: repoDir,
            stdio: 'pipe',
          });
        } catch {
          // best-effort: origin/HEAD may already be set or remote may be offline
        }

        // MF-9: Verify origin/HEAD resolves before using it as a ref
        let originHeadResolved = false;
        try {
          execFileSync('git', ['rev-parse', '--verify', 'origin/HEAD'], {
            cwd: repoDir,
            stdio: 'pipe',
          });
          originHeadResolved = true;
        } catch {
          // origin/HEAD not set — will fall back to error if needed
        }

        const worktreeDir = path.join(
          WORKTREES_DIR,
          sourceGroup,
          cwThreadId,
          cwRepo,
        );

        // If worktree already exists, return it as-is (idempotent)
        if (fs.existsSync(worktreeDir)) {
          // MF-7: Verify worktree is not corrupt before returning success
          const wtGitFile = path.join(worktreeDir, '.git');
          if (!fs.existsSync(wtGitFile)) {
            // Corrupt worktree — remove and recreate below
            logger.warn(
              { worktreeDir, sourceGroup },
              'create_worktree: corrupt worktree detected (missing .git), removing',
            );
            try {
              fs.rmSync(worktreeDir, { recursive: true, force: true });
            } catch {
              // best-effort
            }
          } else {
            let worktreeBranch = cwBranch || `thread-${cwThreadId}-${cwRepo}`;
            try {
              worktreeBranch = execFileSync(
                'git',
                ['rev-parse', '--abbrev-ref', 'HEAD'],
                {
                  cwd: worktreeDir,
                  stdio: 'pipe',
                  encoding: 'utf-8',
                },
              ).trim();
            } catch {
              // best-effort
            }
            writeQueryResponse(ipcBaseDir, sourceGroup, cwRequestId, {
              status: 'ok',
              path: worktreeDir,
              branch: worktreeBranch,
            });
            return;
          }
        }

        // Resolve branch name
        const branchName = cwBranch || `thread-${cwThreadId}-${cwRepo}`;

        // MF-1: Validate branch name format before using in git commands
        try {
          execFileSync('git', ['check-ref-format', '--branch', branchName], {
            cwd: repoDir,
            stdio: 'pipe',
          });
        } catch {
          writeQueryResponse(ipcBaseDir, sourceGroup, cwRequestId, {
            status: 'error',
            error: `Invalid branch name: ${branchName}`,
          });
          return;
        }

        // Determine if branch exists locally or on remote (using execFileSync for safety)
        let branchExists = false;
        try {
          execFileSync('git', ['rev-parse', '--verify', branchName], {
            cwd: repoDir,
            stdio: 'pipe',
          });
          branchExists = true;
        } catch {
          // not local — check remote
          try {
            execFileSync(
              'git',
              ['rev-parse', '--verify', `origin/${branchName}`],
              {
                cwd: repoDir,
                stdio: 'pipe',
              },
            );
            branchExists = true;
          } catch {
            // not on remote either
          }
        }

        fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });

        try {
          if (branchExists) {
            // Check out the existing branch
            execFileSync('git', ['worktree', 'add', worktreeDir, branchName], {
              cwd: repoDir,
              stdio: 'pipe',
            });
          } else if (originHeadResolved) {
            // Create new branch from remote default
            execFileSync(
              'git',
              ['worktree', 'add', '-b', branchName, worktreeDir, 'origin/HEAD'],
              { cwd: repoDir, stdio: 'pipe' },
            );
          } else {
            // MF-9: origin/HEAD not available — cannot create branch
            writeQueryResponse(ipcBaseDir, sourceGroup, cwRequestId, {
              status: 'error',
              error:
                'Cannot create worktree: origin/HEAD not resolved (fetch may have failed)',
            });
            // Clean up the parent dir we created
            try {
              fs.rmdirSync(path.dirname(worktreeDir));
            } catch {
              /* ignore */
            }
            return;
          }
          logger.info(
            { repoDir, worktreeDir, branchName, sourceGroup },
            'Worktree created via IPC',
          );
          writeQueryResponse(ipcBaseDir, sourceGroup, cwRequestId, {
            status: 'ok',
            path: worktreeDir,
            branch: branchName,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error(
            { repoDir, worktreeDir, branchName, err },
            'create_worktree: git worktree add failed',
          );
          // Clean up dangling parent dir on failure
          try {
            fs.rmdirSync(path.dirname(worktreeDir));
          } catch {
            /* ignore */
          }
          writeQueryResponse(ipcBaseDir, sourceGroup, cwRequestId, {
            status: 'error',
            error: `git worktree add failed: ${message}`,
          });
        }
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ sourceGroup, err }, 'create_worktree: mutex error');
        writeQueryResponse(ipcBaseDir, sourceGroup, cwRequestId, {
          status: 'error',
          error: message,
        });
      });
      break;
    }

    case 'clone_repo': {
      if (!data.url) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Missing url',
        });
        break;
      }
      const crUrl = data.url;
      const crRequestId = data.requestId;

      // Validate it's a GitHub URL
      let crParsedUrl: URL;
      try {
        crParsedUrl = new URL(crUrl);
      } catch {
        writeQueryResponse(ipcBaseDir, sourceGroup, crRequestId, {
          status: 'error',
          error: `Invalid URL: ${crUrl}`,
        });
        break;
      }
      if (crParsedUrl.hostname !== 'github.com') {
        writeQueryResponse(ipcBaseDir, sourceGroup, crRequestId, {
          status: 'error',
          error: 'Only GitHub URLs are allowed',
        });
        break;
      }

      // Derive org from URL path (github.com/<org>/<repo>)
      const urlParts = crParsedUrl.pathname
        .replace(/^\//, '')
        .replace(/\.git$/, '')
        .split('/');
      if (urlParts.length < 2) {
        writeQueryResponse(ipcBaseDir, sourceGroup, crRequestId, {
          status: 'error',
          error: 'Cannot derive org from URL',
        });
        break;
      }
      const crOrg = urlParts[0].toLowerCase();
      const crRepoName = data.name || urlParts[1];

      // Validate repo name (no path traversal)
      if (
        /[/\\]/.test(crRepoName) ||
        crRepoName.includes('..') ||
        crRepoName === '.'
      ) {
        writeQueryResponse(ipcBaseDir, sourceGroup, crRequestId, {
          status: 'error',
          error: `Invalid repo name: ${crRepoName}`,
        });
        break;
      }

      const groupDir = path.join(GROUPS_DIR, sourceGroup);

      // Derive allowed org from existing repos in group folder
      let allowedOrg: string | null = null;
      try {
        for (const entry of fs.readdirSync(groupDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const repoPath = path.join(groupDir, entry.name);
          if (!fs.existsSync(path.join(repoPath, '.git'))) continue;
          try {
            const remoteUrl = execSync('git remote get-url origin', {
              cwd: repoPath,
              stdio: 'pipe',
              encoding: 'utf-8',
            }).trim();
            const remoteMatch = remoteUrl.match(/github\.com[:/]([^/]+)\//);
            if (remoteMatch) {
              allowedOrg = remoteMatch[1].toLowerCase();
              break;
            }
          } catch {
            // no remote — skip
          }
        }
      } catch {
        // best-effort
      }

      if (allowedOrg !== null && crOrg !== allowedOrg) {
        writeQueryResponse(ipcBaseDir, sourceGroup, crRequestId, {
          status: 'error',
          error: `Org mismatch: expected ${allowedOrg}, got ${crOrg}`,
        });
        break;
      }

      withGroupMutex(sourceGroup, async () => {
        const destDir = path.join(groupDir, crRepoName);

        // Idempotent: repo already exists
        if (fs.existsSync(destDir)) {
          logger.info(
            { destDir, sourceGroup },
            'clone_repo: repo already exists (idempotent)',
          );
          writeQueryResponse(ipcBaseDir, sourceGroup, crRequestId, {
            status: 'ok',
            path: destDir,
            name: crRepoName,
          });
          return;
        }

        try {
          execFileSync('git', ['clone', crUrl, destDir], {
            stdio: 'pipe',
            timeout: 120_000,
          });
          logger.info({ destDir, crUrl, sourceGroup }, 'Repo cloned via IPC');
          writeQueryResponse(ipcBaseDir, sourceGroup, crRequestId, {
            status: 'ok',
            path: destDir,
            name: crRepoName,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.error({ crUrl, destDir, err }, 'clone_repo: git clone failed');
          writeQueryResponse(ipcBaseDir, sourceGroup, crRequestId, {
            status: 'error',
            error: `git clone failed: ${message}`,
          });
        }
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ sourceGroup, err }, 'clone_repo: mutex error');
        writeQueryResponse(ipcBaseDir, sourceGroup, crRequestId, {
          status: 'error',
          error: message,
        });
      });
      break;
    }

    case 'git_commit': {
      if (!data.repo || !data.threadId || !data.message) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Missing repo, threadId, or message',
        });
        break;
      }
      const gcRepo = data.repo;
      const gcThreadId = data.threadId;
      const gcMessage = data.message;
      const gcRequestId = data.requestId;

      withGroupMutex(sourceGroup, async () => {
        const worktreeDir = path.join(
          WORKTREES_DIR,
          sourceGroup,
          gcThreadId,
          gcRepo,
        );
        if (
          !fs.existsSync(worktreeDir) ||
          !fs.existsSync(path.join(worktreeDir, '.git'))
        ) {
          writeQueryResponse(ipcBaseDir, sourceGroup, gcRequestId, {
            status: 'error',
            error: `Worktree not found: ${gcRepo}`,
          });
          return;
        }

        // Remove stale index.lock if present
        const lockFile = path.join(worktreeDir, '.git', 'index.lock');
        try {
          fs.unlinkSync(lockFile);
        } catch {
          /* ignore */
        }

        try {
          execFileSync('git', ['add', '-A'], {
            cwd: worktreeDir,
            stdio: 'pipe',
          });
          execFileSync(
            'git',
            [
              '-c',
              'user.email=agent@nanoclaw.local',
              '-c',
              'user.name=agent',
              'commit',
              '--no-verify',
              '-m',
              gcMessage,
            ],
            { cwd: worktreeDir, stdio: 'pipe' },
          );
          const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: worktreeDir,
            stdio: 'pipe',
            encoding: 'utf-8',
          }).trim();
          writeQueryResponse(ipcBaseDir, sourceGroup, gcRequestId, {
            status: 'ok',
            sha,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeQueryResponse(ipcBaseDir, sourceGroup, gcRequestId, {
            status: 'error',
            error: `git commit failed: ${message}`,
          });
        }
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ sourceGroup, err }, 'git_commit: mutex error');
        writeQueryResponse(ipcBaseDir, sourceGroup, gcRequestId, {
          status: 'error',
          error: message,
        });
      });
      break;
    }

    case 'git_push': {
      if (!data.repo || !data.threadId) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Missing repo or threadId',
        });
        break;
      }
      const gpRepo = data.repo;
      const gpThreadId = data.threadId;
      const gpRequestId = data.requestId;

      withGroupMutex(sourceGroup, async () => {
        const worktreeDir = path.join(
          WORKTREES_DIR,
          sourceGroup,
          gpThreadId,
          gpRepo,
        );
        if (
          !fs.existsSync(worktreeDir) ||
          !fs.existsSync(path.join(worktreeDir, '.git'))
        ) {
          writeQueryResponse(ipcBaseDir, sourceGroup, gpRequestId, {
            status: 'error',
            error: `Worktree not found: ${gpRepo}`,
          });
          return;
        }

        try {
          const branch = execFileSync(
            'git',
            ['rev-parse', '--abbrev-ref', 'HEAD'],
            {
              cwd: worktreeDir,
              stdio: 'pipe',
              encoding: 'utf-8',
            },
          ).trim();
          execFileSync('git', ['push', '-u', 'origin', branch], {
            cwd: worktreeDir,
            stdio: 'pipe',
            timeout: 60_000,
          });
          writeQueryResponse(ipcBaseDir, sourceGroup, gpRequestId, {
            status: 'ok',
            branch,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeQueryResponse(ipcBaseDir, sourceGroup, gpRequestId, {
            status: 'error',
            error: `git push failed: ${message}`,
          });
        }
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ sourceGroup, err }, 'git_push: mutex error');
        writeQueryResponse(ipcBaseDir, sourceGroup, gpRequestId, {
          status: 'error',
          error: message,
        });
      });
      break;
    }

    case 'open_pr': {
      if (!data.repo || !data.threadId || !data.title) {
        writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
          status: 'error',
          error: 'Missing repo, threadId, or title',
        });
        break;
      }
      const prRepo = data.repo;
      const prThreadId = data.threadId;
      const prTitle = data.title;
      const prBody = data.body || '';
      const prRequestId = data.requestId;

      withGroupMutex(sourceGroup, async () => {
        const worktreeDir = path.join(
          WORKTREES_DIR,
          sourceGroup,
          prThreadId,
          prRepo,
        );
        if (
          !fs.existsSync(worktreeDir) ||
          !fs.existsSync(path.join(worktreeDir, '.git'))
        ) {
          writeQueryResponse(ipcBaseDir, sourceGroup, prRequestId, {
            status: 'error',
            error: `Worktree not found: ${prRepo}`,
          });
          return;
        }

        try {
          const result = execFileSync(
            'gh',
            ['pr', 'create', '--title', prTitle, '--body', prBody],
            {
              cwd: worktreeDir,
              stdio: 'pipe',
              encoding: 'utf-8',
              timeout: 30_000,
            },
          ).trim();
          // gh pr create returns the PR URL
          writeQueryResponse(ipcBaseDir, sourceGroup, prRequestId, {
            status: 'ok',
            url: result,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeQueryResponse(ipcBaseDir, sourceGroup, prRequestId, {
            status: 'error',
            error: `gh pr create failed: ${message}`,
          });
        }
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ sourceGroup, err }, 'open_pr: mutex error');
        writeQueryResponse(ipcBaseDir, sourceGroup, prRequestId, {
          status: 'error',
          error: message,
        });
      });
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC query type');
      writeQueryResponse(ipcBaseDir, sourceGroup, data.requestId, {
        status: 'error',
        error: `Unknown query type: ${data.type}`,
      });
  }
}
