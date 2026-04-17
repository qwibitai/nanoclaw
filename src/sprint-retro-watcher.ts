import { agencyFetch, type AgencyHqTask } from './agency-hq-client.js';
import { findCeoJid } from './dispatch-loop.js';
import { createCorrelationLogger, logger } from './logger.js';
import { SchedulerDependencies } from './task-scheduler.js';

export const SPRINT_RETRO_INTERVAL = 60 * 60_000; // 1 hour

let stopping = false;
let retroIntervalHandle: ReturnType<typeof setInterval> | null = null;

const isStopping = () => stopping;

// --- Types ---

interface SprintSummary {
  id: string;
  name: string;
  goal?: string;
  status: string;
  started_at?: string;
  ended_at?: string;
}

interface RetroTask {
  id: string;
  title: string;
  context?: {
    gates?: Record<string, string>;
    result?: { summary?: string };
  };
}

interface RetrospectiveData {
  sprint: SprintSummary;
  shipped: RetroTask[];
  slipped: RetroTask[];
  never_started: RetroTask[];
  cycle_times: Array<{ task_id: string; cycle_time_hours: number }>;
  meta: {
    total_tasks: number;
    shipped_count: number;
    slipped_count: number;
    never_started_count: number;
    ghost_count: number;
    avg_cycle_time_hours: number | null;
  };
}

// --- In-memory sprint status cache ---

export interface SprintSnapshot {
  sprintId: string;
  sprintName: string;
  status: string;
  taskFingerprint: string; // sorted "id:status" pairs joined
  totalTasks: number;
  completedTasks: number;
}

/**
 * In-memory cache of last-known sprint state. Keyed by sprint ID.
 * Resets on process restart — first poll after restart seeds state without messaging.
 */
const lastKnownState = new Map<string, SprintSnapshot>();

/** Tracks whether the cache has been seeded (first poll populates without diffing). */
let cacheSeeded = false;

// --- Sprint status change detection ---

export interface SprintDiff {
  type: 'new_sprint' | 'tasks_changed' | 'sprint_completed';
  sprintName: string;
  sprintId: string;
  details: string;
}

/**
 * Build a fingerprint from sprint tasks — a deterministic string that changes
 * when any task is added, removed, or changes status.
 */
export function buildTaskFingerprint(
  tasks: Array<{ id: string; status: string }>,
): string {
  return tasks
    .map((t) => `${t.id}:${t.status}`)
    .sort()
    .join('|');
}

/**
 * Build a snapshot for an active sprint from its tasks.
 */
function buildSnapshot(
  sprint: SprintSummary,
  tasks: Array<{ id: string; status: string }>,
): SprintSnapshot {
  const completedStatuses = new Set([
    'done',
    'completed',
    'shipped',
    'closed',
  ]);
  return {
    sprintId: sprint.id,
    sprintName: sprint.name,
    status: sprint.status,
    taskFingerprint: buildTaskFingerprint(tasks),
    totalTasks: tasks.length,
    completedTasks: tasks.filter((t) =>
      completedStatuses.has(t.status.toLowerCase()),
    ).length,
  };
}

/**
 * Compare current sprint snapshots to cached state and return diffs.
 */
export function detectSprintChanges(
  current: SprintSnapshot[],
  previous: Map<string, SprintSnapshot>,
): SprintDiff[] {
  const diffs: SprintDiff[] = [];

  for (const snap of current) {
    const prev = previous.get(snap.sprintId);

    if (!prev) {
      diffs.push({
        type: 'new_sprint',
        sprintName: snap.sprintName,
        sprintId: snap.sprintId,
        details: `New sprint started: ${snap.sprintName} (${snap.totalTasks} tasks)`,
      });
      continue;
    }

    if (snap.taskFingerprint !== prev.taskFingerprint) {
      const taskDelta = snap.totalTasks - prev.totalTasks;
      const completionDelta = snap.completedTasks - prev.completedTasks;
      const parts: string[] = [];

      if (taskDelta > 0) parts.push(`${taskDelta} new task(s)`);
      if (taskDelta < 0) parts.push(`${Math.abs(taskDelta)} task(s) removed`);
      if (completionDelta > 0) parts.push(`${completionDelta} task(s) completed`);
      if (parts.length === 0) parts.push('task status changed');

      const pctNow =
        snap.totalTasks > 0
          ? Math.round((snap.completedTasks / snap.totalTasks) * 100)
          : 0;

      diffs.push({
        type: 'tasks_changed',
        sprintName: snap.sprintName,
        sprintId: snap.sprintId,
        details: `${parts.join(', ')} — ${pctNow}% complete (${snap.completedTasks}/${snap.totalTasks})`,
      });
    }
  }

  // Detect sprints that disappeared from active (likely completed)
  for (const [sprintId, prev] of previous) {
    const stillActive = current.some((s) => s.sprintId === sprintId);
    if (!stillActive) {
      diffs.push({
        type: 'sprint_completed',
        sprintName: prev.sprintName,
        sprintId: sprintId,
        details: `Sprint no longer active: ${prev.sprintName}`,
      });
    }
  }

  return diffs;
}

/**
 * Format sprint change diffs into a Telegram message.
 */
export function formatSprintChangeMessage(diffs: SprintDiff[]): string {
  const lines: string[] = ['*Sprint Status Update*', ''];

  for (const diff of diffs) {
    switch (diff.type) {
      case 'new_sprint':
        lines.push(`🏃 ${diff.details}`);
        break;
      case 'tasks_changed':
        lines.push(`📋 *${diff.sprintName}:* ${diff.details}`);
        break;
      case 'sprint_completed':
        lines.push(`✅ ${diff.details}`);
        break;
    }
  }

  return lines.join('\n');
}

// --- Active sprint change detection ---

async function fetchActiveSprints(): Promise<SprintSummary[]> {
  try {
    const res = await agencyFetch('/sprints?status=active');
    if (!res.ok) return [];
    const json = (await res.json()) as {
      success: boolean;
      data: SprintSummary[];
    };
    return json.data ?? [];
  } catch {
    return [];
  }
}

async function fetchSprintTasks(
  sprintId: string,
): Promise<Array<{ id: string; status: string }>> {
  try {
    const res = await agencyFetch(`/tasks?sprint_id=${sprintId}`);
    if (!res.ok) return [];
    const json = (await res.json()) as {
      success: boolean;
      data: AgencyHqTask[];
    };
    return (json.data ?? []).map((t) => ({ id: t.id, status: t.status }));
  } catch {
    return [];
  }
}

async function checkForSprintChanges(
  deps: SchedulerDependencies,
  isStoppingFn: () => boolean,
): Promise<void> {
  if (isStoppingFn()) return;

  const log = createCorrelationLogger(undefined, {
    op: 'sprint-change-detector',
  });

  const target = findCeoJid(deps);
  if (!target) {
    log.debug('No CEO group registered, skipping sprint change check');
    return;
  }

  const activeSprints = await fetchActiveSprints();
  log.trace({ count: activeSprints.length }, 'Fetched active sprints');

  // Build current snapshots
  const currentSnapshots: SprintSnapshot[] = [];
  for (const sprint of activeSprints) {
    if (isStoppingFn()) return;
    const tasks = await fetchSprintTasks(sprint.id);
    currentSnapshots.push(buildSnapshot(sprint, tasks));
  }

  if (!cacheSeeded) {
    // First run after startup — seed the cache without sending messages
    for (const snap of currentSnapshots) {
      lastKnownState.set(snap.sprintId, snap);
    }
    cacheSeeded = true;
    log.info(
      { sprintCount: currentSnapshots.length },
      'Sprint state cache seeded (first poll, no messages sent)',
    );
    return;
  }

  // Detect diffs against cached state
  const diffs = detectSprintChanges(currentSnapshots, lastKnownState);

  // Update the cache regardless of whether we send a message
  lastKnownState.clear();
  for (const snap of currentSnapshots) {
    lastKnownState.set(snap.sprintId, snap);
  }

  if (diffs.length === 0) {
    log.debug('No sprint status changes detected');
    return;
  }

  log.info({ diffs: diffs.length }, 'Sprint status changes detected');

  const message = formatSprintChangeMessage(diffs);
  try {
    await deps.sendMessage(target.jid, message);
    log.info('Sprint change notification sent');
  } catch (err) {
    log.error({ err }, 'Failed to send sprint change notification');
  }
}

// --- Completed sprint retro detection (existing logic) ---

async function getProcessedSprintIds(): Promise<Set<string>> {
  try {
    const res = await agencyFetch('/memory/ops?project=retro-processed');
    if (!res.ok) return new Set();
    const json = (await res.json()) as {
      success: boolean;
      data?: { content?: string };
    };
    const content = json.data?.content;
    if (!content) return new Set();
    const ids = JSON.parse(content) as string[];
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}

async function markSprintProcessed(
  sprintId: string,
  existing: Set<string>,
): Promise<void> {
  const ids = [...existing, sprintId];
  try {
    await agencyFetch('/memory/ops', {
      method: 'PUT',
      body: JSON.stringify({
        project: 'retro-processed',
        content: JSON.stringify(ids),
      }),
    });
  } catch (err) {
    logger.warn({ err, sprintId }, 'Failed to mark sprint as retro-processed');
  }
}

async function fetchRetrospective(
  sprintId: string,
): Promise<RetrospectiveData | null> {
  try {
    const res = await agencyFetch(`/sprints/${sprintId}/retrospective`);
    if (!res.ok) {
      logger.warn(
        { sprintId, status: res.status },
        'Failed to fetch sprint retrospective',
      );
      return null;
    }
    const json = (await res.json()) as {
      success: boolean;
      data: RetrospectiveData;
    };
    return json.data ?? null;
  } catch (err) {
    logger.error({ err, sprintId }, 'Error fetching sprint retrospective');
    return null;
  }
}

function formatTaskLine(t: RetroTask): string {
  const summary = t.context?.result?.summary;
  const text = summary ?? t.title;
  const truncated = text.length > 120 ? `${text.slice(0, 117)}...` : text;
  return `• ${truncated}`;
}

function formatRetroMessage(retro: RetrospectiveData): string {
  const { sprint, shipped, slipped, never_started, meta } = retro;

  // Gate failures: tasks whose context.gates has any "FAIL" value
  const gateFailures = shipped.filter((t) => {
    const gates = t.context?.gates ?? {};
    return Object.values(gates).some((v) => v === 'FAIL');
  });

  const lines: string[] = [`*Sprint Complete: ${sprint.name}*`];

  if (sprint.goal) {
    lines.push(`_${sprint.goal}_`);
  }

  lines.push('');
  lines.push(`• Done: ${meta.shipped_count} / ${meta.total_tasks}`);
  lines.push(`• Slipped: ${meta.slipped_count}`);
  if (meta.never_started_count > 0) {
    lines.push(`• Blocked/never started: ${meta.never_started_count}`);
  }
  if (meta.avg_cycle_time_hours != null) {
    lines.push(`• Avg cycle time: ${meta.avg_cycle_time_hours.toFixed(1)}h`);
  }
  if (gateFailures.length > 0) {
    lines.push(
      `• Gate failures: ${gateFailures.map((t) => t.title).join(', ')}`,
    );
  }

  if (shipped.length > 0) {
    lines.push('');
    lines.push('*Shipped:*');
    for (const t of shipped) {
      lines.push(formatTaskLine(t));
    }
  }

  if (slipped.length > 0) {
    lines.push('');
    lines.push('*Slipped:*');
    for (const t of slipped) {
      lines.push(formatTaskLine(t));
    }
  }

  if (never_started.length > 0) {
    lines.push('');
    lines.push('*Blocked/never started:*');
    for (const t of never_started) {
      lines.push(`• ${t.title}`);
    }
  }

  return lines.join('\n');
}

// --- Combined check (both active changes + completed retros) ---

export async function checkSprintStatus(
  deps: SchedulerDependencies,
  isStoppingFn: () => boolean,
): Promise<void> {
  if (isStoppingFn()) return;

  // 1. Check for active sprint status changes
  await checkForSprintChanges(deps, isStoppingFn);

  if (isStoppingFn()) return;

  // 2. Check for newly completed sprints (retro reports)
  await checkForCompletedSprints(deps, isStoppingFn);
}

export async function checkForCompletedSprints(
  deps: SchedulerDependencies,
  isStoppingFn: () => boolean,
): Promise<void> {
  if (isStoppingFn()) return;

  const log = createCorrelationLogger(undefined, {
    op: 'sprint-retro-watcher',
  });
  log.trace('Sprint retro watcher poll cycle start');

  const target = findCeoJid(deps);
  if (!target) {
    log.debug('No CEO group registered, skipping sprint retro check');
    return;
  }

  let sprints: SprintSummary[];
  try {
    const res = await agencyFetch('/sprints?status=completed');
    if (!res.ok) {
      log.warn({ status: res.status }, 'Failed to fetch completed sprints');
      return;
    }
    const json = (await res.json()) as {
      success: boolean;
      data: SprintSummary[];
    };
    sprints = json.data ?? [];
  } catch (err) {
    log.error({ err }, 'Failed to fetch completed sprints');
    return;
  }

  if (sprints.length === 0) return;

  const processed = await getProcessedSprintIds();
  const newlyCompleted = sprints.filter((s) => !processed.has(s.id));

  if (newlyCompleted.length === 0) {
    log.debug(
      { total: sprints.length },
      'All completed sprints already reported',
    );
    return;
  }

  log.info(
    { count: newlyCompleted.length },
    'Found unprocessed completed sprints, sending retro reports',
  );

  for (const sprint of newlyCompleted) {
    if (isStoppingFn()) return;

    const retro = await fetchRetrospective(sprint.id);
    if (!retro) {
      log.warn({ sprintId: sprint.id }, 'Skipping sprint — retro fetch failed');
      continue;
    }

    const message = formatRetroMessage(retro);

    try {
      await deps.sendMessage(target.jid, message);
      log.info(
        { sprintId: sprint.id, sprintName: sprint.name },
        'Sprint retro report sent to CEO',
      );
    } catch (err) {
      log.error({ err, sprintId: sprint.id }, 'Failed to send retro message');
      continue;
    }

    await markSprintProcessed(sprint.id, processed);
    processed.add(sprint.id);
  }
}

// --- Lifecycle ---

export function startSprintRetroWatcher(deps: SchedulerDependencies): void {
  stopping = false;
  logger.info(
    { intervalMs: SPRINT_RETRO_INTERVAL },
    'Starting sprint retro watcher',
  );

  // Run once immediately, then on interval
  checkSprintStatus(deps, isStopping).catch((err) =>
    logger.error({ err }, 'Sprint retro watcher tick failed'),
  );

  retroIntervalHandle = setInterval(() => {
    checkSprintStatus(deps, isStopping).catch((err) =>
      logger.error({ err }, 'Sprint retro watcher tick failed'),
    );
  }, SPRINT_RETRO_INTERVAL);
}

export function stopSprintRetroWatcher(): void {
  stopping = true;
  if (retroIntervalHandle) {
    clearInterval(retroIntervalHandle);
    retroIntervalHandle = null;
  }
}

/** @internal — reset in-memory state for testing */
export function _resetForTesting(): void {
  lastKnownState.clear();
  cacheSeeded = false;
  stopping = false;
}
