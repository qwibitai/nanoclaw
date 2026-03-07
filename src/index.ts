import fs from 'fs';
import path from 'path';

import { DisconnectReason } from '@whiskeysockets/baileys';

import {
  ANDY_BUSY_ACK_COOLDOWN_MS,
  ANDY_BUSY_PREEMPT_MS,
  ANDY_ERROR_NOTICE_COOLDOWN_MS,
  ASSISTANT_NAME,
  DATA_DIR,
  ENABLE_CONTROL_PLANE_SNAPSHOTS,
  ENABLE_DYNAMIC_GROUP_REGISTRATION,
  ENABLE_SCHEDULER,
  ENABLE_WORKER_STEERING,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  RUNTIME_OWNER_HEARTBEAT_MS,
  RUNTIME_OPS_EXTENDED,
  SHUTDOWN_DRAIN_MS,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import {
  type WhatsAppChannelOpts,
  type WhatsAppCloseContext,
  WhatsAppChannel,
} from './channels/whatsapp.js';
import {
  ContainerOutput,
  DispatchBlockSnapshotEntry,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
  writeWorkerRunsSnapshot,
  WorkerRunsSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';
import {
  acceptWorkerRunCompletion,
  clearSession,
  completeWorkerRun,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getAndyRequestById,
  getLatestAndyRequestForChat,
  getMessagesSince,
  getLatestReusableWorkerSession,
  getNewMessages,
  getStoredMessage,
  getWorkerRuns,
  getWorkerRun,
  getRouterState,
  initDatabase,
  insertWorkerRun,
  getProcessedMessageIds,
  isNonRetryableWorkerStatus,
  markMessagesProcessed,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  updateWorkerRunDispatchMetadata,
  updateWorkerRunSessionMetadata,
  updateWorkerRunStatus,
} from './db.js';
import {
  type DispatchPayload,
  parseCompletionContract,
  parseDispatchPayload,
  validateDispatchPayload,
  validateCompletionContract,
} from './dispatch-validator.js';
import {
  ackAndyIntakeMessages,
  applyAndyReviewStateUpdates,
  attachAndyRequestToWorkerRun,
  buildAndyReviewTriggerMessage,
  buildAndyFrontdeskContextBlock,
  buildControlPlaneStatusSnapshot,
  completeAndyCoordinatorRequest,
  getAndyRequestsForMessages,
  handleAndyFrontdeskMessages,
  handleMainLaneControlMessages,
  isInternalWorkerLaneGroup,
  isSimpleAndyGreeting,
  markAndyRequestsCoordinatorActive,
  markAndyRequestsReviewInProgress,
  parseAndyReviewStateUpdates,
  recoverInterruptedWorkerDispatches,
  recoverPendingMessages,
  reconcileJarvisStaleWorkerRuns,
  selectWorkerSessionForDispatch,
  stripAndyReviewStateUpdates,
  syncAndyRequestWithWorkerRun,
  type WorkerSessionSelection,
} from './extensions/jarvis/index.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { emitBridgeEvent } from './event-bridge.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  buildSessionContextVersion,
  shouldInvalidateStoredSession,
} from './session-compatibility.js';
import {
  claimRuntimeOwnership,
  getCurrentRuntimeOwner,
  heartbeatRuntimeOwnership,
  isOwnedByCurrentProcess,
  logRuntimeOwnershipClaim,
  releaseRuntimeOwnership,
  RuntimeOwnershipConflictError,
} from './runtime-ownership.js';
import { startSchedulerLoop } from './task-scheduler.js';
import {
  Channel,
  isJarvisWorkerFolder,
  NewMessage,
  RegisteredGroup,
} from './types.js';
import { logger } from './logger.js';
import { WorkerRunSupervisor } from './worker-run-supervisor.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastCursor = '';
let sessions: Record<string, string> = {};
let sessionContextVersions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let inFlightAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let whatsapp: WhatsAppChannel;
const channels: Channel[] = [];
const queue = new GroupQueue();
let runtimeOwnershipHeartbeat: ReturnType<typeof setInterval> | null = null;
let shutdownPromise: Promise<void> | null = null;
const ANDY_DEVELOPER_FOLDER = 'andy-developer';
const MISSION_CORE_FOLDERS = new Set([
  MAIN_GROUP_FOLDER,
  ANDY_DEVELOPER_FOLDER,
  'jarvis-worker-1',
  'jarvis-worker-2',
]);
const ACTIVE_WORKER_RUN_STATUSES = [
  'queued',
  'running',
  'review_requested',
] as const;
const WORKER_RUN_STALE_MS = 2 * 60 * 60 * 1000;
const WORKER_QUEUED_CURSOR_GRACE_MS = 10 * 60 * 1000; // Avoid false pre-spawn stale failures during normal queueing
const WORKER_LEASE_TTL_MS = 90 * 1000;
const WORKER_RESTART_SUPPRESSION_WINDOW_MS = 60 * 1000;
const WORKER_SNAPSHOT_REFRESH_INTERVAL_MS = 15_000;
const WORKER_SUPERVISOR_OWNER = `nanoclaw-${process.pid}`;
const PROCESS_START_AT_MS = Date.now();
const PROCESS_START_AT_ISO = new Date(PROCESS_START_AT_MS).toISOString();
const MAIN_SESSION_CONTEXT_SALT = 'main-lane-context-v1';
const MAIN_SESSION_CONTEXT_FILES = [
  'groups/main/CLAUDE.md',
  'container/agent-runner/src/index.ts',
  'container/agent-runner/src/ipc-mcp-stdio.ts',
];
const andyBusyAckLastSentMs: Record<string, number> = {};
const andyRetryNoticeState: Record<
  string,
  { sentAtMs: number; signature: string }
> = {};
const workerRunSupervisor = new WorkerRunSupervisor({
  hardTimeoutMs: WORKER_RUN_STALE_MS,
  queuedCursorGraceMs: WORKER_QUEUED_CURSOR_GRACE_MS,
  leaseTtlMs: WORKER_LEASE_TTL_MS,
  processStartAtMs: PROCESS_START_AT_MS,
  restartSuppressionWindowMs: WORKER_RESTART_SUPPRESSION_WINDOW_MS,
  ownerId: WORKER_SUPERVISOR_OWNER,
});

interface WorkerRunContext {
  runId: string;
  requiredFields: string[];
  browserEvidenceRequired?: boolean;
  dispatchPayload: DispatchPayload;
}

interface RunAgentResult {
  status: 'success' | 'error';
  newSessionId?: string;
  sessionResumeStatus?: ContainerOutput['sessionResumeStatus'];
  sessionResumeError?: string;
  error?: string;
}

function isMissionCoreAllowedFolder(folder: string): boolean {
  return MISSION_CORE_FOLDERS.has(folder);
}

function isSyntheticWorkerGroup(group: RegisteredGroup): boolean {
  return isInternalWorkerLaneGroup(group);
}

function findGroupJidByFolder(
  groups: Record<string, RegisteredGroup>,
  folder: string,
): string | undefined {
  for (const [jid, group] of Object.entries(groups)) {
    if (group.folder === folder) return jid;
  }
  return undefined;
}

function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function sanitizeUserFacingOutput(
  group: RegisteredGroup,
  text: string,
): string {
  if (group.folder !== ANDY_DEVELOPER_FOLDER) return text;

  const parsed = parseDispatchPayload(stripCodeFence(text));
  if (!parsed) return text;

  const requestLabel = parsed.request_id ? ` for \`${parsed.request_id}\`` : '';
  return `Dispatched \`${parsed.run_id}\`${requestLabel} to \`${parsed.repo}\` on \`${parsed.branch}\` (${parsed.task_type}).`;
}

function timestampToMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isAfterTimestamp(candidate: string, baseline: string): boolean {
  const candidateMs = timestampToMs(candidate);
  const baselineMs = timestampToMs(baseline);
  if (candidateMs !== null && baselineMs !== null) {
    return candidateMs > baselineMs;
  }
  return candidate > baseline;
}

function getEffectiveAgentCursor(chatJid: string): string {
  const committed = lastAgentTimestamp[chatJid] || '';
  const inFlight = inFlightAgentTimestamp[chatJid] || '';
  if (!committed) return inFlight;
  if (!inFlight) return committed;
  return isAfterTimestamp(inFlight, committed) ? inFlight : committed;
}

function markCursorInFlight(chatJid: string, timestamp: string): void {
  const current = inFlightAgentTimestamp[chatJid];
  if (!current || isAfterTimestamp(timestamp, current)) {
    inFlightAgentTimestamp[chatJid] = timestamp;
  }
}

function commitCursor(chatJid: string, timestamp: string): void {
  const committed = lastAgentTimestamp[chatJid];
  if (!committed || isAfterTimestamp(timestamp, committed)) {
    lastAgentTimestamp[chatJid] = timestamp;
    saveState();
  }
}

function maxTimestamp(
  a: string | undefined,
  b: string | undefined,
): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return isAfterTimestamp(a, b) ? a : b;
}

function commitInFlightCursor(chatJid: string): void {
  const inFlight = inFlightAgentTimestamp[chatJid];
  if (!inFlight) return;
  commitCursor(chatJid, inFlight);
  delete inFlightAgentTimestamp[chatJid];
}

function clearInFlightCursor(chatJid: string): void {
  delete inFlightAgentTimestamp[chatJid];
}

function getDispatchBlocksForGroup(
  group: RegisteredGroup,
  isMain: boolean,
): DispatchBlockSnapshotEntry[] {
  const errorDir = path.join(DATA_DIR, 'ipc', 'errors');
  if (!fs.existsSync(errorDir)) return [];

  const rows: DispatchBlockSnapshotEntry[] = [];
  const files = fs
    .readdirSync(errorDir)
    .filter(
      (name) => name.startsWith('dispatch-block-') && name.endsWith('.json'),
    )
    .sort()
    .reverse();

  for (const file of files) {
    if (rows.length >= 25) break;
    try {
      const raw = fs.readFileSync(path.join(errorDir, file), 'utf-8');
      const parsed = JSON.parse(raw) as Partial<DispatchBlockSnapshotEntry> & {
        kind?: string;
      };
      if (parsed.kind !== 'dispatch_block') continue;
      if (
        !parsed.timestamp ||
        !parsed.source_group ||
        !parsed.target_jid ||
        !parsed.reason_text
      )
        continue;

      const include =
        isMain ||
        (group.folder === ANDY_DEVELOPER_FOLDER
          ? parsed.source_group === ANDY_DEVELOPER_FOLDER
          : parsed.source_group === group.folder);
      if (!include) continue;

      rows.push({
        timestamp: parsed.timestamp,
        source_group: parsed.source_group,
        target_jid: parsed.target_jid,
        target_folder: parsed.target_folder,
        reason_code: parsed.reason_code || 'unknown',
        reason_text: parsed.reason_text,
        run_id: parsed.run_id,
      });
    } catch {
      // Ignore malformed block files; they are best-effort diagnostics only.
    }
  }

  return rows;
}

function buildWorkerRunsSnapshot(
  group: RegisteredGroup,
  isMain: boolean,
): WorkerRunsSnapshot {
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
    phase: r.phase,
    started_at: r.started_at,
    completed_at: r.completed_at,
    retry_count: r.retry_count,
    result_summary: r.result_summary,
    error_details: r.error_details,
    dispatch_repo: r.dispatch_repo,
    dispatch_branch: r.dispatch_branch,
    context_intent: r.context_intent,
    parent_run_id: r.parent_run_id,
    dispatch_session_id: r.dispatch_session_id,
    selected_session_id: r.selected_session_id,
    effective_session_id: r.effective_session_id,
    session_selection_source: r.session_selection_source,
    session_resume_status: r.session_resume_status,
    session_resume_error: r.session_resume_error,
    last_heartbeat_at: r.last_heartbeat_at,
    active_container_name: r.active_container_name,
    no_container_since: r.no_container_since,
    expects_followup_container: r.expects_followup_container,
    supervisor_owner: r.supervisor_owner,
    lease_expires_at: r.lease_expires_at,
    recovered_from_reason: r.recovered_from_reason,
  }));

  const recent = getWorkerRuns({
    groupFolderLike,
    limit: 25,
  }).map((r) => ({
    run_id: r.run_id,
    group_folder: r.group_folder,
    status: r.status,
    phase: r.phase,
    started_at: r.started_at,
    completed_at: r.completed_at,
    retry_count: r.retry_count,
    result_summary: r.result_summary,
    error_details: r.error_details,
    dispatch_repo: r.dispatch_repo,
    dispatch_branch: r.dispatch_branch,
    context_intent: r.context_intent,
    parent_run_id: r.parent_run_id,
    dispatch_session_id: r.dispatch_session_id,
    selected_session_id: r.selected_session_id,
    effective_session_id: r.effective_session_id,
    session_selection_source: r.session_selection_source,
    session_resume_status: r.session_resume_status,
    session_resume_error: r.session_resume_error,
    last_heartbeat_at: r.last_heartbeat_at,
    active_container_name: r.active_container_name,
    no_container_since: r.no_container_since,
    expects_followup_container: r.expects_followup_container,
    supervisor_owner: r.supervisor_owner,
    lease_expires_at: r.lease_expires_at,
    recovered_from_reason: r.recovered_from_reason,
  }));

  const dispatchBlocks = getDispatchBlocksForGroup(group, isMain);

  return {
    generated_at: new Date().toISOString(),
    scope,
    active,
    recent,
    dispatch_blocks: dispatchBlocks,
  };
}

function buildAndyPromptWorkerContext(snapshot: WorkerRunsSnapshot): string {
  const nowMs = Date.now();
  const currentWindowMs = 60 * 60 * 1000;
  const currentWindowRuns = snapshot.recent.filter((r) => {
    const startedMs = Date.parse(r.started_at);
    return Number.isFinite(startedMs) && nowMs - startedMs <= currentWindowMs;
  });
  const currentFailures = snapshot.recent.filter((r) => {
    if (r.status !== 'failed' && r.status !== 'failed_contract') return false;
    const startedMs = Date.parse(r.started_at);
    return Number.isFinite(startedMs) && nowMs - startedMs <= currentWindowMs;
  }).length;
  const currentPasses = snapshot.recent.filter((r) => {
    if (r.status !== 'review_requested' && r.status !== 'done') return false;
    const startedMs = Date.parse(r.started_at);
    return Number.isFinite(startedMs) && nowMs - startedMs <= currentWindowMs;
  }).length;
  const currentDispatchBlocks = (snapshot.dispatch_blocks ?? []).filter(
    (entry) => {
      const ts = Date.parse(entry.timestamp);
      return Number.isFinite(ts) && nowMs - ts <= currentWindowMs;
    },
  );
  const workerLaneNames = Array.from(
    new Set(
      snapshot.recent
        .map((r) => r.group_folder)
        .filter((folder) => isJarvisWorkerFolder(folder)),
    ),
  ).sort();
  const laneSummaryLines =
    workerLaneNames.length > 0
      ? workerLaneNames
          .map((lane) => {
            const laneRuns = currentWindowRuns.filter(
              (r) => r.group_folder === lane,
            );
            const pass = laneRuns.filter(
              (r) => r.status === 'review_requested' || r.status === 'done',
            ).length;
            const fail = laneRuns.filter(
              (r) => r.status === 'failed' || r.status === 'failed_contract',
            ).length;
            const active = laneRuns.filter(
              (r) => r.status === 'queued' || r.status === 'running',
            ).length;
            return `- ${lane}: pass=${pass}, fail=${fail}, active=${active}, runs=${laneRuns.length}`;
          })
          .join('\n')
      : '- none';

  const activeLines =
    snapshot.active.length > 0
      ? snapshot.active
          .slice(0, 8)
          .map(
            (r) =>
              `- ${r.run_id} | ${r.group_folder} | ${r.status} | started ${r.started_at}`,
          )
          .join('\n')
      : '- none';

  const recentLines =
    snapshot.recent.length > 0
      ? snapshot.recent
          .slice(0, 8)
          .map((r) => {
            const when = r.completed_at ?? r.started_at;
            const summary = r.result_summary || r.error_details || '-';
            return `- ${r.run_id} | ${r.group_folder} | ${r.status} | ${when} | ${summary}`;
          })
          .join('\n')
      : '- none';
  const blockLines =
    currentDispatchBlocks.length > 0
      ? currentDispatchBlocks
          .slice(0, 8)
          .map((entry) => {
            const runId = entry.run_id ? ` | run_id=${entry.run_id}` : '';
            return `- ${entry.timestamp} | ${entry.source_group} -> ${entry.target_jid} | ${entry.reason_code}${runId} | ${entry.reason_text}`;
          })
          .join('\n')
      : '- none';
  const sessionLedgerLines =
    snapshot.recent.length > 0
      ? snapshot.recent
          .filter((r) => isJarvisWorkerFolder(r.group_folder))
          .slice(0, 8)
          .map((r) => {
            const repo = r.dispatch_repo || '-';
            const branch = r.dispatch_branch || '-';
            const intent = r.context_intent || '-';
            const selected = r.selected_session_id || '-';
            const effective = r.effective_session_id || '-';
            const source = r.session_selection_source || '-';
            const resume = r.session_resume_status || '-';
            const phase = r.phase || '-';
            const heartbeat = r.last_heartbeat_at || '-';
            const noContainer = r.no_container_since || '-';
            const followup = r.expects_followup_container === 1 ? 'yes' : 'no';
            return `- ${r.run_id} | ${r.group_folder} | ${repo}#${branch} | intent=${intent} | phase=${phase} | selected=${selected} | effective=${effective} | source=${source} | resume=${resume} | heartbeat=${heartbeat} | no_container_since=${noContainer} | expects_followup=${followup}`;
          })
          .join('\n')
      : '- none';

  return [
    '<worker_status_source_of_truth>',
    `generated_at: ${snapshot.generated_at}`,
    `now: ${new Date(nowMs).toISOString()}`,
    'Use this DB snapshot as the single source of truth when answering status/queue questions.',
    'Classify issues older than 60 minutes as historical unless there are fresh failures in the current window.',
    `Current-window (last 60m): passes=${currentPasses}, failures=${currentFailures}`,
    `Current-window dispatch policy blocks (last 60m): ${currentDispatchBlocks.length}`,
    'Important: for non-main lanes (including andy-developer), available_groups.json intentionally contains groups=[] and cannot be used as worker connectivity evidence.',
    'Do not claim a specific worker lane is broken without at least one failure in that lane in the last 60 minutes.',
    'If a worker lane has no runs in the current window, report it as unknown/no recent evidence.',
    'If dispatch policy blocks exist, report this as policy-blocked dispatch (not worker disconnection).',
    'Current-window worker lane summary:',
    laneSummaryLines,
    'Do not rely on memory for queued/running/completed worker state.',
    'Recent dispatch policy blocks:',
    blockLines,
    'Active worker runs:',
    activeLines,
    'Recent worker session ledger:',
    sessionLedgerLines,
    'Recent worker runs:',
    recentLines,
    '</worker_status_source_of_truth>',
  ].join('\n');
}

function refreshWorkerRunSnapshotsForGroups(folders?: string[]): void {
  if (!ENABLE_CONTROL_PLANE_SNAPSHOTS) return;

  const seen = new Set<string>();
  const targets: RegisteredGroup[] = [];

  for (const group of Object.values(registeredGroups)) {
    if (seen.has(group.folder)) continue;
    seen.add(group.folder);
    targets.push(group);
  }

  for (const group of targets) {
    if (folders && !folders.includes(group.folder)) continue;
    const isMain = group.folder === MAIN_GROUP_FOLDER;
    const snapshot = buildWorkerRunsSnapshot(group, isMain);
    writeWorkerRunsSnapshot(group.folder, snapshot);
  }
}

function writeMainControlPlaneStatusSnapshot(): void {
  if (!ENABLE_CONTROL_PLANE_SNAPSHOTS) return;

  const snapshot = buildControlPlaneStatusSnapshot({
    registeredGroups,
    queue,
  });
  const groupIpcDir = resolveGroupIpcPath(MAIN_GROUP_FOLDER);
  fs.mkdirSync(groupIpcDir, { recursive: true });
  fs.writeFileSync(
    path.join(groupIpcDir, 'control_plane_status.json'),
    JSON.stringify(snapshot, null, 2),
  );
}

function enqueueAndyReviewTrigger(input: {
  runId: string;
  dispatchPayload: DispatchPayload;
  workerGroupFolder: string;
  completion: {
    branch: string;
    commit_sha: string;
    test_result: string;
    risk: string;
    pr_url?: string | null;
    pr_skipped_reason?: string | null;
  };
  effectiveSessionId?: string | null;
}): void {
  const requestId = input.dispatchPayload.request_id?.trim();
  if (!requestId) return;

  const andyJid = findGroupJidByFolder(registeredGroups, ANDY_DEVELOPER_FOLDER);
  if (!andyJid) return;

  const timestamp = new Date().toISOString();
  const message = buildAndyReviewTriggerMessage({
    chatJid: andyJid,
    timestamp,
    payload: {
      request_id: requestId,
      run_id: input.runId,
      repo: input.dispatchPayload.repo,
      branch: input.completion.branch,
      worker_group_folder: input.workerGroupFolder,
      summary: `Worker run ${input.runId} completed and needs Andy review.`,
      session_id: input.effectiveSessionId ?? null,
      parent_run_id: input.dispatchPayload.parent_run_id ?? null,
      commit_sha: input.completion.commit_sha,
      test_result: input.completion.test_result,
      risk: input.completion.risk,
      pr_url: input.completion.pr_url ?? null,
      pr_skipped_reason: input.completion.pr_skipped_reason ?? null,
    },
  });

  storeChatMetadata(
    andyJid,
    timestamp,
    registeredGroups[andyJid]?.name ?? 'Andy Developer',
    'nanoclaw',
    true,
  );

  if (!getStoredMessage(andyJid, message.id)) {
    storeMessage(message);
  }
  queue.enqueueMessageCheck(andyJid);
}

function extractWorkerRunContext(
  group: RegisteredGroup,
  messages: NewMessage[],
): WorkerRunContext | null {
  if (!isJarvisWorkerFolder(group.folder)) return null;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const payload = parseDispatchPayload(messages[i].content);
    if (!payload) continue;
    const validity = validateDispatchPayload(payload);
    if (!validity.valid) continue;
    return {
      runId: payload.run_id,
      requiredFields: payload.output_contract.required_fields,
      browserEvidenceRequired:
        payload.output_contract.browser_evidence_required,
      dispatchPayload: payload,
    };
  }

  return null;
}

function buildWorkerDispatchPrompt(payload: DispatchPayload): string {
  const acceptanceTests = payload.acceptance_tests
    .map((test, idx) => `${idx + 1}. ${test}`)
    .join('\n');
  const requiredFields = payload.output_contract.required_fields
    .map((field) => `- ${field}`)
    .join('\n');
  const sessionFieldRule = payload.output_contract.required_fields.includes(
    'session_id',
  )
    ? '- REQUIRED: include "session_id": "<current-session-id>" in completion output.'
    : '- OPTIONAL: include "session_id": "<current-session-id>" to help follow-up dispatch continuity.';

  return [
    'You are a Jarvis worker.',
    'Execute exactly one dispatch task and return a strict completion contract.',
    `Run ID: ${payload.run_id}`,
    `Request ID: ${payload.request_id ?? 'n/a'}`,
    `Task Type: ${payload.task_type}`,
    `Repository: ${payload.repo}`,
    `Branch: ${payload.branch}`,
    `Priority: ${payload.priority ?? 'normal'}`,
    `UI impacting: ${payload.ui_impacting === true ? 'true' : 'false'}`,
    `Browser evidence required: ${payload.output_contract.browser_evidence_required === true ? 'true' : 'false'}`,
    '',
    'CRITICAL: Container lifecycle - this container will EXIT after completing this task.',
    '- The container runs once and shuts down when done.',
    sessionFieldRule,
    '- Andy will pass this session_id to the next worker to continue the conversation.',
    '',
    'Task instructions:',
    payload.input,
    '',
    'Acceptance tests (all required):',
    acceptanceTests,
    '',
    'Completion output rules (strict):',
    '- Return exactly one <completion>...</completion> block.',
    '- The block body must be valid JSON.',
    '- Do not include markdown fences.',
    '- Do not include narrative text before or after the <completion> block.',
    '- Execute commands from /workspace/group only; do not use /workspace/extra or other external directories.',
    `- completion.run_id must exactly equal "${payload.run_id}".`,
    `- completion.branch must exactly equal "${payload.branch}".`,
    '- completion.commit_sha must be a real 6-40 char git SHA from the checked-out branch.',
    '- Only no-code runs with run_id prefix ping-/smoke-/health-/sync- may use commit_sha placeholder n/a/none and empty files_changed.',
    '- files_changed must be a JSON array of changed file paths.',
    '- OPTIONAL: Add "session_id": "<session-id>" if you want follow-up tasks to continue this session.',
    '',
    'Required completion fields:',
    requiredFields,
  ].join('\n');
}

function buildWorkerCompletionRepairPrompt(
  runId: string,
  expectedBranch: string,
  requiredFields: string[],
  missingFields: string[],
  outputBuffer: string,
): string {
  const requiredList = requiredFields.map((field) => `- ${field}`).join('\n');
  const missingList =
    missingFields.length > 0
      ? missingFields.map((field) => `- ${field}`).join('\n')
      : '- unknown';
  const excerpt = outputBuffer.slice(-1600);

  return [
    'Your previous response did not satisfy the required completion contract.',
    `Run ID: ${runId}`,
    '',
    'Missing or invalid fields:',
    missingList,
    '',
    'Required fields:',
    requiredList,
    '',
    'Re-emit exactly one corrected <completion>...</completion> block.',
    'Rules:',
    '- Do not call tools.',
    '- Do not run commands.',
    '- Do not include analysis or prose before/after the completion block.',
    '- completion.run_id must exactly match the run ID above.',
    `- completion.branch must exactly equal "${expectedBranch}".`,
    '- completion.commit_sha must be a valid 6-40 char hex SHA (or n/a/none only for ping-/smoke-/health-/sync- no-code runs).',
    '- files_changed must be a JSON array of strings.',
    '',
    'Previous output excerpt (for correction only):',
    excerpt,
  ].join('\n');
}

function selectMessagesForExecution(
  group: RegisteredGroup,
  messages: NewMessage[],
): NewMessage[] {
  if (!isJarvisWorkerFolder(group.folder) || messages.length <= 1) {
    return messages;
  }

  for (const msg of messages) {
    const payload = parseDispatchPayload(msg.content);
    if (!payload) continue;
    const validity = validateDispatchPayload(payload);
    if (validity.valid) {
      // Worker lanes must process one canonical dispatch at a time.
      return [msg];
    }
  }

  return messages;
}

function markBatchProcessed(
  chatJid: string,
  messages: Array<{ id: string }>,
  runId?: string,
): void {
  markMessagesProcessed(
    chatJid,
    messages.map((m) => m.id),
    runId,
  );
}

function shouldAllowNoCodeCompletion(runId: string): boolean {
  return /^(ping|smoke|health|sync)-/i.test(runId);
}

function reconcileStaleWorkerRuns(): void {
  const changed = reconcileJarvisStaleWorkerRuns({
    workerRunSupervisor,
    lastAgentTimestamp,
    registeredGroups,
  });
  if (changed && ENABLE_CONTROL_PLANE_SNAPSHOTS) {
    refreshWorkerRunSnapshotsForGroups();
  }
}

function loadState(): void {
  lastCursor = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  const sessionContextState = getRouterState('session_context_versions');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  try {
    sessionContextVersions = sessionContextState
      ? JSON.parse(sessionContextState)
      : {};
  } catch {
    logger.warn('Corrupted session_context_versions in DB, resetting');
    sessionContextVersions = {};
  }
  inFlightAgentTimestamp = {};
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  if (!RUNTIME_OPS_EXTENDED) {
    registeredGroups = Object.fromEntries(
      Object.entries(registeredGroups).filter(([, group]) =>
        isMissionCoreAllowedFolder(group.folder),
      ),
    );
  }
  reconcileStaleWorkerRuns();
  logger.info(
    {
      groupCount: Object.keys(registeredGroups).length,
      runtimeProfile: RUNTIME_OPS_EXTENDED ? 'ops_extended' : 'mission_core',
    },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastCursor);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
  setRouterState(
    'session_context_versions',
    JSON.stringify(sessionContextVersions),
  );
}

function getMainSessionContextVersion(): string {
  const entries = MAIN_SESSION_CONTEXT_FILES.map((relativePath) => {
    const absolutePath = path.join(process.cwd(), relativePath);
    let content = '__missing__';
    try {
      content = fs.readFileSync(absolutePath, 'utf-8');
    } catch {
      // Keep a deterministic marker if the file is unavailable.
    }
    return { path: relativePath, content };
  });

  return buildSessionContextVersion({
    salt: MAIN_SESSION_CONTEXT_SALT,
    entries,
  });
}

function getSessionContextVersionForGroup(
  group: RegisteredGroup,
  isMain: boolean,
): string | undefined {
  if (!isMain || group.folder !== MAIN_GROUP_FOLDER) return undefined;
  return getMainSessionContextVersion();
}

function setSessionContextVersion(
  groupFolder: string,
  version: string | undefined,
): void {
  if (!version) return;
  sessionContextVersions[groupFolder] = version;
  saveState();
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  if (!ENABLE_DYNAMIC_GROUP_REGISTRATION) {
    logger.warn(
      { jid, folder: group.folder },
      'Dynamic group registration is disabled in mission-core profile',
    );
    return;
  }

  if (!RUNTIME_OPS_EXTENDED && !isMissionCoreAllowedFolder(group.folder)) {
    logger.warn(
      { jid, folder: group.folder },
      'Rejecting group registration outside mission-core lane allowlist',
    );
    return;
  }

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
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
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

  const sinceTimestamp = getEffectiveAgentCursor(chatJid);
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;
  const selectedMessages = selectMessagesForExecution(group, missedMessages);

  // Per-message idempotency: skip messages already processed (defense against cursor rollback replays)
  const alreadyProcessed = getProcessedMessageIds(
    chatJid,
    selectedMessages.map((m) => m.id),
  );
  const messagesToProcess = selectedMessages.filter(
    (m) => !alreadyProcessed.has(m.id),
  );
  if (messagesToProcess.length === 0) {
    // All messages already processed — advance cursor without re-running agent
    const advanceTimestamp =
      selectedMessages[selectedMessages.length - 1].timestamp;
    markCursorInFlight(chatJid, advanceTimestamp);
    commitInFlightCursor(chatJid);
    logger.debug(
      { group: group.name, skippedCount: selectedMessages.length },
      'All messages already processed (idempotency), advancing cursor',
    );
    return true;
  }
  const batchLastTimestamp =
    messagesToProcess[messagesToProcess.length - 1].timestamp;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = messagesToProcess.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }
  if (
    channel &&
    isMainGroup &&
    (await handleMainLaneControlMessages({
      chatJid,
      group,
      messages: messagesToProcess,
      channel,
      queue,
      registeredGroups,
      runtime: {
        markCursorInFlight,
        clearInFlightCursor,
        markBatchProcessed,
        commitInFlightCursor,
      },
    }))
  ) {
    return true;
  }

  if (
    channel &&
    (await handleAndyFrontdeskMessages({
      chatJid,
      group,
      messages: messagesToProcess,
      channel,
      runtime: {
        markCursorInFlight,
        clearInFlightCursor,
        markBatchProcessed,
        commitInFlightCursor,
      },
    }))
  ) {
    return true;
  }

  const andyRequestsInBatch =
    group.folder === ANDY_DEVELOPER_FOLDER
      ? getAndyRequestsForMessages(messagesToProcess)
      : [];
  if (andyRequestsInBatch.length > 0) {
    const coordinatorText =
      messagesToProcess.length > 1
        ? `Coordinator picked up ${messagesToProcess.length} pending message(s)`
        : 'Coordinator is processing your request';
    markAndyRequestsCoordinatorActive(andyRequestsInBatch, coordinatorText);
    markAndyRequestsReviewInProgress(
      andyRequestsInBatch,
      'Andy is reviewing worker completion artifacts',
    );
  }
  const activeAndyRequestId = andyRequestsInBatch[0]?.requestId;

  const workerRun = extractWorkerRunContext(group, messagesToProcess);
  const basePrompt = workerRun
    ? buildWorkerDispatchPrompt(workerRun.dispatchPayload)
    : formatMessages(messagesToProcess, TIMEZONE);
  const prompt =
    !workerRun && group.folder === ANDY_DEVELOPER_FOLDER && activeAndyRequestId
      ? `${buildAndyFrontdeskContextBlock(chatJid, activeAndyRequestId)}\n\n${basePrompt}`
      : basePrompt;
  let workerOutputBuffer = '';

  let workerSessionSelection: WorkerSessionSelection | null = null;
  let runtimeEffectiveSessionId: string | undefined;
  let runtimeSessionResumeStatus: ContainerOutput['sessionResumeStatus'];
  let runtimeSessionResumeError: string | undefined;
  let workerRunMarkedRunning = false;
  let workerSpawnContainerName: string | undefined;

  if (workerRun) {
    const existingRun = getWorkerRun(workerRun.runId);
    // IPC pre-queues andy-developer dispatches as status=queued before the
    // worker lane consumes the message. Allow that first execution pass.
    if (
      existingRun &&
      existingRun.status !== 'queued' &&
      isNonRetryableWorkerStatus(existingRun.status)
    ) {
      markCursorInFlight(chatJid, batchLastTimestamp);
      commitInFlightCursor(chatJid);
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

    workerSessionSelection = selectWorkerSessionForDispatch(
      group.folder,
      workerRun.dispatchPayload,
    );
    if (!workerSessionSelection) {
      const queueState = insertWorkerRun(workerRun.runId, group.folder, {
        dispatch_repo: workerRun.dispatchPayload.repo,
        dispatch_branch: workerRun.dispatchPayload.branch,
        request_id: workerRun.dispatchPayload.request_id,
        context_intent: workerRun.dispatchPayload.context_intent,
        dispatch_payload: JSON.stringify(workerRun.dispatchPayload),
        parent_run_id: workerRun.dispatchPayload.parent_run_id,
        dispatch_session_id: workerRun.dispatchPayload.session_id,
      });
      if (queueState !== 'duplicate') {
        syncAndyRequestWithWorkerRun(
          workerRun.runId,
          'failed',
          'Dispatch requires existing session context, but no reusable session was found',
        );
        completeWorkerRun(
          workerRun.runId,
          'failed_contract',
          'dispatch requires existing session context, but no reusable session was found',
          JSON.stringify({
            reason: 'missing_reusable_session',
            repo: workerRun.dispatchPayload.repo,
            branch: workerRun.dispatchPayload.branch,
            context_intent: workerRun.dispatchPayload.context_intent,
          }),
        );
      }
      markCursorInFlight(chatJid, batchLastTimestamp);
      commitInFlightCursor(chatJid);
      refreshWorkerRunSnapshotsForGroups();
      logger.warn(
        {
          runId: workerRun.runId,
          group: group.name,
          repo: workerRun.dispatchPayload.repo,
          branch: workerRun.dispatchPayload.branch,
        },
        'Worker dispatch blocked during execution due to missing reusable session',
      );
      return true;
    }

    runtimeEffectiveSessionId = workerSessionSelection.selectedSessionId;
    const dispatchMetadata = {
      dispatch_repo: workerRun.dispatchPayload.repo,
      dispatch_branch: workerRun.dispatchPayload.branch,
      request_id: workerRun.dispatchPayload.request_id,
      context_intent: workerRun.dispatchPayload.context_intent,
      dispatch_payload: JSON.stringify(workerRun.dispatchPayload),
      parent_run_id: workerRun.dispatchPayload.parent_run_id,
      dispatch_session_id: workerRun.dispatchPayload.session_id,
      selected_session_id: workerSessionSelection.selectedSessionId,
      session_selection_source: workerSessionSelection.source,
    } as const;

    if (
      !existingRun ||
      existingRun.status === 'failed' ||
      existingRun.status === 'failed_contract'
    ) {
      const insertState = insertWorkerRun(
        workerRun.runId,
        group.folder,
        dispatchMetadata,
      );
      if (insertState === 'duplicate') {
        markCursorInFlight(chatJid, batchLastTimestamp);
        commitInFlightCursor(chatJid);
        logger.warn(
          { runId: workerRun.runId, group: group.name },
          'Duplicate worker run blocked before execution',
        );
        return true;
      }
      logger.info(
        {
          runId: workerRun.runId,
          queueState: insertState,
          group: group.name,
          sessionSelection: workerSessionSelection.source,
          selectedSessionId: workerSessionSelection.selectedSessionId,
        },
        'Worker run queued from worker chat context',
      );
      void emitBridgeEvent({
        event_type: 'worker_queued',
        summary: `[andy-dev] → queued ${workerRun.dispatchPayload.task_type || 'task'} (run: ${workerRun.runId.slice(0, 8)})`,
        metadata: {
          agent: 'andy-developer',
          tier: 'andy-developer',
          run_id: workerRun.runId,
          group_folder: group.folder,
        },
      });
      syncAndyRequestWithWorkerRun(
        workerRun.runId,
        'worker_queued',
        `Worker run ${workerRun.runId} queued on ${group.folder}`,
      );
      workerRunSupervisor.markQueued(workerRun.runId);
    } else {
      updateWorkerRunDispatchMetadata(workerRun.runId, dispatchMetadata);
    }

    if (workerRun.dispatchPayload.request_id) {
      attachAndyRequestToWorkerRun(
        workerRun.dispatchPayload.request_id,
        workerRun.runId,
        group.folder,
      );
    }
  }

  // Track messages currently being handled by this run without committing the
  // durable cursor. This prevents duplicate piping while preserving crash safety.
  markCursorInFlight(chatJid, batchLastTimestamp);

  logger.info(
    { group: group.name, messageCount: messagesToProcess.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const idleTimeoutMs = group.containerConfig?.idleTimeout || IDLE_TIMEOUT;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, idleTimeoutMs);
  };

  await channel?.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let outputAckCursor: string | undefined;

  const sessionOverride = workerSessionSelection
    ? (workerSessionSelection.selectedSessionId ?? null)
    : undefined;
  const onSpawn = workerRun
    ? (containerName: string) => {
        if (workerRunMarkedRunning) return;
        workerRunMarkedRunning = true;
        workerSpawnContainerName = containerName;
        workerRunSupervisor.markSpawnStarted(
          workerRun.runId,
          containerName,
          'active',
        );
        updateWorkerRunStatus(workerRun.runId, 'running');
        syncAndyRequestWithWorkerRun(
          workerRun.runId,
          'worker_running',
          `Worker started on ${group.folder} (run ${workerRun.runId})`,
        );
        void emitBridgeEvent({
          event_type: 'worker_started',
          summary: `[${group.folder}] started (run: ${workerRun.runId.slice(0, 8)})`,
          metadata: {
            agent: group.folder,
            tier: 'worker',
            run_id: workerRun.runId,
            group_folder: group.folder,
          },
        });
        refreshWorkerRunSnapshotsForGroups();
        logger.info(
          { runId: workerRun.runId, group: group.name, containerName },
          'Worker run marked running after container spawn',
        );
      }
    : undefined;
  const runOutcome = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      if (workerRun) {
        workerRunSupervisor.markHeartbeat(workerRun.runId);
      }
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        if (workerRun) {
          workerOutputBuffer += `${raw}\n`;
        }
        let cleaned = raw;
        if (group.folder === ANDY_DEVELOPER_FOLDER) {
          const reviewStateUpdates = parseAndyReviewStateUpdates(raw);
          if (reviewStateUpdates.length > 0) {
            applyAndyReviewStateUpdates(reviewStateUpdates);
            cleaned = stripAndyReviewStateUpdates(cleaned);
          }
        }
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = cleaned
          .replace(/<internal>[\s\S]*?<\/internal>/g, '')
          .trim();
        logger.info(
          { group: group.name },
          `Agent output: ${raw.slice(0, 200)}`,
        );
        if (text) {
          const outboundText = sanitizeUserFacingOutput(group, text);
          if (outboundText && channel) {
            await channel.sendMessage(chatJid, outboundText);
            outputSentToUser = true;
            outputAckCursor = maxTimestamp(
              outputAckCursor,
              inFlightAgentTimestamp[chatJid] || batchLastTimestamp,
            );
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
    },
    sessionOverride,
    onSpawn,
    workerRun?.runId,
  );

  const workerSpawnFailedBeforeRunning =
    !!workerRun &&
    (runOutcome.status === 'error' || hadError) &&
    !workerRunMarkedRunning;

  if (runOutcome.newSessionId) {
    runtimeEffectiveSessionId = runOutcome.newSessionId;
  }
  if (runOutcome.sessionResumeStatus) {
    runtimeSessionResumeStatus = runOutcome.sessionResumeStatus;
  }
  if (runOutcome.sessionResumeError) {
    runtimeSessionResumeError = runOutcome.sessionResumeError;
  }

  await channel?.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);
  if (workerRun && workerRunMarkedRunning) {
    workerRunSupervisor.markContainerExited(
      workerRun.runId,
      'completion_validating',
    );
  }

  if (workerRun) {
    let completion = parseCompletionContract(workerOutputBuffer);
    let completionCheck = validateCompletionContract(completion, {
      expectedRunId: workerRun.runId,
      expectedBranch: workerRun.dispatchPayload.branch,
      requiredFields: workerRun.requiredFields,
      browserEvidenceRequired: workerRun.browserEvidenceRequired,
      allowNoCodeChanges: shouldAllowNoCodeCompletion(workerRun.runId),
    });

    if (!completionCheck.valid && runOutcome.status !== 'error' && !hadError) {
      workerRunSupervisor.markRepairPending(workerRun.runId);
      const repairPrompt = buildWorkerCompletionRepairPrompt(
        workerRun.runId,
        workerRun.dispatchPayload.branch,
        workerRun.requiredFields,
        completionCheck.missing,
        workerOutputBuffer,
      );

      let repairBuffer = '';
      let repairHadError = false;
      let repairSpawned = false;
      const repairSessionOverride = runtimeEffectiveSessionId
        ? runtimeEffectiveSessionId
        : (workerSessionSelection?.selectedSessionId ?? null);
      const repairOutcome = await runAgent(
        group,
        repairPrompt,
        chatJid,
        async (result) => {
          workerRunSupervisor.markHeartbeat(workerRun.runId);
          if (result.result) {
            const raw =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
            repairBuffer += `${raw}\n`;
          }
          if (result.status === 'error') {
            repairHadError = true;
          }
        },
        repairSessionOverride,
        (containerName: string) => {
          repairSpawned = true;
          workerRunSupervisor.markSpawnStarted(
            workerRun.runId,
            containerName,
            'completion_repair_active',
          );
        },
        workerRun.runId,
      );
      if (repairSpawned) {
        workerRunSupervisor.markContainerExited(workerRun.runId, 'finalizing');
      }

      if (repairOutcome.newSessionId) {
        runtimeEffectiveSessionId = repairOutcome.newSessionId;
      }
      if (repairOutcome.sessionResumeStatus) {
        runtimeSessionResumeStatus = repairOutcome.sessionResumeStatus;
      }
      if (repairOutcome.sessionResumeError) {
        runtimeSessionResumeError = repairOutcome.sessionResumeError;
      }

      if (repairOutcome.status === 'error' || repairHadError) {
        hadError = true;
      }

      if (repairBuffer.trim()) {
        workerOutputBuffer += `\n${repairBuffer}`;
        completion = parseCompletionContract(workerOutputBuffer);
        completionCheck = validateCompletionContract(completion, {
          expectedRunId: workerRun.runId,
          expectedBranch: workerRun.dispatchPayload.branch,
          requiredFields: workerRun.requiredFields,
          browserEvidenceRequired: workerRun.browserEvidenceRequired,
          allowNoCodeChanges: shouldAllowNoCodeCompletion(workerRun.runId),
        });
      }

      logger.info(
        {
          runId: workerRun.runId,
          group: group.name,
          repaired: completionCheck.valid,
          missingAfterRepair: completionCheck.missing,
        },
        'Worker completion repair attempted',
      );
    }
    workerRunSupervisor.markFinalizing(workerRun.runId);

    const completionSessionId = completion?.session_id?.trim();
    if (completionSessionId) {
      runtimeEffectiveSessionId = completionSessionId;
      sessions[group.folder] = completionSessionId;
      setSession(group.folder, completionSessionId);
    }

    if (
      runtimeEffectiveSessionId !== undefined ||
      runtimeSessionResumeStatus !== undefined ||
      runtimeSessionResumeError !== undefined
    ) {
      updateWorkerRunSessionMetadata(workerRun.runId, {
        effective_session_id: runtimeEffectiveSessionId ?? null,
        session_resume_status: runtimeSessionResumeStatus ?? null,
        session_resume_error: runtimeSessionResumeError ?? null,
      });
    }

    if (completion && completionCheck.valid) {
      const accepted = acceptWorkerRunCompletion(workerRun.runId, {
        branch_name: completion.branch,
        pr_url: completion.pr_url,
        commit_sha: completion.commit_sha,
        files_changed: completion.files_changed,
        test_summary: completion.test_result,
        risk_summary: completion.risk,
        effective_session_id: runtimeEffectiveSessionId ?? null,
        session_resume_status: runtimeSessionResumeStatus ?? null,
        session_resume_error: runtimeSessionResumeError ?? null,
      });
      if (accepted.ok) {
        if (accepted.recovered) {
          logger.info(
            { runId: workerRun.runId, group: group.name },
            'Recovered worker run from terminal failure before completion accept',
          );
        }
        syncAndyRequestWithWorkerRun(
          workerRun.runId,
          'worker_review_requested',
          `Worker run ${workerRun.runId} reached review_requested on ${group.folder}`,
        );
        enqueueAndyReviewTrigger({
          runId: workerRun.runId,
          dispatchPayload: workerRun.dispatchPayload,
          workerGroupFolder: group.folder,
          completion,
          effectiveSessionId: runtimeEffectiveSessionId ?? null,
        });
        void emitBridgeEvent({
          event_type: 'worker_completed',
          summary: `[${group.folder}] ✓ review: ${completion.branch}`,
          metadata: {
            agent: group.folder,
            tier: 'worker',
            run_id: workerRun.runId,
            group_folder: group.folder,
          },
        });
        workerRunSupervisor.markTerminal(workerRun.runId);
        refreshWorkerRunSnapshotsForGroups();
        logger.info(
          { runId: workerRun.runId, group: group.name },
          'Worker completion contract accepted',
        );
      } else {
        logger.warn(
          { runId: workerRun.runId, group: group.name },
          'Completion accept rejected by atomic transaction — marking failed_contract',
        );
        syncAndyRequestWithWorkerRun(
          workerRun.runId,
          'failed',
          `Completion accept rejected for run ${workerRun.runId}`,
        );
        completeWorkerRun(
          workerRun.runId,
          'failed_contract',
          'Completion accept rejected',
          JSON.stringify({ reason: 'completion_accept_rejected' }),
        );
        void emitBridgeEvent({
          event_type: 'worker_failed',
          summary: `[${group.folder}] ✗ contract: completion accept rejected`,
          metadata: {
            agent: group.folder,
            tier: 'worker',
            run_id: workerRun.runId,
            group_folder: group.folder,
          },
        });
        workerRunSupervisor.markTerminal(workerRun.runId);
        refreshWorkerRunSnapshotsForGroups();
      }
    } else if (runOutcome.status === 'error' || hadError) {
      if (workerSpawnFailedBeforeRunning) {
        syncAndyRequestWithWorkerRun(
          workerRun.runId,
          'failed',
          `Worker failed before running state for ${workerRun.runId}`,
        );
        completeWorkerRun(
          workerRun.runId,
          'failed',
          'Worker container failed before running state could be established',
          JSON.stringify({
            reason: 'container_spawn_failed_before_running',
            output_status: runOutcome.status,
            output_error: runOutcome.error,
            had_error: hadError,
            container_name: workerSpawnContainerName ?? null,
            output_excerpt: workerOutputBuffer.slice(0, 2000),
          }),
        );
        void emitBridgeEvent({
          event_type: 'worker_failed',
          summary: `[${group.folder}] ✗ container spawn failed`,
          metadata: {
            agent: group.folder,
            tier: 'worker',
            run_id: workerRun.runId,
            group_folder: group.folder,
          },
        });
        logger.warn(
          {
            runId: workerRun.runId,
            group: group.name,
            outputError: runOutcome.error,
          },
          'Worker run failed before running state',
        );
        workerRunSupervisor.markTerminal(workerRun.runId);
      } else {
        const missingSummary = completionCheck.missing.join(', ');
        syncAndyRequestWithWorkerRun(
          workerRun.runId,
          'failed',
          missingSummary
            ? `Worker execution failed; missing ${missingSummary}`
            : `Worker execution failed for ${workerRun.runId}`,
        );
        completeWorkerRun(
          workerRun.runId,
          'failed',
          missingSummary
            ? `Worker execution failed; missing: ${missingSummary}`
            : 'worker execution failed',
          JSON.stringify({
            reason: 'worker execution failed',
            missing: completionCheck.missing,
            output_status: runOutcome.status,
            output_error: runOutcome.error,
            had_error: hadError,
            output_excerpt: workerOutputBuffer.slice(0, 2000),
          }),
        );
        void emitBridgeEvent({
          event_type: 'worker_failed',
          summary: `[${group.folder}] ✗ ${missingSummary ? `missing: ${missingSummary.slice(0, 80)}` : 'execution failed'}`,
          metadata: {
            agent: group.folder,
            tier: 'worker',
            run_id: workerRun.runId,
            group_folder: group.folder,
          },
        });
        logger.warn(
          {
            runId: workerRun.runId,
            group: group.name,
            missing: completionCheck.missing,
          },
          'Worker run marked failed',
        );
        workerRunSupervisor.markTerminal(workerRun.runId);
      }
      refreshWorkerRunSnapshotsForGroups();
    } else {
      const missingSummary = completionCheck.missing.join(', ');
      syncAndyRequestWithWorkerRun(
        workerRun.runId,
        'failed',
        missingSummary
          ? `Completion contract missing fields: ${missingSummary}`
          : `Invalid completion contract for ${workerRun.runId}`,
      );
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
      void emitBridgeEvent({
        event_type: 'worker_failed',
        summary: `[${group.folder}] ✗ contract: ${missingSummary ? missingSummary.slice(0, 80) : 'invalid completion'}`,
        metadata: {
          agent: group.folder,
          tier: 'worker',
          run_id: workerRun.runId,
          group_folder: group.folder,
        },
      });
      logger.warn(
        {
          runId: workerRun.runId,
          group: group.name,
          missing: completionCheck.missing,
        },
        'Worker run marked failed_contract',
      );
      workerRunSupervisor.markTerminal(workerRun.runId);
      refreshWorkerRunSnapshotsForGroups();
    }
  }

  if (!workerRun && andyRequestsInBatch.length > 0) {
    const coordinatorSessionId =
      runOutcome.newSessionId ?? sessions[group.folder] ?? null;
    for (const request of andyRequestsInBatch) {
      completeAndyCoordinatorRequest({
        requestId: request.requestId,
        coordinatorSessionId,
        runFailed: runOutcome.status === 'error' || hadError,
        errorText: runOutcome.error,
      });
    }
  }

  if (runOutcome.status === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      // Mark as processed and commit through the latest cursor that already produced output.
      markBatchProcessed(chatJid, messagesToProcess, workerRun?.runId);
      commitCursor(chatJid, outputAckCursor || batchLastTimestamp);
      clearInFlightCursor(chatJid);
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Keep durable cursor unchanged so retries can re-process these messages.
    clearInFlightCursor(chatJid);
    logger.warn(
      { group: group.name },
      'Agent error, left durable cursor unchanged for retry',
    );
    return false;
  }

  // Mark all messages as processed (idempotency guard against future cursor rollbacks)
  markBatchProcessed(chatJid, messagesToProcess, workerRun?.runId);
  commitInFlightCursor(chatJid);

  const pendingAfter = getMessagesSince(
    chatJid,
    lastAgentTimestamp[chatJid] || '',
    ASSISTANT_NAME,
  );
  if (pendingAfter.length > 0) {
    logger.debug(
      { group: group.name, pendingCount: pendingAfter.length },
      'Pending messages remain after processing, enqueueing follow-up run',
    );
    queue.enqueueMessageCheck(chatJid);
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  sessionOverride?: string | null,
  onSpawn?: (containerName: string) => void,
  workerRunId?: string,
): Promise<RunAgentResult> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  let sessionId =
    sessionOverride === undefined
      ? sessions[group.folder]
      : (sessionOverride ?? undefined);
  const sessionContextVersion = getSessionContextVersionForGroup(group, isMain);
  if (
    shouldInvalidateStoredSession({
      sessionId,
      storedVersion: sessionContextVersions[group.folder],
      currentVersion: sessionContextVersion,
    })
  ) {
    logger.info(
      {
        group: group.name,
        groupFolder: group.folder,
        storedVersion: sessionContextVersions[group.folder],
        currentVersion: sessionContextVersion,
      },
      'Invalidating stored session because the session context changed',
    );
    delete sessions[group.folder];
    clearSession(group.folder);
    sessionId = undefined;
  }
  if (sessionId) {
    sessions[group.folder] = sessionId;
    setSession(group.folder, sessionId);
  }

  let workerRunsSnapshot: WorkerRunsSnapshot | null = null;
  if (ENABLE_CONTROL_PLANE_SNAPSHOTS) {
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

    workerRunsSnapshot = buildWorkerRunsSnapshot(group, isMain);
    writeWorkerRunsSnapshot(group.folder, workerRunsSnapshot);
    if (isMain) {
      writeMainControlPlaneStatusSnapshot();
    }
  }
  const effectivePrompt =
    group.folder === ANDY_DEVELOPER_FOLDER && workerRunsSnapshot
      ? `${buildAndyPromptWorkerContext(workerRunsSnapshot)}\n\n${prompt}`
      : prompt;

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
          setSessionContextVersion(group.folder, sessionContextVersion);
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
        runId: workerRunId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        opsExtended: RUNTIME_OPS_EXTENDED,
        schedulerEnabled: ENABLE_SCHEDULER,
        workerSteeringEnabled: ENABLE_WORKER_STEERING,
        dynamicGroupRegistrationEnabled: ENABLE_DYNAMIC_GROUP_REGISTRATION,
      },
      (proc, containerName) => {
        queue.registerProcess(chatJid, proc, containerName, group.folder);
        if (typeof proc.pid === 'number' && proc.pid > 0) {
          onSpawn?.(containerName);
        } else {
          logger.warn(
            { group: group.name, containerName, pid: proc.pid },
            'Container process registered without valid pid',
          );
        }
      },
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
      setSessionContextVersion(group.folder, sessionContextVersion);
    } else if (sessionId) {
      setSessionContextVersion(group.folder, sessionContextVersion);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return {
        status: 'error',
        newSessionId: output.newSessionId ?? sessionId,
        sessionResumeStatus: output.sessionResumeStatus,
        sessionResumeError: output.sessionResumeError,
        error: output.error,
      };
    }

    return {
      status: 'success',
      newSessionId: output.newSessionId ?? sessionId,
      sessionResumeStatus: output.sessionResumeStatus,
      sessionResumeError: output.sessionResumeError,
    };
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return {
      status: 'error',
      newSessionId: sessionId,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);
  let lastWorkerSnapshotRefresh = 0;

  while (true) {
    try {
      reconcileStaleWorkerRuns();
      const now = Date.now();
      if (
        now - lastWorkerSnapshotRefresh >=
        WORKER_SNAPSHOT_REFRESH_INTERVAL_MS
      ) {
        refreshWorkerRunSnapshotsForGroups();
        lastWorkerSnapshotRefresh = now;
      }
      const jids = Object.keys(registeredGroups);
      const { messages, newCursor } = getNewMessages(
        jids,
        lastCursor,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastCursor = newCursor;
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
            console.log(
              `Warning: no channel owns JID ${chatJid}, skipping messages`,
            );
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

          if (channel) {
            await ackAndyIntakeMessages(chatJid, group, groupMessages, channel);
          }

          // Pull all messages since the effective cursor (committed + in-flight)
          // so non-trigger context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getEffectiveAgentCursor(chatJid),
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const andyRequestsToSend =
            group.folder === ANDY_DEVELOPER_FOLDER
              ? getAndyRequestsForMessages(messagesToSend)
              : [];
          if (andyRequestsToSend.length > 0) {
            markAndyRequestsCoordinatorActive(
              andyRequestsToSend,
              'Coordinator is processing your request',
            );
            markAndyRequestsReviewInProgress(
              andyRequestsToSend,
              'Andy is reviewing worker completion artifacts',
            );
          }
          const activeRequestForSend = andyRequestsToSend[0]?.requestId;
          const baseFormatted = formatMessages(messagesToSend, TIMEZONE);
          const formatted =
            group.folder === ANDY_DEVELOPER_FOLDER && activeRequestForSend
              ? `${buildAndyFrontdeskContextBlock(chatJid, activeRequestForSend)}\n\n${baseFormatted}`
              : baseFormatted;

          // Worker lanes must execute one dispatch per container run.
          // Never pipe additional dispatches into an active worker session.
          if (syntheticWorker) {
            queue.enqueueMessageCheck(chatJid);
            continue;
          }

          if (
            channel &&
            isMainGroup &&
            (await handleMainLaneControlMessages({
              chatJid,
              group,
              messages: messagesToSend,
              channel,
              queue,
              registeredGroups,
              runtime: {
                markCursorInFlight,
                clearInFlightCursor,
                markBatchProcessed,
                commitInFlightCursor,
              },
            }))
          ) {
            continue;
          }

          if (
            channel &&
            (await handleAndyFrontdeskMessages({
              chatJid,
              group,
              messages: messagesToSend,
              channel,
              allowGreeting: false,
              runtime: {
                markCursorInFlight,
                clearInFlightCursor,
                markBatchProcessed,
                commitInFlightCursor,
              },
            }))
          ) {
            continue;
          }

          if (isMainGroup && ENABLE_CONTROL_PLANE_SNAPSHOTS) {
            writeMainControlPlaneStatusSnapshot();
          }

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            markCursorInFlight(
              chatJid,
              messagesToSend[messagesToSend.length - 1].timestamp,
            );
            // Show typing indicator while the container processes the piped message
            channel
              ?.setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
            // Immediate ack for simple greetings when Andy is busy
            if (
              group.folder === ANDY_DEVELOPER_FOLDER &&
              channel &&
              isSimpleAndyGreeting(group, messagesToSend)
            ) {
              const lastAck = andyBusyAckLastSentMs[chatJid] ?? 0;
              if (Date.now() - lastAck > ANDY_BUSY_ACK_COOLDOWN_MS) {
                andyBusyAckLastSentMs[chatJid] = Date.now();
                channel
                  .sendMessage(
                    chatJid,
                    `${ASSISTANT_NAME}: I'm working on something, I'll be with you shortly.`,
                  )
                  .catch((err) =>
                    logger.warn({ chatJid, err }, 'Busy ack send failed'),
                  );
              }
            }
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

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

function stopRuntimeOwnershipHeartbeat(): void {
  if (!runtimeOwnershipHeartbeat) return;
  clearInterval(runtimeOwnershipHeartbeat);
  runtimeOwnershipHeartbeat = null;
}

function startRuntimeOwnershipHeartbeat(): void {
  stopRuntimeOwnershipHeartbeat();
  runtimeOwnershipHeartbeat = setInterval(() => {
    const result = heartbeatRuntimeOwnership();
    if (result.ok) return;
    logger.error(
      {
        currentOwnerPid: result.currentOwner?.pid,
        currentOwnerMode: result.currentOwner?.owner_mode,
      },
      'Runtime ownership lost; stopping process',
    );
    requestShutdown('runtime_ownership_lost', 1);
  }, RUNTIME_OWNER_HEARTBEAT_MS);
}

function requestShutdown(signal: string, exitCode = 0): void {
  if (shutdownPromise) return;
  shutdownPromise = (async () => {
    logger.info(
      { signal, shutdownDrainMs: SHUTDOWN_DRAIN_MS, exitCode },
      'Shutdown signal received',
    );
    stopRuntimeOwnershipHeartbeat();
    try {
      await queue.shutdown(SHUTDOWN_DRAIN_MS);
      for (const ch of channels) await ch.disconnect();
    } finally {
      releaseRuntimeOwnership();
      process.exit(exitCode);
    }
  })();
}

async function main(): Promise<void> {
  initDatabase();
  setRouterState('process_start_at', PROCESS_START_AT_ISO);
  logger.info('Database initialized');
  const ownership = claimRuntimeOwnership();
  try {
    logRuntimeOwnershipClaim(ownership);
    startRuntimeOwnershipHeartbeat();

    ensureContainerSystemRunning();
    setRouterState('process_start_at', PROCESS_START_AT_ISO);
    loadState();

    process.on('SIGTERM', () => requestShutdown('SIGTERM'));
    process.on('SIGINT', () => requestShutdown('SIGINT'));

    // Channel callbacks (shared by all channels)
    const channelOpts: WhatsAppChannelOpts = {
      onMessage: (_chatJid: string, msg: NewMessage) => storeMessage(msg),
      onChatMetadata: (
        chatJid: string,
        timestamp: string,
        name?: string,
        channel?: string,
        isGroup?: boolean,
      ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
      registeredGroups: () => registeredGroups,
      onConnectionClose: async ({
        reason,
        defaultShouldReconnect,
        queuedMessages,
      }: WhatsAppCloseContext) => {
        if (
          !defaultShouldReconnect ||
          reason !== DisconnectReason.connectionReplaced
        ) {
          return;
        }
        const owner = getCurrentRuntimeOwner();
        if (!owner || isOwnedByCurrentProcess(owner)) {
          return;
        }
        logger.error(
          {
            reason,
            queuedMessages,
            ownerPid: owner.pid,
            ownerMode: owner.owner_mode,
            ownerClaimedBy: owner.claimed_by,
          },
          'WhatsApp session conflict with another active runtime owner',
        );
        requestShutdown('whatsapp_connection_replaced', 1);
        return 'stop_reconnect';
      },
    };

    whatsapp = new WhatsAppChannel(channelOpts);
    channels.push(whatsapp);
    await whatsapp.connect();

    if (ENABLE_SCHEDULER) {
      startSchedulerLoop({
        registeredGroups: () => registeredGroups,
        getSessions: () => sessions,
        queue,
        onProcess: (groupJid, proc, containerName, groupFolder) =>
          queue.registerProcess(groupJid, proc, containerName, groupFolder),
        sendMessage: async (jid, rawText) => {
          const channel = findChannel(channels, jid);
          if (!channel) {
            console.log(
              `Warning: no channel owns JID ${jid}, cannot send message`,
            );
            return;
          }
          const text = formatOutbound(rawText);
          if (text) await channel.sendMessage(jid, text);
        },
      });
    } else {
      logger.info('Scheduler disabled by runtime profile');
    }
    startIpcWatcher({
      sendMessage: (jid, text, sourceGroup) => {
        const target = registeredGroups[jid];
        if (target && isSyntheticWorkerGroup(target)) {
          const timestamp = new Date().toISOString();
          // Ensure parent chat row exists before inserting message row (FK on messages.chat_jid).
          storeChatMetadata(jid, timestamp, target.name, 'nanoclaw', true);
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
          return Promise.resolve();
        }
        const channel = findChannel(channels, jid);
        if (!channel) throw new Error(`No channel for JID: ${jid}`);
        return channel.sendMessage(jid, text);
      },
      registeredGroups: () => registeredGroups,
      registerGroup,
      syncGroupMetadata: (force) =>
        whatsapp?.syncGroupMetadata(force) ?? Promise.resolve(),
      getAvailableGroups,
      writeGroupsSnapshot: (gf, im, ag, rj) =>
        writeGroupsSnapshot(gf, im, ag, rj),
      options: {
        taskControlEnabled: ENABLE_SCHEDULER,
        workerSteeringEnabled: ENABLE_WORKER_STEERING,
        dynamicGroupRegistrationEnabled: ENABLE_DYNAMIC_GROUP_REGISTRATION,
      },
    });
    queue.setProcessMessagesFn(processGroupMessages);
    recoverInterruptedWorkerDispatches({ registeredGroups, queue });
    recoverPendingMessages({
      registeredGroups,
      lastAgentTimestamp,
      assistantName: ASSISTANT_NAME,
      queue,
    });
    startMessageLoop().catch((err) => {
      logger.fatal({ err }, 'Message loop crashed unexpectedly');
      requestShutdown('message_loop_crashed', 1);
    });
  } catch (err) {
    stopRuntimeOwnershipHeartbeat();
    releaseRuntimeOwnership();
    throw err;
  }
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    if (err instanceof RuntimeOwnershipConflictError) {
      logger.error(
        {
          currentOwnerPid: err.currentOwner.pid,
          currentOwnerMode: err.currentOwner.owner_mode,
          currentOwnerClaimedBy: err.currentOwner.claimed_by,
        },
        'Failed to start NanoClaw because another runtime owner is active',
      );
    }
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
