import {
  getMessagesSince,
  getWorkerRuns,
  requeueWorkerRunForReplay,
  storeChatMetadata,
  storeMessage,
} from '../../db.js';
import { parseDispatchPayload } from '../../dispatch-validator.js';
import { logger } from '../../logger.js';
import type { RegisteredGroup } from '../../types.js';
import type { WorkerRunSupervisor } from '../../worker-run-supervisor.js';

interface MessageRecoveryQueue {
  enqueueMessageCheck(chatJid: string): void;
}

export function findChatJidByGroupFolder(
  registeredGroups: Record<string, RegisteredGroup>,
  groupFolder: string,
): string | undefined {
  return Object.entries(registeredGroups).find(
    ([, group]) => group.folder === groupFolder,
  )?.[0];
}

export function reconcileJarvisStaleWorkerRuns(input: {
  workerRunSupervisor: WorkerRunSupervisor;
  lastAgentTimestamp: Record<string, string>;
  registeredGroups: Record<string, RegisteredGroup>;
}): boolean {
  return input.workerRunSupervisor.reconcile({
    lastAgentTimestamp: input.lastAgentTimestamp,
    resolveChatJid: (groupFolder) =>
      findChatJidByGroupFolder(input.registeredGroups, groupFolder),
  });
}

export function recoverPendingMessages(input: {
  registeredGroups: Record<string, RegisteredGroup>;
  lastAgentTimestamp: Record<string, string>;
  assistantName: string;
  queue: MessageRecoveryQueue;
}): void {
  for (const [chatJid, group] of Object.entries(input.registeredGroups)) {
    const sinceTimestamp = input.lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(
      chatJid,
      sinceTimestamp,
      input.assistantName,
    );
    if (pending.length === 0) continue;
    logger.info(
      { group: group.name, pendingCount: pending.length },
      'Recovery: found unprocessed messages',
    );
    input.queue.enqueueMessageCheck(chatJid);
  }
}

export function recoverInterruptedWorkerDispatches(input: {
  registeredGroups: Record<string, RegisteredGroup>;
  queue: MessageRecoveryQueue;
}): void {
  const activeRuns = getWorkerRuns({
    groupFolderLike: 'jarvis-worker-%',
    statuses: ['queued', 'running'],
    limit: 200,
  });

  if (activeRuns.length === 0) return;

  let replayed = 0;
  let skipped = 0;
  for (const run of activeRuns) {
    const chatJid = findChatJidByGroupFolder(
      input.registeredGroups,
      run.group_folder,
    );
    if (!chatJid) {
      skipped += 1;
      logger.warn(
        { runId: run.run_id, groupFolder: run.group_folder },
        'Startup replay skipped: worker chat JID not registered',
      );
      continue;
    }

    const payloadText = run.dispatch_payload || '';
    const parsed = parseDispatchPayload(payloadText);
    if (!parsed) {
      skipped += 1;
      logger.warn(
        { runId: run.run_id, groupFolder: run.group_folder },
        'Startup replay skipped: missing or invalid dispatch payload',
      );
      continue;
    }

    if (run.status === 'running') {
      requeueWorkerRunForReplay(run.run_id, 'startup_replay_after_restart');
    }

    const replayTimestamp = new Date().toISOString();
    storeChatMetadata(
      chatJid,
      replayTimestamp,
      input.registeredGroups[chatJid]?.name || run.group_folder,
      'nanoclaw',
      true,
    );
    storeMessage({
      id: `replay-${run.run_id}-${Date.now()}`,
      chat_jid: chatJid,
      sender: 'nanoclaw-replay@nanoclaw',
      sender_name: 'nanoclaw-replay',
      content: JSON.stringify(parsed),
      timestamp: replayTimestamp,
      is_from_me: false,
      is_bot_message: false,
    });
    input.queue.enqueueMessageCheck(chatJid);
    replayed += 1;
  }

  logger.info(
    { activeRuns: activeRuns.length, replayed, skipped },
    'Startup worker dispatch replay complete',
  );
}
