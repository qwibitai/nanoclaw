import {
  createAndyRequestIfAbsent,
  getAndyRequestById,
  getAndyRequestByMessageId,
  insertDispatchAttempt,
  linkAndyRequestToWorkerRun,
  setAndyRequestCoordinatorSession,
  type AndyRequestState,
  updateAndyRequestByWorkerRun,
  updateAndyRequestState,
} from '../../db.js';
import { type NewMessage } from '../../types.js';
import { resolveLaneIdFromGroupFolder } from './lanes.js';

export interface AndyRequestMessageRef {
  requestId: string;
  messageId: string;
}

export function createAndyWorkIntakeRequest(input: {
  requestId: string;
  chatJid: string;
  sourceGroupFolder: string;
  userMessageId: string;
  userPrompt: string;
}): { requestId: string; created: boolean } {
  const sourceLaneId = resolveLaneIdFromGroupFolder(input.sourceGroupFolder);
  const created = createAndyRequestIfAbsent({
    request_id: input.requestId,
    chat_jid: input.chatJid,
    source_group_folder: input.sourceGroupFolder,
    source_lane_id: sourceLaneId,
    user_message_id: input.userMessageId,
    user_prompt: input.userPrompt,
    intent: 'work_intake',
    state: 'queued_for_coordinator',
  });
  return {
    requestId: created.request_id,
    created: created.created,
  };
}

export function listTrackedAndyRequestRefsForMessages(
  messages: NewMessage[],
): AndyRequestMessageRef[] {
  const seen = new Set<string>();
  const rows: AndyRequestMessageRef[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const request = getAndyRequestByMessageId(messages[i].id);
    if (!request || seen.has(request.request_id)) continue;
    seen.add(request.request_id);
    rows.push({ requestId: request.request_id, messageId: messages[i].id });
  }
  return rows;
}

export function markAndyRequestsCoordinatorActive(
  requests: AndyRequestMessageRef[],
  statusText: string,
): void {
  for (const request of requests) {
    updateAndyRequestState(request.requestId, 'coordinator_active', statusText);
  }
}

export function attachAndyRequestToWorkerRun(
  requestId: string,
  runId: string,
  workerGroupFolder: string,
  nextState: AndyRequestState = 'worker_queued',
): void {
  linkAndyRequestToWorkerRun(requestId, runId, workerGroupFolder, nextState);
}

export function syncAndyRequestWithWorkerRun(
  runId: string,
  state: AndyRequestState,
  lastStatusText?: string | null,
): void {
  updateAndyRequestByWorkerRun(runId, state, lastStatusText);
}

export function setAndyCoordinatorSession(
  requestId: string,
  sessionId: string | null,
): void {
  setAndyRequestCoordinatorSession(requestId, sessionId);
}

export function markAndyRequestDispatchBlocked(input: {
  requestId?: string;
  sourceLaneId: string;
  targetLaneId: string;
  runId?: string;
  reasonCode: string;
  reasonText: string;
  dispatchPayload?: string;
  sessionStrategy?: string;
}): string {
  const attemptId = insertDispatchAttempt({
    request_id: input.requestId,
    source_lane_id: input.sourceLaneId,
    target_lane_id: input.targetLaneId,
    run_id: input.runId,
    status: 'blocked',
    reason_code: input.reasonCode,
    reason_text: input.reasonText,
    session_strategy: input.sessionStrategy,
    dispatch_payload: input.dispatchPayload,
  });

  if (input.requestId) {
    updateAndyRequestState(
      input.requestId,
      'failed',
      `Dispatch blocked before worker queue: ${input.reasonText}`,
    );
  }

  return attemptId;
}

export function recordQueuedDispatchAttempt(input: {
  requestId?: string;
  sourceLaneId: string;
  targetLaneId: string;
  runId: string;
  queueState: 'new' | 'retry';
  dispatchPayload?: string;
  sessionStrategy?: string;
}): string {
  return insertDispatchAttempt({
    request_id: input.requestId,
    source_lane_id: input.sourceLaneId,
    target_lane_id: input.targetLaneId,
    run_id: input.runId,
    status: 'queued',
    reason_code: input.queueState === 'retry' ? 'retry' : null,
    reason_text: input.queueState === 'retry' ? 'retry queued after terminal failure' : null,
    session_strategy: input.sessionStrategy,
    dispatch_payload: input.dispatchPayload,
  });
}

export function completeAndyCoordinatorRequest(input: {
  requestId: string;
  coordinatorSessionId: string | null;
  runFailed: boolean;
  errorText?: string | null;
}): void {
  setAndyCoordinatorSession(input.requestId, input.coordinatorSessionId);
  const current = getAndyRequestById(input.requestId);
  if (!current) return;
  if (current.worker_run_id || `${current.state}`.startsWith('worker_')) return;

  if (input.runFailed) {
    updateAndyRequestState(
      input.requestId,
      'failed',
      input.errorText || 'Coordinator failed before dispatch',
    );
    return;
  }

  updateAndyRequestState(
    input.requestId,
    'completed',
    'Coordinator response delivered',
  );
}
