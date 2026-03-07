import {
  findWorkerRunByEffectiveSessionId,
  getLatestReusableWorkerSession,
  getWorkerRun,
  insertWorkerRun,
  isNonRetryableWorkerStatus,
  type WorkerRunDispatchMetadata,
} from '../../db.js';
import {
  parseDispatchPayload,
  validateDispatchPayload,
} from '../../dispatch-validator.js';
import { type RegisteredGroup, isJarvisWorkerFolder } from '../../types.js';
import {
  ANDY_DEVELOPER_LANE_ID,
  isJarvisWorkerLaneId,
  resolveLaneIdFromGroupFolder,
} from './lanes.js';
import {
  attachAndyRequestToWorkerRun,
  markAndyRequestDispatchBlocked,
  recordQueuedDispatchAttempt,
} from './request-state-service.js';

export interface DispatchBlockEvent {
  kind: 'dispatch_block';
  timestamp: string;
  source_group: string;
  source_jid?: string;
  target_jid: string;
  target_folder?: string;
  reason_code:
    | 'unauthorized_source_lane'
    | 'target_authorization_failed'
    | 'invalid_dispatch_payload'
    | 'duplicate_run_id';
  reason_text: string;
  run_id?: string;
  request_id?: string;
}

export type WorkerPayloadValidation =
  | { valid: true }
  | {
      valid: false;
      reasonCode: DispatchBlockEvent['reason_code'];
      reason: string;
    };

export interface WorkerDispatchQueueDecision {
  allowSend: boolean;
  runId?: string;
  queueState?: 'new' | 'retry';
  reason?: string;
  attemptId?: string;
}

export interface WorkerSessionSelection {
  selectedSessionId?: string;
  source: 'explicit' | 'auto_repo_branch' | 'new';
}

export function buildDispatchBlockedMessage(event: DispatchBlockEvent): string {
  if (event.reason_code === 'duplicate_run_id') {
    return [
      '*Dispatch ignored (duplicate run_id)*',
      ...(event.run_id ? [`• Run ID: \`${event.run_id}\``] : []),
      `• Target: \`${event.target_jid}\` (${event.target_folder || 'unknown-folder'})`,
      `• Reason: ${event.reason_text}`,
      '• Action: no resend needed unless you intentionally want a new run_id.',
    ].join('\n');
  }

  const template = {
    run_id: event.run_id || 'task-<timestamp>-001',
    request_id: 'req-<timestamp>-001',
    task_type: 'implement',
    context_intent: 'fresh',
    input: 'Implement the requested change',
    repo: 'owner/repo',
    base_branch: 'main',
    branch: 'jarvis-<feature>',
    acceptance_tests: ['npm run build', 'npm test'],
    output_contract: {
      required_fields: [
        'run_id',
        'branch',
        'commit_sha',
        'files_changed',
        'test_result',
        'risk',
        'pr_url',
      ],
    },
    priority: 'high',
  };

  const lines = [
    '*Dispatch blocked by validator*',
    ...(event.run_id ? [`• Run ID: \`${event.run_id}\``] : []),
    `• Target: \`${event.target_jid}\` (${event.target_folder || 'unknown-folder'})`,
    `• Reason: ${event.reason_text}`,
  ];
  return [
    ...lines,
    '• Enforced rules:',
    '  - Only `andy-developer` may dispatch strict JSON contracts to `jarvis-worker-*`.',
    '  - `branch` must match `jarvis-<feature>`.',
    '  - Dispatch must be strict JSON with required output contract fields.',
    '• Fix: resend using the template below (edit values):',
    '```json',
    JSON.stringify(template, null, 2),
    '```',
  ].join('\n');
}

export function canJarvisDispatchToTarget(
  sourceGroup: string,
  isMain: boolean,
  targetGroup: RegisteredGroup | undefined,
): boolean {
  if (isMain) return true;
  if (!targetGroup) return false;
  if (targetGroup.folder === sourceGroup) return true;

  const sourceLaneId = resolveLaneIdFromGroupFolder(sourceGroup);
  const targetLaneId = resolveLaneIdFromGroupFolder(targetGroup.folder);
  if (
    sourceLaneId === ANDY_DEVELOPER_LANE_ID &&
    targetLaneId &&
    isJarvisWorkerLaneId(targetLaneId)
  ) {
    return true;
  }

  return false;
}

export function selectWorkerSessionForDispatch(
  groupFolder: string,
  payload: {
    context_intent: 'continue' | 'fresh';
    session_id?: string;
    repo: string;
    branch: string;
  },
): WorkerSessionSelection | null {
  if (payload.context_intent === 'fresh') {
    return { source: 'new' };
  }

  if (payload.session_id) {
    return { selectedSessionId: payload.session_id, source: 'explicit' };
  }

  const reusable = getLatestReusableWorkerSession(
    groupFolder,
    payload.repo,
    payload.branch,
  );
  if (!reusable?.effective_session_id) {
    return null;
  }

  return {
    selectedSessionId: reusable.effective_session_id,
    source: 'auto_repo_branch',
  };
}

function validateWorkerSessionRouting(
  targetFolder: string,
  payload: ReturnType<typeof parseDispatchPayload>,
): { valid: boolean; reason?: string } {
  if (!payload || !isJarvisWorkerFolder(targetFolder)) {
    return { valid: true };
  }

  if (payload.session_id) {
    const priorRun = findWorkerRunByEffectiveSessionId(payload.session_id);
    if (priorRun && priorRun.group_folder !== targetFolder) {
      return {
        valid: false,
        reason: `session_id belongs to ${priorRun.group_folder}; cross-worker session reuse is blocked`,
      };
    }
  }

  if (payload.context_intent === 'continue' && !payload.session_id) {
    const reusable = getLatestReusableWorkerSession(
      targetFolder,
      payload.repo,
      payload.branch,
    );
    if (!reusable?.effective_session_id) {
      return {
        valid: false,
        reason:
          'context_intent=continue requires a reusable prior session for this worker/repo/branch; provide session_id or use context_intent=fresh',
      };
    }
  }

  return { valid: true };
}

export function validateAndyToWorkerPayload(
  targetFolder: string,
  text: string,
): WorkerPayloadValidation {
  const parsed = parseDispatchPayload(text);
  if (!parsed) {
    return {
      valid: false,
      reasonCode: 'invalid_dispatch_payload',
      reason:
        'andy-developer -> jarvis-worker requires strict JSON dispatch payload',
    };
  }

  const existingRun = getWorkerRun(parsed.run_id);
  if (existingRun && isNonRetryableWorkerStatus(existingRun.status)) {
    return {
      valid: false,
      reasonCode: 'duplicate_run_id',
      reason: `duplicate run_id blocked: ${parsed.run_id} already ${existingRun.status}`,
    };
  }

  const { valid, errors } = validateDispatchPayload(parsed);
  if (!valid) {
    return {
      valid: false,
      reasonCode: 'invalid_dispatch_payload',
      reason: `invalid dispatch payload: ${errors.join('; ')}`,
    };
  }

  const sessionRouting = validateWorkerSessionRouting(targetFolder, parsed);
  if (!sessionRouting.valid) {
    return {
      valid: false,
      reasonCode: 'invalid_dispatch_payload',
      reason: sessionRouting.reason || 'invalid dispatch payload',
    };
  }

  return { valid: true };
}

export function normalizeWorkerDispatchPayloadText(
  sourceGroup: string,
  targetGroup: RegisteredGroup | undefined,
  text: string,
): { text: string; normalized: boolean } {
  if (
    sourceGroup !== ANDY_DEVELOPER_LANE_ID ||
    !targetGroup ||
    !isJarvisWorkerFolder(targetGroup.folder)
  ) {
    return { text, normalized: false };
  }

  const payload = parseDispatchPayload(text);
  if (!payload) return { text, normalized: false };
  if (
    !payload.output_contract ||
    !Array.isArray(payload.output_contract.required_fields)
  ) {
    return { text, normalized: false };
  }

  const before = payload.output_contract.required_fields;
  const required = new Set(
    before
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );

  required.add('run_id');
  required.add('branch');
  required.add('commit_sha');
  required.add('files_changed');
  required.add('test_result');
  required.add('risk');
  if (!required.has('pr_url') && !required.has('pr_skipped_reason')) {
    required.add('pr_url');
  }

  const after = Array.from(required);
  const changed =
    after.length !== before.length ||
    after.some((field) => !before.includes(field));
  if (!changed) return { text, normalized: false };

  const normalizedPayload = {
    ...payload,
    output_contract: {
      ...payload.output_contract,
      required_fields: after,
    },
  };
  return { text: JSON.stringify(normalizedPayload), normalized: true };
}

export function validateAndyWorkerDispatchMessage(
  sourceGroup: string,
  targetGroup: RegisteredGroup | undefined,
  text: string,
): { valid: boolean; reason?: string } {
  const parsed = parseDispatchPayload(text);
  const isWorkerTarget =
    !!targetGroup && isJarvisWorkerFolder(targetGroup.folder);

  if (
    sourceGroup === ANDY_DEVELOPER_LANE_ID &&
    targetGroup?.folder === ANDY_DEVELOPER_LANE_ID &&
    parsed
  ) {
    return {
      valid: false,
      reason:
        'dispatch payload to andy-developer chat blocked; set target_group_jid to jarvis-worker-*',
    };
  }

  if (isWorkerTarget && sourceGroup !== ANDY_DEVELOPER_LANE_ID && parsed) {
    return {
      valid: false,
      reason:
        'worker dispatch ownership violation: only andy-developer may dispatch strict JSON contracts to jarvis-worker-* lanes',
    };
  }

  if (sourceGroup !== ANDY_DEVELOPER_LANE_ID || !isWorkerTarget) {
    return { valid: true };
  }

  const result = validateAndyToWorkerPayload(targetGroup.folder, text);
  if (!result.valid) {
    return { valid: false, reason: result.reason };
  }
  return { valid: true };
}

function getDispatchSessionStrategy(
  parsed: ReturnType<typeof parseDispatchPayload>,
): 'explicit' | 'auto_repo_branch' | 'new' | undefined {
  if (!parsed) return undefined;
  if (parsed.session_id) return 'explicit';
  if (parsed.context_intent === 'fresh') return 'new';
  if (parsed.context_intent === 'continue') return 'auto_repo_branch';
  return undefined;
}

function buildWorkerDispatchMetadata(
  targetGroup: RegisteredGroup,
  parsed: NonNullable<ReturnType<typeof parseDispatchPayload>>,
): WorkerRunDispatchMetadata {
  return {
    lane_id:
      resolveLaneIdFromGroupFolder(targetGroup.folder) ?? targetGroup.folder,
    dispatch_repo: parsed.repo,
    dispatch_branch: parsed.branch,
    request_id: parsed.request_id,
    context_intent: parsed.context_intent,
    dispatch_payload: JSON.stringify(parsed),
    parent_run_id: parsed.parent_run_id,
    dispatch_session_id: parsed.session_id,
    selected_session_id: parsed.session_id,
    session_selection_source: getDispatchSessionStrategy(parsed),
  };
}

export function queueAndyWorkerDispatchRun(
  sourceGroup: string,
  targetGroup: RegisteredGroup | undefined,
  text: string,
): WorkerDispatchQueueDecision {
  if (
    sourceGroup !== ANDY_DEVELOPER_LANE_ID ||
    !targetGroup ||
    !isJarvisWorkerFolder(targetGroup.folder)
  ) {
    return { allowSend: true };
  }

  const parsed = parseDispatchPayload(text);
  if (!parsed) return { allowSend: true };

  const sourceLaneId = resolveLaneIdFromGroupFolder(sourceGroup) ?? sourceGroup;
  const targetLaneId =
    resolveLaneIdFromGroupFolder(targetGroup.folder) ?? targetGroup.folder;
  const sessionStrategy = getDispatchSessionStrategy(parsed);
  const queueState = insertWorkerRun(
    parsed.run_id,
    targetGroup.folder,
    buildWorkerDispatchMetadata(targetGroup, parsed),
  );
  if (queueState === 'duplicate') {
    return {
      allowSend: false,
      runId: parsed.run_id,
      reason: `duplicate run_id blocked: ${parsed.run_id}`,
    };
  }

  const attemptId = recordQueuedDispatchAttempt({
    requestId: parsed.request_id,
    sourceLaneId,
    targetLaneId,
    runId: parsed.run_id,
    queueState,
    dispatchPayload: JSON.stringify(parsed),
    sessionStrategy,
  });

  if (parsed.request_id) {
    attachAndyRequestToWorkerRun(
      parsed.request_id,
      parsed.run_id,
      targetGroup.folder,
      'worker_queued',
    );
  }

  return {
    allowSend: true,
    runId: parsed.run_id,
    queueState,
    attemptId,
  };
}

export function recordBlockedDispatchAttempt(
  event: DispatchBlockEvent,
): string | undefined {
  const targetLaneId =
    resolveLaneIdFromGroupFolder(event.target_folder) ?? event.target_folder;
  if (!targetLaneId) return undefined;
  const sourceLaneId =
    resolveLaneIdFromGroupFolder(event.source_group) ?? event.source_group;
  return markAndyRequestDispatchBlocked({
    requestId: event.request_id,
    sourceLaneId,
    targetLaneId,
    runId: event.run_id,
    reasonCode: event.reason_code,
    reasonText: event.reason_text,
    sessionStrategy:
      event.reason_code === 'duplicate_run_id' ? 'duplicate' : undefined,
  });
}
