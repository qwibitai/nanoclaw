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

const REVIEW_REQUEST_PATTERN =
  /<review_request>\s*([\s\S]*?)\s*<\/review_request>/i;
const REVIEW_STATE_UPDATE_PATTERN =
  /<review_state_update>\s*([\s\S]*?)\s*<\/review_state_update>/gi;

export interface AndyRequestMessageRef {
  requestId: string;
  messageId: string;
  kind: 'coordinator' | 'review';
}

export interface AndyReviewRequestPayload {
  request_id: string;
  run_id: string;
  repo: string;
  branch: string;
  worker_group_folder: string;
  summary?: string;
  session_id?: string | null;
  parent_run_id?: string | null;
  commit_sha?: string | null;
  test_result?: string | null;
  risk?: string | null;
  pr_url?: string | null;
  pr_skipped_reason?: string | null;
}

export interface AndyReviewStateUpdate {
  request_id: string;
  state:
    | 'review_in_progress'
    | 'andy_patch_in_progress'
    | 'completed'
    | 'failed';
  summary?: string;
}

function parseJsonBlock<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function parseAndyReviewRequestMessage(
  content: string,
): AndyReviewRequestPayload | null {
  const match = content.match(REVIEW_REQUEST_PATTERN);
  if (!match?.[1]) return null;

  const parsed = parseJsonBlock<AndyReviewRequestPayload>(match[1]);
  if (!parsed) return null;
  if (
    typeof parsed.request_id !== 'string' ||
    !parsed.request_id.trim() ||
    typeof parsed.run_id !== 'string' ||
    !parsed.run_id.trim() ||
    typeof parsed.repo !== 'string' ||
    !parsed.repo.trim() ||
    typeof parsed.branch !== 'string' ||
    !parsed.branch.trim() ||
    typeof parsed.worker_group_folder !== 'string' ||
    !parsed.worker_group_folder.trim()
  ) {
    return null;
  }

  return parsed;
}

export function buildAndyReviewTriggerMessage(input: {
  chatJid: string;
  timestamp: string;
  payload: AndyReviewRequestPayload;
}): NewMessage {
  return {
    id: `review-${input.payload.run_id}`,
    chat_jid: input.chatJid,
    sender: 'nanoclaw-review@nanoclaw',
    sender_name: 'nanoclaw-review',
    content: [
      '<review_request>',
      JSON.stringify(input.payload, null, 2),
      '</review_request>',
    ].join('\n'),
    timestamp: input.timestamp,
    is_from_me: false,
    is_bot_message: false,
  };
}

export function parseAndyReviewStateUpdates(
  content: string,
): AndyReviewStateUpdate[] {
  const updates: AndyReviewStateUpdate[] = [];
  for (const match of content.matchAll(REVIEW_STATE_UPDATE_PATTERN)) {
    const parsed = parseJsonBlock<AndyReviewStateUpdate>(match[1] || '');
    if (!parsed) continue;
    if (
      typeof parsed.request_id !== 'string' ||
      !parsed.request_id.trim() ||
      ![
        'review_in_progress',
        'andy_patch_in_progress',
        'completed',
        'failed',
      ].includes(parsed.state)
    ) {
      continue;
    }
    updates.push(parsed);
  }
  return updates;
}

export function stripAndyReviewStateUpdates(content: string): string {
  return content.replace(REVIEW_STATE_UPDATE_PATTERN, '').trim();
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
    const reviewTrigger = parseAndyReviewRequestMessage(messages[i].content);
    if (reviewTrigger && !seen.has(reviewTrigger.request_id)) {
      const request = getAndyRequestById(reviewTrigger.request_id);
      if (request) {
        seen.add(reviewTrigger.request_id);
        rows.push({
          requestId: reviewTrigger.request_id,
          messageId: messages[i].id,
          kind: 'review',
        });
        continue;
      }
    }

    const request = getAndyRequestByMessageId(messages[i].id);
    if (!request || seen.has(request.request_id)) continue;
    seen.add(request.request_id);
    rows.push({
      requestId: request.request_id,
      messageId: messages[i].id,
      kind: 'coordinator',
    });
  }
  return rows;
}

export function markAndyRequestsCoordinatorActive(
  requests: AndyRequestMessageRef[],
  statusText: string,
): void {
  for (const request of requests) {
    if (request.kind !== 'coordinator') continue;
    updateAndyRequestState(request.requestId, 'coordinator_active', statusText);
  }
}

export function markAndyRequestsReviewInProgress(
  requests: AndyRequestMessageRef[],
  statusText: string,
): void {
  for (const request of requests) {
    if (request.kind !== 'review') continue;
    updateAndyRequestState(request.requestId, 'review_in_progress', statusText);
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

export function applyAndyReviewStateUpdates(
  updates: AndyReviewStateUpdate[],
): void {
  for (const update of updates) {
    const request = getAndyRequestById(update.request_id);
    if (!request) continue;
    updateAndyRequestState(
      update.request_id,
      update.state,
      update.summary ?? null,
    );
  }
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
    reason_text:
      input.queueState === 'retry'
        ? 'retry queued after terminal failure'
        : null,
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
