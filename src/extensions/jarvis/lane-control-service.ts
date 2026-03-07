import {
  ASSISTANT_NAME,
  MAIN_GROUP_FOLDER,
  TRIGGER_PATTERN,
} from '../../config.js';
import {
  getAndyRequestById,
  getLatestAndyRequestForChat,
  getWorkerRunProgress,
  listActiveAndyRequests,
  storeChatMetadata,
  storeMessage,
} from '../../db.js';
import type { GroupQueueStatusSnapshot } from '../../group-queue.js';
import { logger } from '../../logger.js';
import { getCurrentRuntimeOwner } from '../../runtime-ownership.js';
import {
  type Channel,
  type LaneId,
  type NewMessage,
  type RegisteredGroup,
} from '../../types.js';
import {
  buildAndyProgressStatusReply,
  type AndyFrontdeskRuntimeCallbacks,
} from './frontdesk-service.js';
import {
  ANDY_DEVELOPER_LANE_ID,
  MAIN_LANE_ID,
  resolveLaneIdFromGroupFolder,
} from './lanes.js';

type LaneControlAvailability = 'idle' | 'busy' | 'queued' | 'offline';
type LaneControlMode = 'append' | 'interrupt';

const REQUEST_STATUS_PATTERN = /^status\s+(req-[a-z0-9-]+)\s*[.!?]*$/i;
const LANE_CONTROL_COMMAND_PATTERN =
  /^(steer|interrupt)\s+([^:]+?)\s*:\s*([\s\S]+)$/i;

export interface LaneStatus {
  lane_id: LaneId;
  availability: LaneControlAvailability;
  active_request_id?: string;
  active_run_id?: string;
  summary: string;
  updated_at?: string;
}

export interface RequestStatus {
  request_id: string;
  state: string;
  worker_run_id?: string;
  worker_group_folder?: string;
  last_status_text?: string;
  last_progress_summary?: string;
  updated_at: string;
}

export interface ControlPlaneLaneStatus extends LaneStatus {
  active_requests: RequestStatus[];
}

export interface ControlPlaneStatusSnapshot {
  generated_at: string;
  lanes: Partial<Record<LaneId, ControlPlaneLaneStatus>>;
}

export interface LaneControlQueue {
  getStatus(groupJid: string): GroupQueueStatusSnapshot;
  sendMessage(groupJid: string, text: string): boolean;
  closeStdin(groupJid: string): void;
  enqueueMessageCheck(groupJid: string): void;
}

type MainLaneControlIntent =
  | { kind: 'request_status'; requestId: string }
  | {
      kind: 'lane_control';
      laneId: LaneId | 'unknown';
      mode: LaneControlMode;
      message: string;
    };

function stripAssistantTrigger(content: string): string {
  return content.trim().replace(TRIGGER_PATTERN, '').trim();
}

function stripAssistantPrefix(content: string): string {
  const prefix = `${ASSISTANT_NAME}:`;
  return content.startsWith(prefix)
    ? content.slice(prefix.length).trim()
    : content;
}

function normalizeLaneTarget(value: string): LaneId | 'unknown' {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, '-');
  if (normalized === 'andy-developer') return ANDY_DEVELOPER_LANE_ID;
  if (normalized === 'main') return MAIN_LANE_ID;
  if (normalized === 'jarvis-worker-1' || normalized === 'jarvis-worker-2') {
    return normalized;
  }
  return 'unknown';
}

function findChatJidForLane(
  registeredGroups: Record<string, RegisteredGroup>,
  laneId: LaneId,
): string | undefined {
  return Object.entries(registeredGroups).find(([, group]) => {
    return resolveLaneIdFromGroupFolder(group.folder) === laneId;
  })?.[0];
}

function authorizeLaneSteer(
  actorLaneId: LaneId,
  targetLaneId: LaneId,
): boolean {
  return (
    actorLaneId === MAIN_LANE_ID && targetLaneId === ANDY_DEVELOPER_LANE_ID
  );
}

function isBusyAndyRequestState(state: string | null | undefined): boolean {
  return (
    state === 'coordinator_active' ||
    state === 'review_in_progress' ||
    state === 'andy_patch_in_progress'
  );
}

function parseMainLaneControlIntent(
  group: RegisteredGroup,
  messages: NewMessage[],
): MainLaneControlIntent | null {
  if (group.folder !== MAIN_GROUP_FOLDER) return null;
  if (messages.length !== 1) return null;

  const body = stripAssistantTrigger(messages[0].content);
  if (!body) return null;

  const requestMatch = body.match(REQUEST_STATUS_PATTERN);
  if (requestMatch?.[1]) {
    return { kind: 'request_status', requestId: requestMatch[1] };
  }

  const controlMatch = body.match(LANE_CONTROL_COMMAND_PATTERN);
  if (controlMatch) {
    const [, rawMode, rawTarget, rawMessage] = controlMatch;
    const laneId = normalizeLaneTarget(rawTarget);
    const message = rawMessage.trim();
    if (!message) return null;
    return {
      kind: 'lane_control',
      laneId,
      mode: rawMode.toLowerCase() === 'interrupt' ? 'interrupt' : 'append',
      message,
    };
  }

  return null;
}

export function getRequestStatus(requestId: string): RequestStatus | null {
  const request = getAndyRequestById(requestId);
  if (!request) return null;

  const progress = request.worker_run_id
    ? getWorkerRunProgress(request.worker_run_id)
    : null;

  return {
    request_id: request.request_id,
    state: request.state,
    worker_run_id: request.worker_run_id ?? undefined,
    worker_group_folder: request.worker_group_folder ?? undefined,
    last_status_text: request.last_status_text ?? undefined,
    last_progress_summary: progress?.last_progress_summary ?? undefined,
    updated_at: request.updated_at,
  };
}

export function listActiveRequests(
  registeredGroups: Record<string, RegisteredGroup>,
  chatJid?: string,
): RequestStatus[] {
  const targetChatJid =
    chatJid ?? findChatJidForLane(registeredGroups, ANDY_DEVELOPER_LANE_ID);
  if (!targetChatJid) return [];

  return listActiveAndyRequests(targetChatJid).map((request) => {
    const progress = request.worker_run_id
      ? getWorkerRunProgress(request.worker_run_id)
      : null;
    return {
      request_id: request.request_id,
      state: request.state,
      worker_run_id: request.worker_run_id ?? undefined,
      worker_group_folder: request.worker_group_folder ?? undefined,
      last_status_text: request.last_status_text ?? undefined,
      last_progress_summary: progress?.last_progress_summary ?? undefined,
      updated_at: request.updated_at,
    };
  });
}

export function getLaneStatus(input: {
  laneId: LaneId;
  registeredGroups: Record<string, RegisteredGroup>;
  queue: Pick<LaneControlQueue, 'getStatus'>;
}): LaneStatus {
  const { laneId, registeredGroups, queue } = input;
  const runtimeOwner = getCurrentRuntimeOwner();
  const chatJid = findChatJidForLane(registeredGroups, laneId);
  const queueStatus = chatJid ? queue.getStatus(chatJid) : undefined;
  const latestRequest = chatJid
    ? getLatestAndyRequestForChat(chatJid)
    : undefined;
  const activeRequest = chatJid
    ? listActiveAndyRequests(chatJid, 1)[0]
    : undefined;

  if (!chatJid) {
    return {
      lane_id: laneId,
      availability: 'offline',
      summary: `${laneId} is not registered in this runtime.`,
      updated_at: runtimeOwner?.heartbeat_at,
    };
  }

  const activeRunId =
    activeRequest?.worker_run_id ?? latestRequest?.worker_run_id ?? undefined;
  const hasQueuedWork = Boolean(
    activeRequest ||
    queueStatus?.pendingMessages ||
    (queueStatus?.pendingTaskCount ?? 0) > 0,
  );

  let availability: LaneControlAvailability = 'idle';
  if (!runtimeOwner) {
    availability = 'offline';
  } else if (queueStatus?.active || isBusyAndyRequestState(latestRequest?.state)) {
    availability = 'busy';
  } else if (hasQueuedWork) {
    availability = 'queued';
  }

  const summary =
    laneId === ANDY_DEVELOPER_LANE_ID
      ? stripAssistantPrefix(buildAndyProgressStatusReply(chatJid))
      : `${laneId} status is not available from the main control plane.`;

  return {
    lane_id: laneId,
    availability,
    active_request_id:
      activeRequest?.request_id ?? latestRequest?.request_id ?? undefined,
    active_run_id: activeRunId,
    summary,
    updated_at:
      activeRequest?.updated_at ??
      latestRequest?.updated_at ??
      runtimeOwner?.heartbeat_at,
  };
}

export function buildControlPlaneStatusSnapshot(input: {
  registeredGroups: Record<string, RegisteredGroup>;
  queue: Pick<LaneControlQueue, 'getStatus'>;
}): ControlPlaneStatusSnapshot {
  const laneId = ANDY_DEVELOPER_LANE_ID;
  return {
    generated_at: new Date().toISOString(),
    lanes: {
      [laneId]: {
        ...getLaneStatus({
          laneId,
          registeredGroups: input.registeredGroups,
          queue: input.queue,
        }),
        active_requests: listActiveRequests(input.registeredGroups),
      },
    },
  };
}

function buildRequestStatusReply(requestId: string): string {
  const request = getAndyRequestById(requestId);
  if (!request) {
    return `${ASSISTANT_NAME}: I couldn't find request \`${requestId}\`.`;
  }

  return buildAndyProgressStatusReply(request.chat_jid, requestId);
}

export function steerLane(input: {
  actorLaneId: LaneId;
  targetLaneId: LaneId | 'unknown';
  mode: LaneControlMode;
  message: string;
  registeredGroups: Record<string, RegisteredGroup>;
  queue: LaneControlQueue;
}): { ok: boolean; reply: string } {
  if (input.targetLaneId === 'unknown') {
    return {
      ok: false,
      reply: `${ASSISTANT_NAME}: I only support steering \`andy-developer\` from main right now.`,
    };
  }

  if (!authorizeLaneSteer(input.actorLaneId, input.targetLaneId)) {
    return {
      ok: false,
      reply: `${ASSISTANT_NAME}: Main may only steer \`andy-developer\`, not \`${input.targetLaneId}\`.`,
    };
  }

  const targetChatJid = findChatJidForLane(
    input.registeredGroups,
    input.targetLaneId,
  );
  if (!targetChatJid) {
    return {
      ok: false,
      reply: `${ASSISTANT_NAME}: \`${input.targetLaneId}\` is not registered in this runtime.`,
    };
  }

  const queueStatus = input.queue.getStatus(targetChatJid);
  if (!queueStatus.active || queueStatus.isTaskContainer) {
    return {
      ok: false,
      reply: `${ASSISTANT_NAME}: Andy Developer is not in an active coordinator session right now.`,
    };
  }

  const steerText = `Main lane steer: ${input.message}`;
  if (input.mode === 'append') {
    const sent = input.queue.sendMessage(targetChatJid, steerText);
    if (!sent) {
      return {
        ok: false,
        reply: `${ASSISTANT_NAME}: Andy Developer is active, but the live session is not ready for a steer right now.`,
      };
    }
    return {
      ok: true,
      reply: `${ASSISTANT_NAME}: Sent a steer to \`andy-developer\`.`,
    };
  }

  const timestamp = new Date().toISOString();
  const targetGroup = input.registeredGroups[targetChatJid];
  storeChatMetadata(
    targetChatJid,
    timestamp,
    targetGroup?.name ?? 'Andy Developer',
    'nanoclaw',
    true,
  );
  storeMessage({
    id: `main-steer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: targetChatJid,
    sender: 'main-control@nanoclaw',
    sender_name: 'main-control',
    content: `@Andy ${steerText}`,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
  });
  input.queue.closeStdin(targetChatJid);
  input.queue.enqueueMessageCheck(targetChatJid);

  return {
    ok: true,
    reply: `${ASSISTANT_NAME}: Soft-interrupted \`andy-developer\` and queued your steer as the next turn.`,
  };
}

export async function handleMainLaneControlMessages(input: {
  chatJid: string;
  group: RegisteredGroup;
  messages: NewMessage[];
  channel: Channel;
  queue: LaneControlQueue;
  registeredGroups: Record<string, RegisteredGroup>;
  runtime: AndyFrontdeskRuntimeCallbacks;
}): Promise<boolean> {
  const intent = parseMainLaneControlIntent(input.group, input.messages);
  if (!intent) return false;

  const lastTimestamp = input.messages[input.messages.length - 1].timestamp;
  input.runtime.markCursorInFlight(input.chatJid, lastTimestamp);

  let reply: string;
  try {
    if (intent.kind === 'request_status') {
      reply = buildRequestStatusReply(intent.requestId);
    } else {
      reply = steerLane({
        actorLaneId: MAIN_LANE_ID,
        targetLaneId: intent.laneId,
        mode: intent.mode,
        message: intent.message,
        registeredGroups: input.registeredGroups,
        queue: input.queue,
      }).reply;
    }
  } catch (err) {
    logger.warn(
      { chatJid: input.chatJid, intent: intent.kind, err },
      'Main lane control handling failed',
    );
    reply = `${ASSISTANT_NAME}: I couldn't complete that control-plane request.`;
  }

  try {
    await input.channel.sendMessage(input.chatJid, reply);
  } catch (err) {
    logger.warn(
      { chatJid: input.chatJid, intent: intent.kind, err },
      'Main lane control reply failed to send',
    );
  }

  input.runtime.markBatchProcessed(input.chatJid, input.messages);
  input.runtime.commitInFlightCursor(input.chatJid);
  return true;
}
