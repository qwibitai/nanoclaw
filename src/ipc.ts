import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import {
  DATA_DIR,
  GROUPS_DIR,
  FILE_SEND_ALLOWLIST,
  IPC_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { AvailableGroup } from './container-runner.js';
import {
  createTask,
  createThreadContext,
  deleteTask,
  getAllTasks,
  getTaskById,
  updateTask,
} from './db.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

/** Parse numeric thread context ID from "ctx-{id}" format, or undefined. */
function parseCtxId(threadId: string | undefined): number | undefined {
  if (!threadId?.startsWith('ctx-')) return undefined;
  const n = parseInt(threadId.slice(4), 10);
  return Number.isFinite(n) ? n : undefined;
}

export interface IpcDeps {
  sendMessage: (
    jid: string,
    text: string,
    threadContextId?: number,
  ) => Promise<void>;
  sendChannelMessage: (
    jid: string,
    text: string,
  ) => Promise<string | undefined>;
  sendFile: (
    jid: string,
    files: Array<{ path: string; name: string }>,
    caption?: string,
    threadContextId?: number,
  ) => Promise<void>;
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
  /** Optional: handle debug queries from external tools (e.g., /ask-agent skill) */
  onDebugQuery?: (
    sourceGroup: string,
    queryId: string,
    question: string,
  ) => void;
  /** Optional: escalate a container to goal priority */
  onEscalateToGoal?: (groupFolder: string, threadId: string) => void;
  /** Optional: container confirmed it has paused */
  onContainerPaused?: (groupFolder: string, threadId: string) => void;
  /** Optional: container confirmed it has resumed */
  onContainerResumed?: (groupFolder: string, threadId: string) => void;
}

type ExternalIpcHandler = (
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  deps: IpcDeps,
) => Promise<void>;

const externalIpcHandlers = new Map<string, ExternalIpcHandler>();

export function registerIpcHandler(
  type: string,
  handler: ExternalIpcHandler,
): void {
  externalIpcHandlers.set(type, handler);
}

/**
 * Resolve a container path to a host path.
 * Container /workspace/group/ → groups/{folder}/
 * Container /workspace/ipc/  → data/ipc/{folder}/
 * Returns null if the path is outside allowed mounts.
 */
function resolveContainerPath(
  containerPath: string,
  groupFolder: string,
): string | null {
  // Normalize and prevent path traversal
  const normalized = path.normalize(containerPath);
  if (normalized.includes('..')) return null;

  // Map known container mount prefixes to host paths.
  // The agent may use various absolute paths depending on where it writes:
  //   /workspace/group/  → groups/{folder}/     (primary working dir)
  //   /workspace/ipc/    → data/ipc/{folder}/   (IPC directory)
  const prefixMap: Array<[string, string]> = [
    ['/workspace/group/', path.join(GROUPS_DIR, groupFolder) + '/'],
    ['/workspace/ipc/', path.join(DATA_DIR, 'ipc', groupFolder) + '/'],
  ];

  for (const [prefix, hostBase] of prefixMap) {
    if (normalized.startsWith(prefix)) {
      const relative = normalized.slice(prefix.length);
      const result = path.join(hostBase, relative);
      logger.debug(
        { containerPath, hostPath: result, prefix, groupFolder },
        'resolveContainerPath: resolved',
      );
      return result;
    }
  }

  // Fallback: if the file is just a basename or relative path, resolve
  // it under the group directory (the container's CWD is /workspace/group/)
  if (!normalized.startsWith('/')) {
    return path.join(GROUPS_DIR, groupFolder, normalized);
  }

  // For any other absolute path in the container, check if the file
  // physically exists at the group mount (the container might report
  // paths like /home/node/workspace/foo which are really /workspace/group/foo)
  const basename = path.basename(normalized);
  const groupPath = path.join(GROUPS_DIR, groupFolder, basename);
  if (fs.existsSync(groupPath)) {
    return groupPath;
  }

  logger.warn(
    {
      containerPath,
      normalized,
      groupFolder,
      checkedPrefixes: prefixMap.map(([prefix]) => prefix),
    },
    'resolveContainerPath: no matching prefix for container path',
  );
  return null;
}

const KNOWN_IPC_SUBDIRS = new Set([
  'messages',
  'tasks',
  'files',
  'prs',
  'input',
  'debug',
  'queue',
]);

function getIpcDirsForGroup(
  groupIpcDir: string,
): Array<{ basePath: string; threadId?: string }> {
  const dirs: Array<{ basePath: string; threadId?: string }> = [];

  // Legacy flat structure (non-threaded)
  dirs.push({ basePath: groupIpcDir });

  // Thread subdirectories
  try {
    const entries = fs.readdirSync(groupIpcDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !KNOWN_IPC_SUBDIRS.has(entry.name)) {
        dirs.push({
          basePath: path.join(groupIpcDir, entry.name),
          threadId: entry.name,
        });
      }
    }
  } catch {
    /* dir may not exist yet */
  }

  return dirs;
}

function archiveIpcFile(
  filePath: string,
  ipcBaseDir: string,
  sourceGroup: string,
): void {
  const auditDir = path.join(ipcBaseDir, sourceGroup, 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  const dest = path.join(auditDir, `${Date.now()}-${path.basename(filePath)}`);
  try {
    fs.renameSync(filePath, dest);
  } catch {
    // Cross-device move fallback
    fs.copyFileSync(filePath, dest);
    fs.unlinkSync(filePath);
  }
}

function cleanupAuditFiles(ipcBaseDir: string): void {
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  try {
    for (const group of fs.readdirSync(ipcBaseDir)) {
      const auditDir = path.join(ipcBaseDir, group, 'audit');
      let files: string[];
      try {
        files = fs.readdirSync(auditDir);
      } catch {
        continue;
      }
      for (const file of files) {
        const filePath = path.join(auditDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > maxAge) {
            fs.unlinkSync(filePath);
          }
        } catch {
          /* file may have been removed concurrently */
        }
      }
    }
  } catch {
    /* best effort */
  }
}

/**
 * Handle an IPC message (type: 'message').
 * Extracted from the messages/ directory scanning block.
 */
async function handleIpcMessage(
  data: Record<string, unknown>,
  sourceGroup: string,
  threadId: string | undefined,
  isMain: boolean,
  deps: IpcDeps,
  registeredGroups: Record<string, RegisteredGroup>,
): Promise<void> {
  if (!(data.type === 'message' && data.chatJid && data.text)) return;

  const targetGroup = registeredGroups[data.chatJid as string];
  if (isMain || (targetGroup && targetGroup.folder === sourceGroup)) {
    // Scheduled task send_message calls always go to main channel, never a thread
    if (data.isScheduled === 'true') {
      const messageId = await deps.sendChannelMessage(
        data.chatJid as string,
        data.text as string,
      );
      // Create thread context so Discord replies to this message are recognized
      if (messageId) {
        createThreadContext({
          chatJid: data.chatJid as string,
          threadId: null,
          sessionId: null,
          originMessageId: messageId,
          source: 'scheduled_task',
        });
      }
    } else {
      await deps.sendMessage(
        data.chatJid as string,
        data.text as string,
        parseCtxId(threadId),
      );
    }
    logger.info(
      { chatJid: data.chatJid, sourceGroup, threadId },
      'IPC message sent',
    );
  } else {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup },
      'Unauthorized IPC message attempt blocked',
    );
  }
}

/**
 * Handle an IPC file-send request (type: 'send_files').
 * Extracted from the files/ directory scanning block.
 */
async function handleIpcFiles(
  data: Record<string, unknown>,
  sourceGroup: string,
  threadId: string | undefined,
  isMain: boolean,
  ipcBaseDir: string,
  basePath: string,
  deps: IpcDeps,
  registeredGroups: Record<string, RegisteredGroup>,
): Promise<void> {
  if (
    !(
      data.type === 'send_files' &&
      data.chatJid &&
      Array.isArray(data.files) &&
      (data.files as unknown[]).length > 0
    )
  )
    return;

  // Authorization: same as messages
  const targetGroup = registeredGroups[data.chatJid as string];
  if (!isMain && (!targetGroup || targetGroup.folder !== sourceGroup)) {
    logger.warn(
      { chatJid: data.chatJid, sourceGroup, threadId },
      'Unauthorized file send attempt blocked',
    );
    return;
  }

  // Resolve and validate each file
  const resolvedFiles: Array<{ path: string; name: string }> = [];
  let valid = true;
  for (const f of data.files as Array<{ path: string; name?: string }>) {
    // For /workspace/ipc/ paths, resolve relative to the
    // current basePath (which includes the thread subdirectory).
    // resolveContainerPath maps /workspace/ipc/ to the group-
    // level IPC dir, but threaded containers mount a thread-
    // specific subdirectory as /workspace/ipc/.
    let hostPath: string | null;
    const normalized = path.normalize(f.path);
    if (normalized.startsWith('/workspace/ipc/')) {
      const relative = normalized.slice('/workspace/ipc/'.length);
      hostPath = path.join(basePath, relative);
    } else {
      hostPath = resolveContainerPath(f.path, sourceGroup);
    }
    if (!hostPath) {
      logger.warn(
        { containerPath: f.path, sourceGroup, threadId, basePath },
        'File send rejected: path outside allowed mounts',
      );
      valid = false;
      break;
    }
    const ext = path.extname(f.name || f.path).toLowerCase();
    if (!FILE_SEND_ALLOWLIST.includes(ext)) {
      logger.warn(
        { ext, sourceGroup, threadId, containerPath: f.path, fileName: f.name },
        'File send rejected: extension not in allowlist',
      );
      valid = false;
      break;
    }
    if (!fs.existsSync(hostPath)) {
      logger.warn(
        { hostPath, containerPath: f.path, sourceGroup, threadId, basePath },
        'File send rejected: file not found',
      );
      valid = false;
      break;
    }
    const stat = fs.statSync(hostPath);
    if (stat.size > 25 * 1024 * 1024) {
      logger.warn(
        { hostPath, size: stat.size, sourceGroup, threadId },
        'File send rejected: exceeds 25MB limit',
      );
      valid = false;
      break;
    }
    resolvedFiles.push({
      path: hostPath,
      name: f.name || path.basename(f.path),
    });
  }

  if (valid && resolvedFiles.length > 0) {
    await deps.sendFile(
      data.chatJid as string,
      resolvedFiles,
      data.caption as string | undefined,
      parseCtxId(threadId),
    );
    logger.info(
      {
        chatJid: data.chatJid,
        sourceGroup,
        threadId,
        fileCount: resolvedFiles.length,
      },
      'IPC files sent',
    );
  }
}

/**
 * Unified dispatcher for IPC queue files.
 * Routes a parsed JSON payload to the appropriate handler based on its type.
 */
async function processQueueFile(
  data: Record<string, unknown>,
  sourceGroup: string,
  threadId: string | undefined,
  isMain: boolean,
  ipcBaseDir: string,
  basePath: string,
  deps: IpcDeps,
  registeredGroups: Record<string, RegisteredGroup>,
): Promise<void> {
  // Skip non-IPC files (e.g. current_tasks.json, available_groups.json)
  if (Array.isArray(data) || typeof data.type !== 'string') return;

  switch (data.type) {
    case 'message':
      await handleIpcMessage(
        data,
        sourceGroup,
        threadId,
        isMain,
        deps,
        registeredGroups,
      );
      break;
    case 'send_files':
      await handleIpcFiles(
        data,
        sourceGroup,
        threadId,
        isMain,
        ipcBaseDir,
        basePath,
        deps,
        registeredGroups,
      );
      break;
    case 'list_tasks': {
      // Sanitize requestId to prevent path traversal (defense-in-depth)
      const requestId = ((data.requestId as string) || '').replace(
        /[^a-zA-Z0-9_-]/g,
        '',
      );
      if (!requestId) break;

      const allTasks = getAllTasks();
      const filtered = isMain
        ? allTasks
        : allTasks.filter((t) => t.group_folder === sourceGroup);

      const response = filtered.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));

      const inputDir = path.join(basePath, 'input');
      fs.mkdirSync(inputDir, { recursive: true });
      const responseFile = path.join(inputDir, `list_tasks-${requestId}.json`);
      const tempFile = `${responseFile}.tmp`;
      fs.writeFileSync(tempFile, JSON.stringify(response));
      fs.renameSync(tempFile, responseFile);
      break;
    }
    case 'schedule_task':
    case 'pause_task':
    case 'resume_task':
    case 'cancel_task':
    case 'update_task':
    case 'refresh_groups':
    case 'register_group':
    case 'debug_query':
      if (!threadId)
        await processTaskIpc(
          data as Parameters<typeof processTaskIpc>[0],
          sourceGroup,
          isMain,
          deps,
        );
      break;
    case 'escalate_to_goal':
      if (deps.onEscalateToGoal && data.groupFolder) {
        deps.onEscalateToGoal(sourceGroup, threadId || 'default');
        logger.info({ sourceGroup, threadId }, 'goal.escalated via IPC');
      }
      break;
    case 'paused':
      if (deps.onContainerPaused) {
        deps.onContainerPaused(sourceGroup, threadId || 'default');
      }
      break;
    case 'resumed':
      if (deps.onContainerResumed) {
        deps.onContainerResumed(sourceGroup, threadId || 'default');
      }
      break;
    default: {
      const externalHandler = externalIpcHandlers.get(data.type as string);
      if (externalHandler) {
        await externalHandler(data, sourceGroup, isMain, deps);
      } else {
        logger.warn(
          {
            type: data.type,
            sourceGroup,
            threadId,
            keys: Object.keys(data).join(','),
          },
          'Unknown IPC message type',
        );
      }
    }
  }
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

  let auditCleanupCounter = 0;

  const processIpcFiles = async () => {
    // Clean up old audit files every ~100 cycles
    if (++auditCleanupCounter >= 100) {
      auditCleanupCounter = 0;
      cleanupAuditFiles(ipcBaseDir);
    }

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
      const groupIpcDir = path.join(ipcBaseDir, sourceGroup);

      for (const { basePath, threadId } of getIpcDirsForGroup(groupIpcDir)) {
        // --- Unified queue/ directory (preferred) ---
        const queueDir = path.join(basePath, 'queue');
        try {
          if (fs.existsSync(queueDir)) {
            const files = fs
              .readdirSync(queueDir)
              .filter((f) => f.endsWith('.json'));
            for (const file of files) {
              const filePath = path.join(queueDir, file);
              try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                await processQueueFile(
                  data,
                  sourceGroup,
                  threadId,
                  isMain,
                  ipcBaseDir,
                  basePath,
                  deps,
                  registeredGroups,
                );
                fs.unlinkSync(filePath);
              } catch (err) {
                logger.error(
                  { file, sourceGroup, threadId, err },
                  'Error processing IPC queue file',
                );
                archiveIpcFile(filePath, ipcBaseDir, sourceGroup);
              }
            }
          }
        } catch (err) {
          logger.error(
            { err, sourceGroup, threadId },
            'Error reading IPC queue directory',
          );
        }

        // --- Legacy messages/ directory (deprecated, use queue/) ---
        const messagesDir = path.join(basePath, 'messages');
        try {
          if (fs.existsSync(messagesDir)) {
            const messageFiles = fs
              .readdirSync(messagesDir)
              .filter((f) => f.endsWith('.json'));
            if (messageFiles.length > 0) {
              logger.warn(
                { sourceGroup, dir: 'messages' },
                'IPC file found in deprecated directory, migrate to queue/',
              );
            }
            for (const file of messageFiles) {
              const filePath = path.join(messagesDir, file);
              try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                await handleIpcMessage(
                  data,
                  sourceGroup,
                  threadId,
                  isMain,
                  deps,
                  registeredGroups,
                );
                fs.unlinkSync(filePath);
              } catch (err) {
                logger.error(
                  { file, sourceGroup, threadId, err },
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
            { err, sourceGroup, threadId },
            'Error reading IPC messages directory',
          );
        }

        // --- Legacy tasks/ directory (deprecated, use queue/) ---
        if (!threadId) {
          const tasksDir = path.join(basePath, 'tasks');
          try {
            if (fs.existsSync(tasksDir)) {
              const taskFiles = fs
                .readdirSync(tasksDir)
                .filter((f) => f.endsWith('.json'));
              if (taskFiles.length > 0) {
                logger.warn(
                  { sourceGroup, dir: 'tasks' },
                  'IPC file found in deprecated directory, migrate to queue/',
                );
              }
              for (const file of taskFiles) {
                const filePath = path.join(tasksDir, file);
                try {
                  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
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
            logger.error(
              { err, sourceGroup },
              'Error reading IPC tasks directory',
            );
          }
        }

        // --- Legacy files/ directory (deprecated, use queue/) ---
        const filesDir = path.join(basePath, 'files');
        try {
          if (fs.existsSync(filesDir)) {
            const fileManifests = fs
              .readdirSync(filesDir)
              .filter((f) => f.endsWith('.json'));
            if (fileManifests.length > 0) {
              logger.warn(
                { sourceGroup, dir: 'files' },
                'IPC file found in deprecated directory, migrate to queue/',
              );
            }
            for (const file of fileManifests) {
              const filePath = path.join(filesDir, file);
              try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                await handleIpcFiles(
                  data,
                  sourceGroup,
                  threadId,
                  isMain,
                  ipcBaseDir,
                  basePath,
                  deps,
                  registeredGroups,
                );
                archiveIpcFile(filePath, ipcBaseDir, sourceGroup);
              } catch (err) {
                logger.error(
                  { file, sourceGroup, threadId, err },
                  'Error processing IPC file send',
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
            { err, sourceGroup, threadId },
            'Error reading IPC files directory',
          );
        }
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
    // For debug_query
    queryId?: string;
    question?: string;
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
        // Defense in depth: agent cannot set isMain via IPC
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'debug_query':
      if (data.queryId && data.question && deps.onDebugQuery) {
        deps.onDebugQuery(sourceGroup, data.queryId, data.question);
        logger.info(
          { sourceGroup, queryId: data.queryId },
          'Debug query forwarded via IPC',
        );
      } else if (!deps.onDebugQuery) {
        logger.warn(
          { sourceGroup },
          'Debug query received but no handler registered',
        );
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
