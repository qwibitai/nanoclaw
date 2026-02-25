import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from './config.js';
import { WhatsAppChannel } from './channels/whatsapp.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
  writeWorkerRunsSnapshot,
  WorkerRunsSnapshot,
} from './container-runner.js';
import { cleanupOrphans, ensureContainerRuntimeRunning } from './container-runtime.js';
import {
  completeWorkerRun,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getWorkerRuns,
  getWorkerRun,
  getRouterState,
  initDatabase,
  insertWorkerRun,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  updateWorkerRunCompletion,
  updateWorkerRunStatus,
} from './db.js';
import {
  parseCompletionContract,
  parseDispatchPayload,
  validateDispatchPayload,
  validateCompletionContract,
} from './dispatch-validator.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let whatsapp: WhatsAppChannel;
const channels: Channel[] = [];
const queue = new GroupQueue();
const ANDY_DEVELOPER_FOLDER = 'andy-developer';
const ACTIVE_WORKER_RUN_STATUSES = ['queued', 'running', 'review_requested'] as const;

interface WorkerRunContext {
  runId: string;
  requiredFields: string[];
  browserEvidenceRequired?: boolean;
}

function isJarvisWorkerGroup(folder: string): boolean {
  return folder.startsWith('jarvis-worker');
}

function isSyntheticWorkerGroup(group: RegisteredGroup): boolean {
  return isJarvisWorkerGroup(group.folder);
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function sanitizeUserFacingOutput(group: RegisteredGroup, text: string): string {
  if (group.folder !== ANDY_DEVELOPER_FOLDER) return text;

  const parsed = parseDispatchPayload(stripCodeFence(text));
  if (!parsed) return text;

  return `Dispatched \`${parsed.run_id}\` to \`${parsed.repo}\` on \`${parsed.branch}\` (${parsed.task_type}).`;
}

function buildWorkerRunsSnapshot(group: RegisteredGroup, isMain: boolean): WorkerRunsSnapshot {
  let scope: WorkerRunsSnapshot['scope'] = 'group';
  let groupFolderLike: string | undefined;

  if (isMain) {
    scope = 'all';
  } else if (group.folder === ANDY_DEVELOPER_FOLDER) {
    scope = 'jarvis';
    groupFolderLike = 'jarvis-worker-%';
  } else if (isSyntheticWorkerGroup(group)) {
    scope = 'group';
    groupFolderLike = group.folder;
  } else {
    scope = 'group';
    groupFolderLike = group.folder;
  }

  const active = getWorkerRuns({
    groupFolderLike,
    statuses: [...ACTIVE_WORKER_RUN_STATUSES],
    limit: 25,
  }).map((r) => ({
    run_id: r.run_id,
    group_folder: r.group_folder,
    status: r.status,
    started_at: r.started_at,
    completed_at: r.completed_at,
    retry_count: r.retry_count,
    result_summary: r.result_summary,
    error_details: r.error_details,
  }));

  const recent = getWorkerRuns({
    groupFolderLike,
    limit: 25,
  }).map((r) => ({
    run_id: r.run_id,
    group_folder: r.group_folder,
    status: r.status,
    started_at: r.started_at,
    completed_at: r.completed_at,
    retry_count: r.retry_count,
    result_summary: r.result_summary,
    error_details: r.error_details,
  }));

  return {
    generated_at: new Date().toISOString(),
    scope,
    active,
    recent,
  };
}

function buildAndyPromptWorkerContext(snapshot: WorkerRunsSnapshot): string {
  const activeLines = snapshot.active.length > 0
    ? snapshot.active
      .slice(0, 8)
      .map((r) => `- ${r.run_id} | ${r.group_folder} | ${r.status} | started ${r.started_at}`)
      .join('\n')
    : '- none';

  const recentLines = snapshot.recent.length > 0
    ? snapshot.recent
      .slice(0, 8)
      .map((r) => {
        const when = r.completed_at ?? r.started_at;
        const summary = r.result_summary || r.error_details || '-';
        return `- ${r.run_id} | ${r.group_folder} | ${r.status} | ${when} | ${summary}`;
      })
      .join('\n')
    : '- none';

  return [
    '<worker_status_source_of_truth>',
    `generated_at: ${snapshot.generated_at}`,
    'Use this DB snapshot as the single source of truth when answering status/queue questions.',
    'Do not rely on memory for queued/running/completed worker state.',
    'Active worker runs:',
    activeLines,
    'Recent worker runs:',
    recentLines,
    '</worker_status_source_of_truth>',
  ].join('\n');
}

function extractWorkerRunContext(
  group: RegisteredGroup,
  messages: NewMessage[],
): WorkerRunContext | null {
  if (!isJarvisWorkerGroup(group.folder)) return null;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const payload = parseDispatchPayload(messages[i].content);
    if (!payload) continue;
    const validity = validateDispatchPayload(payload);
    if (!validity.valid) continue;
    return {
      runId: payload.run_id,
      requiredFields: payload.output_contract.required_fields,
      browserEvidenceRequired: payload.output_contract.browser_evidence_required,
    };
  }

  return null;
}

function isActiveOrTerminalWorkerStatus(status: string): boolean {
  return status === 'running' || status === 'review_requested' || status === 'done';
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  const syntheticWorker = isSyntheticWorkerGroup(group);
  if (!channel && !syntheticWorker) {
    console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const prompt = formatMessages(missedMessages);
  const workerRun = extractWorkerRunContext(group, missedMessages);
  let workerOutputBuffer = '';

  if (workerRun) {
    const existingRun = getWorkerRun(workerRun.runId);
    if (existingRun && isActiveOrTerminalWorkerStatus(existingRun.status)) {
      lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
      saveState();
      logger.warn(
        {
          runId: workerRun.runId,
          status: existingRun.status,
          group: group.name,
        },
        'Skipping duplicate worker run execution',
      );
      return true;
    }

    if (!existingRun || existingRun.status === 'failed' || existingRun.status === 'failed_contract') {
      const insertState = insertWorkerRun(workerRun.runId, group.folder);
      if (insertState === 'duplicate') {
        lastAgentTimestamp[chatJid] =
          missedMessages[missedMessages.length - 1].timestamp;
        saveState();
        logger.warn(
          { runId: workerRun.runId, group: group.name },
          'Duplicate worker run blocked before execution',
        );
        return true;
      }
      logger.info(
        { runId: workerRun.runId, queueState: insertState, group: group.name },
        'Worker run queued from worker chat context',
      );
    }

    updateWorkerRunStatus(workerRun.runId, 'running');
  }

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel?.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      if (workerRun) {
        workerOutputBuffer += `${raw}\n`;
      }
      // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        const outboundText = sanitizeUserFacingOutput(group, text);
        if (outboundText && channel) {
          await channel.sendMessage(chatJid, outboundText);
          outputSentToUser = true;
        }
      }
      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel?.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (workerRun) {
    const completion = parseCompletionContract(workerOutputBuffer);
    const completionCheck = validateCompletionContract(completion, {
      expectedRunId: workerRun.runId,
      requiredFields: workerRun.requiredFields,
      browserEvidenceRequired: workerRun.browserEvidenceRequired,
    });

    if (completion && completionCheck.valid) {
      updateWorkerRunCompletion(workerRun.runId, {
        branch_name: completion.branch,
        pr_url: completion.pr_url,
        commit_sha: completion.commit_sha,
        files_changed: completion.files_changed,
        test_summary: completion.test_result,
        risk_summary: completion.risk,
      });
      updateWorkerRunStatus(workerRun.runId, 'review_requested');
      logger.info(
        { runId: workerRun.runId, group: group.name },
        'Worker completion contract accepted',
      );
    } else if (output === 'error' || hadError) {
      const missingSummary = completionCheck.missing.join(', ');
      completeWorkerRun(
        workerRun.runId,
        'failed',
        missingSummary
          ? `Worker execution failed; missing: ${missingSummary}`
          : 'worker execution failed',
        JSON.stringify({
          reason: 'worker execution failed',
          missing: completionCheck.missing,
          output_status: output,
          had_error: hadError,
          output_excerpt: workerOutputBuffer.slice(0, 2000),
        }),
      );
      logger.warn(
        {
          runId: workerRun.runId,
          group: group.name,
          missing: completionCheck.missing,
        },
        'Worker run marked failed',
      );
    } else {
      const missingSummary = completionCheck.missing.join(', ');
      completeWorkerRun(
        workerRun.runId,
        'failed_contract',
        missingSummary
          ? `Completion contract missing: ${missingSummary}`
          : 'invalid completion contract',
        JSON.stringify({
          reason: 'invalid completion contract',
          missing: completionCheck.missing,
          output_excerpt: workerOutputBuffer.slice(0, 2000),
        }),
      );
      logger.warn(
        {
          runId: workerRun.runId,
          group: group.name,
          missing: completionCheck.missing,
        },
        'Worker run marked failed_contract',
      );
    }
  }

  if (output === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  const workerRunsSnapshot = buildWorkerRunsSnapshot(group, isMain);
  writeWorkerRunsSnapshot(group.folder, workerRunsSnapshot);
  const effectivePrompt = group.folder === ANDY_DEVELOPER_FOLDER
    ? `${buildAndyPromptWorkerContext(workerRunsSnapshot)}\n\n${prompt}`
    : prompt;

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt: effectivePrompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          const syntheticWorker = isSyntheticWorkerGroup(group);
          if (!channel && !syntheticWorker) {
            console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
            continue;
          }

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel?.setTyping?.(chatJid, true)?.catch((err) =>
              logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
            );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect channels
  whatsapp = new WhatsAppChannel(channelOpts);
  channels.push(whatsapp);
  await whatsapp.connect();

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        console.log(`Warning: no channel owns JID ${jid}, cannot send message`);
        return;
      }
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text, sourceGroup) => {
      const target = registeredGroups[jid];
      if (target && isSyntheticWorkerGroup(target)) {
        const timestamp = new Date().toISOString();
        storeMessage({
          id: `ipc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: jid,
          sender: `${sourceGroup}@nanoclaw`,
          sender_name: sourceGroup,
          content: text,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
        });
        storeChatMetadata(jid, timestamp, target.name, 'nanoclaw', true);
        return Promise.resolve();
      }
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
