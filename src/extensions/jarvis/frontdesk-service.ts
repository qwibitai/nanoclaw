import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../../config.js';
import {
  getAndyRequestById,
  getAndyRequestByMessageId,
  getWorkerRun,
  getWorkerRunProgress,
  getWorkerRuns,
  listActiveAndyRequests,
} from '../../db.js';
import { logger } from '../../logger.js';
import { parseDispatchPayload } from '../../dispatch-validator.js';
import { type Channel, type NewMessage, type RegisteredGroup } from '../../types.js';
import {
  createAndyWorkIntakeRequest,
  listTrackedAndyRequestRefsForMessages,
} from './request-state-service.js';

const ANDY_DEVELOPER_FOLDER = 'andy-developer';
const SIMPLE_ANDY_GREETING_PATTERN = /^(hi|hello|hey|yo|hiya|sup|ping|what'?s up|good (morning|afternoon|evening))[\s!.,?]*$/i;
const ANDY_PROGRESS_QUERY_PATTERN = /\b(progress|status|update|what(?:'|’)s happening|what is happening|where are we|how far|eta|current progress|current status|what(?:\s+are|(?:'|’)re)\s+you\s+working\s+on(?:\s+(?:right\s+now|now|currently))?)\b/i;
const ANDY_STATUS_BY_ID_PATTERN = /\bstatus\s+(req-[a-z0-9-]+)\b/i;
const ANDY_REQUEST_ID_PATTERN = /\b(req-[a-z0-9-]+)\b/i;

export interface AndyFrontdeskRuntimeCallbacks {
  markCursorInFlight(chatJid: string, timestamp: string): void;
  clearInFlightCursor(chatJid: string): void;
  markBatchProcessed(chatJid: string, messages: NewMessage[]): void;
  commitInFlightCursor(chatJid: string): void;
}

function stripAssistantTrigger(content: string): string {
  return content.trim().replace(TRIGGER_PATTERN, '').trim();
}

export function isSimpleAndyGreeting(
  group: RegisteredGroup,
  messages: NewMessage[],
): boolean {
  if (group.folder !== ANDY_DEVELOPER_FOLDER) return false;
  if (messages.length !== 1) return false;
  if (parseDispatchPayload(messages[0].content)) return false;

  const body = stripAssistantTrigger(messages[0].content);
  if (!body) return true;
  return SIMPLE_ANDY_GREETING_PATTERN.test(body);
}

function getAndyProgressQueryContext(
  group: RegisteredGroup,
  messages: NewMessage[],
): {
  queryMessage: NewMessage;
  handledMessages: NewMessage[];
  containsNonQueryWork: boolean;
} | null {
  if (group.folder !== ANDY_DEVELOPER_FOLDER) return null;
  if (messages.length === 0) return null;

  let queryMessage: NewMessage | null = null;
  let containsNonQueryWork = false;
  for (const message of messages) {
    if (parseDispatchPayload(message.content)) return null;
    const body = stripAssistantTrigger(message.content).trim();
    if (!body) continue;
    if (ANDY_STATUS_BY_ID_PATTERN.test(body) || ANDY_PROGRESS_QUERY_PATTERN.test(body)) {
      queryMessage = message;
      continue;
    }
    if (SIMPLE_ANDY_GREETING_PATTERN.test(body)) continue;
    containsNonQueryWork = true;
  }

  if (!queryMessage) return null;
  return { queryMessage, handledMessages: messages, containsNonQueryWork };
}

function extractAndyStatusRequestId(message: NewMessage): string | undefined {
  const body = stripAssistantTrigger(message.content).trim();
  if (!body) return undefined;

  const explicit = body.match(ANDY_STATUS_BY_ID_PATTERN);
  if (explicit?.[1]) return explicit[1];

  if (!ANDY_PROGRESS_QUERY_PATTERN.test(body)) return undefined;
  const anyId = body.match(ANDY_REQUEST_ID_PATTERN);
  return anyId?.[1];
}

function isAndyWorkIntakeMessage(group: RegisteredGroup, message: NewMessage): boolean {
  if (group.folder !== ANDY_DEVELOPER_FOLDER) return false;
  if (parseDispatchPayload(message.content)) return false;

  const body = stripAssistantTrigger(message.content).trim();
  if (!body) return false;
  if (SIMPLE_ANDY_GREETING_PATTERN.test(body)) return false;
  if (ANDY_STATUS_BY_ID_PATTERN.test(body) || ANDY_PROGRESS_QUERY_PATTERN.test(body)) return false;
  return true;
}

function generateAndyRequestId(messageId: string): string {
  const suffix = messageId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(-8)
    || Math.random().toString(36).slice(2, 10);
  return `req-${Date.now()}-${suffix}`;
}

export function buildAndyFrontdeskContextBlock(chatJid: string, requestId: string): string {
  return [
    '<frontdesk_request>',
    `request_id: ${requestId}`,
    `chat_jid: ${chatJid}`,
    `status_command: status ${requestId}`,
    'If you dispatch strict JSON to jarvis-worker-*, include request_id exactly as above.',
    '</frontdesk_request>',
  ].join('\n');
}

export async function ackAndyIntakeMessages(
  chatJid: string,
  group: RegisteredGroup,
  messages: NewMessage[],
  channel: Channel,
): Promise<void> {
  if (group.folder !== ANDY_DEVELOPER_FOLDER) return;

  for (const message of messages) {
    if (!isAndyWorkIntakeMessage(group, message)) continue;
    const body = stripAssistantTrigger(message.content).trim();
    const requestId = generateAndyRequestId(message.id);
    const created = createAndyWorkIntakeRequest({
      requestId,
      chatJid,
      sourceGroupFolder: group.folder,
      userMessageId: message.id,
      userPrompt: body,
    });
    if (!created.created) continue;

    const ackText = `${ASSISTANT_NAME}: Got it. Tracking this as \`${created.requestId}\`. Ask \`status ${created.requestId}\` anytime.`;
    try {
      await channel.sendMessage(chatJid, ackText);
    } catch (err) {
      logger.warn({ chatJid, requestId: created.requestId, err }, 'Andy intake ack send failed');
    }
  }
}

function formatElapsedSince(startedAt: string): string {
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return 'elapsed unknown';
  const elapsedMs = Math.max(0, Date.now() - startedMs);
  const totalMinutes = Math.floor(elapsedMs / 60_000);
  if (totalMinutes < 1) return 'elapsed <1m';
  if (totalMinutes < 60) return `elapsed ${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0
    ? `elapsed ${hours}h`
    : `elapsed ${hours}h ${minutes}m`;
}

export function buildAndyProgressStatusReply(chatJid: string, requestId?: string): string {
  if (requestId) {
    const request = getAndyRequestById(requestId);
    if (!request) {
      return `${ASSISTANT_NAME}: I couldn't find request \`${requestId}\`.`;
    }
    if (request.chat_jid !== chatJid) {
      return `${ASSISTANT_NAME}: Request \`${requestId}\` belongs to a different chat.`;
    }

    if (request.worker_run_id) {
      const run = getWorkerRun(request.worker_run_id);
      if (run) {
        const progress = getWorkerRunProgress(run.run_id);
        const progressSummary = progress?.last_progress_summary?.trim();
        const suffix = progressSummary ? ` - ${progressSummary}` : '';
        return `${ASSISTANT_NAME}: \`${request.request_id}\` is \`${request.state}\`. Worker run \`${run.run_id}\` on \`${run.group_folder}\` is \`${run.status}\` (${formatElapsedSince(run.started_at)})${suffix}.`;
      }
    }

    const lastText = request.last_status_text ? ` ${request.last_status_text}` : '';
    return `${ASSISTANT_NAME}: \`${request.request_id}\` is \`${request.state}\`.${lastText}`;
  }

  const activeRequests = listActiveAndyRequests(chatJid, 3);
  if (activeRequests.length > 0) {
    const lines = activeRequests.map((request) => {
      if (request.worker_run_id) {
        const run = getWorkerRun(request.worker_run_id);
        if (run) {
          const progress = getWorkerRunProgress(run.run_id);
          const progressSummary = progress?.last_progress_summary?.trim();
          const suffix = progressSummary ? ` - ${progressSummary}` : '';
          return `- \`${request.request_id}\`: ${request.state}; run \`${run.run_id}\` is \`${run.status}\` (${formatElapsedSince(run.started_at)})${suffix}`;
        }
      }
      return `- \`${request.request_id}\`: ${request.state}`;
    });
    return `${ASSISTANT_NAME}: Current tracked requests:\n${lines.join('\n')}`;
  }

  const activeRuns = getWorkerRuns({
    groupFolderLike: 'jarvis-worker-%',
    statuses: ['queued', 'running'],
    limit: 5,
  });

  if (activeRuns.length === 0) {
    const latestRun = getWorkerRuns({
      groupFolderLike: 'jarvis-worker-%',
      limit: 1,
    })[0];
    if (!latestRun) {
      return `${ASSISTANT_NAME}: There are no worker runs yet.`;
    }

    const latestAt = latestRun.completed_at ?? latestRun.started_at;
    return `${ASSISTANT_NAME}: No worker run is active right now. Latest run \`${latestRun.run_id}\` on \`${latestRun.group_folder}\` is \`${latestRun.status}\` (${latestAt}).`;
  }

  const queuedCount = activeRuns.filter((run) => run.status === 'queued').length;
  const runningCount = activeRuns.filter((run) => run.status === 'running').length;
  const visibleRuns = activeRuns.slice(0, 3);
  const lines = visibleRuns.map((run) => {
    const detail = run.phase && run.phase !== run.status
      ? `${run.status}/${run.phase}`
      : run.status;
    const progress = getWorkerRunProgress(run.run_id);
    const progressSummary = progress?.last_progress_summary?.trim();
    const suffix = progressSummary ? ` - ${progressSummary}` : '';
    return `- \`${run.run_id}\` (${run.group_folder}) ${detail}, ${formatElapsedSince(run.started_at)}${suffix}`;
  });
  if (activeRuns.length > visibleRuns.length) {
    lines.push(`- ...and ${activeRuns.length - visibleRuns.length} more active run(s).`);
  }
  return `${ASSISTANT_NAME}: Current progress: ${runningCount} running, ${queuedCount} queued.\n${lines.join('\n')}`;
}

async function trySendAndyProgressStatus(
  chatJid: string,
  group: RegisteredGroup,
  messages: NewMessage[],
  channel: Channel,
  runtime: AndyFrontdeskRuntimeCallbacks,
): Promise<boolean> {
  const progressContext = getAndyProgressQueryContext(group, messages);
  if (!progressContext) return false;
  const requestId = extractAndyStatusRequestId(progressContext.queryMessage);

  const lastTimestamp = messages[messages.length - 1].timestamp;
  if (!progressContext.containsNonQueryWork) {
    runtime.markCursorInFlight(chatJid, lastTimestamp);
  }
  try {
    await channel.sendMessage(chatJid, buildAndyProgressStatusReply(chatJid, requestId));
    if (progressContext.containsNonQueryWork) {
      return false;
    }
    runtime.markBatchProcessed(chatJid, progressContext.handledMessages);
    runtime.commitInFlightCursor(chatJid);
    return true;
  } catch (err) {
    if (!progressContext.containsNonQueryWork) {
      runtime.clearInFlightCursor(chatJid);
    }
    logger.warn({ chatJid, err }, 'Andy progress status send failed');
    return false;
  }
}

export async function handleAndyFrontdeskMessages(input: {
  chatJid: string;
  group: RegisteredGroup;
  messages: NewMessage[];
  channel: Channel;
  runtime: AndyFrontdeskRuntimeCallbacks;
  allowGreeting?: boolean;
}): Promise<boolean> {
  const {
    chatJid,
    group,
    messages,
    channel,
    runtime,
    allowGreeting = true,
  } = input;

  await ackAndyIntakeMessages(chatJid, group, messages, channel);

  if (allowGreeting && isSimpleAndyGreeting(group, messages)) {
    runtime.markCursorInFlight(chatJid, messages[messages.length - 1].timestamp);
    try {
      await channel.sendMessage(chatJid, `${ASSISTANT_NAME}: Hey, I'm here. How can I help?`);
      runtime.markBatchProcessed(chatJid, messages);
      runtime.commitInFlightCursor(chatJid);
      return true;
    } catch (err) {
      runtime.clearInFlightCursor(chatJid);
      logger.warn({ group: group.name, err }, 'Simple Andy greeting failed to send');
      return false;
    }
  }

  return trySendAndyProgressStatus(chatJid, group, messages, channel, runtime);
}

export function getAndyRequestsForMessages(messages: NewMessage[]): Array<{
  requestId: string;
  messageId: string;
}> {
  return listTrackedAndyRequestRefsForMessages(messages);
}

export function getAndyRequestByMessageRef(messageId: string) {
  return getAndyRequestByMessageId(messageId);
}
