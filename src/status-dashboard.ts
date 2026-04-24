/**
 * Status Dashboard — queries dispatch slot state, active task metadata,
 * execution duration, and queue depth from Agency HQ and/or local SQLite.
 *
 * Used by both the `nanoclaw-status` CLI command and the GET /status HTTP endpoint.
 */

import { PARALLEL_DISPATCH_WORKERS } from './dispatch-pool-constants.js';
import { agencyFetch, type AgencyHqTask } from './agency-hq-client.js';
import {
  getDispatchSlotBackend,
  type ActiveSlotInfo,
} from './dispatch-slot-backends.js';

// --- Types ---

export interface SlotStatus {
  index: number;
  state: 'BUSY' | 'FREE' | 'UNKNOWN';
  taskId: string | null;
  taskTitle: string | null;
  elapsedMs: number | null;
}

export interface StatusSnapshot {
  timestamp: string;
  slots: SlotStatus[];
  queueDepth: number;
  error: string | null;
}

export interface CompletedTask {
  id: string;
  title: string;
  status: string;
  completedAt: string;
  durationMs: number | null;
}

export interface UtilizationMetrics {
  avgSlotsInUse: number;
  peakSlotsInUse: number;
  peakTime: string | null;
  idlePercent: number;
}

export interface QueueMetrics {
  avgDepth: number;
  avgWaitMs: number;
  longestWaitMs: number;
  longestWaitTaskId: string | null;
}

export interface PerformanceTrends {
  avgCompletionMs: number;
  slowestTasks: Array<{ id: string; title: string; durationMs: number }>;
  errorRate: number;
  totalCompleted: number;
  totalFailed: number;
}

export interface HistoricalSnapshot {
  recentTasks: CompletedTask[];
  utilization: UtilizationMetrics;
  queue: QueueMetrics;
  performance: PerformanceTrends;
  error: string | null;
}

// --- Querying ---

/**
 * Fetch task title from Agency HQ by task ID.
 * Returns null on failure — callers display the ID alone.
 */
async function fetchTaskTitle(taskId: string): Promise<string | null> {
  try {
    const res = await agencyFetch(`/tasks/${taskId}`);
    if (!res.ok) return null;
    const json = (await res.json()) as {
      success: boolean;
      data: AgencyHqTask;
    };
    return json.data?.title ?? null;
  } catch {
    return null;
  }
}

/**
 * Count tasks with status 'ready' in Agency HQ (the dispatch queue depth).
 */
async function fetchQueueDepth(): Promise<number> {
  const res = await agencyFetch('/tasks?status=ready');
  if (!res.ok) throw new Error(`Agency HQ returned ${res.status}`);
  const json = (await res.json()) as {
    success: boolean;
    data: AgencyHqTask[];
  };
  return (json.data ?? []).length;
}

/**
 * Build a StatusSnapshot by querying dispatch slots and queue depth.
 *
 * Strategy:
 *  1. List active slots via the configured backend (SQLite or PG).
 *  2. For each occupied slot, fetch the task title from Agency HQ.
 *  3. Count ready tasks for queue depth.
 *
 * On any error, returns a snapshot with UNKNOWN states and the error message.
 */
export async function buildStatusSnapshot(): Promise<StatusSnapshot> {
  const now = new Date();

  try {
    // Query active slots
    let activeSlots: ActiveSlotInfo[];
    try {
      activeSlots = await getDispatchSlotBackend().listActiveSlots();
    } catch {
      // If backend is not initialized (e.g. CLI without DB), try Agency HQ directly
      activeSlots = await fetchActiveSlotsFromAgencyHq();
    }

    // Build slot index → active slot map
    const slotMap = new Map<number, ActiveSlotInfo>();
    for (const slot of activeSlots) {
      slotMap.set(slot.slotIndex, slot);
    }

    // Build slot statuses and fetch titles in parallel
    const slotPromises: Promise<SlotStatus>[] = [];
    for (let i = 0; i < PARALLEL_DISPATCH_WORKERS; i++) {
      const active = slotMap.get(i);
      if (active) {
        slotPromises.push(
          fetchTaskTitle(active.ahqTaskId).then((title) => ({
            index: i,
            state: 'BUSY' as const,
            taskId: active.ahqTaskId,
            taskTitle: title,
            elapsedMs: active.executingAt
              ? now.getTime() - new Date(active.executingAt).getTime()
              : null,
          })),
        );
      } else {
        slotPromises.push(
          Promise.resolve({
            index: i,
            state: 'FREE' as const,
            taskId: null,
            taskTitle: null,
            elapsedMs: null,
          }),
        );
      }
    }

    const slots = await Promise.all(slotPromises);

    // Queue depth
    let queueDepth: number;
    try {
      queueDepth = await fetchQueueDepth();
    } catch {
      queueDepth = 0;
    }

    return {
      timestamp: now.toISOString(),
      slots,
      queueDepth,
      error: null,
    };
  } catch (err) {
    // Total failure — return UNKNOWN state for all slots
    const slots: SlotStatus[] = [];
    for (let i = 0; i < PARALLEL_DISPATCH_WORKERS; i++) {
      slots.push({
        index: i,
        state: 'UNKNOWN',
        taskId: null,
        taskTitle: null,
        elapsedMs: null,
      });
    }
    return {
      timestamp: now.toISOString(),
      slots,
      queueDepth: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// --- Historical trends ---

interface TaskHistoryRecord {
  id: string;
  title: string;
  status: string;
  dispatched_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
}

/**
 * Fetch recently completed/failed tasks from Agency HQ.
 */
async function fetchTaskHistory(limit: number): Promise<TaskHistoryRecord[]> {
  const results: TaskHistoryRecord[] = [];

  for (const status of ['done', 'failed', 'cancelled']) {
    try {
      const res = await agencyFetch(`/tasks?status=${status}`);
      if (!res.ok) continue;
      const json = (await res.json()) as {
        success: boolean;
        data: TaskHistoryRecord[];
      };
      results.push(...(json.data ?? []));
    } catch {
      // Skip status on failure
    }
  }

  // Sort by updated_at descending (most recent first)
  results.sort((a, b) => {
    const aTime = a.updated_at ?? a.created_at ?? '';
    const bTime = b.updated_at ?? b.created_at ?? '';
    return bTime.localeCompare(aTime);
  });

  return results.slice(0, limit);
}

/**
 * Fetch tasks that are currently in-progress to compute utilization.
 */
async function fetchInProgressTasks(): Promise<TaskHistoryRecord[]> {
  try {
    const res = await agencyFetch('/tasks?status=in-progress');
    if (!res.ok) return [];
    const json = (await res.json()) as {
      success: boolean;
      data: TaskHistoryRecord[];
    };
    return json.data ?? [];
  } catch {
    return [];
  }
}

/**
 * Compute task duration in ms from dispatched_at to updated_at.
 */
function computeDuration(task: TaskHistoryRecord): number | null {
  if (!task.dispatched_at || !task.updated_at) return null;
  const start = new Date(task.dispatched_at).getTime();
  const end = new Date(task.updated_at).getTime();
  if (isNaN(start) || isNaN(end) || end < start) return null;
  return end - start;
}

/**
 * Build a HistoricalSnapshot with recent activity, utilization, queue,
 * and performance metrics from Agency HQ.
 */
export async function buildHistoricalSnapshot(): Promise<HistoricalSnapshot> {
  try {
    // Fetch all data in parallel
    const [recentRaw, readyTasks, inProgressTasks] = await Promise.all([
      fetchTaskHistory(50), // Fetch more than 10 to compute stats
      fetchQueueDepth().catch(() => 0),
      fetchInProgressTasks(),
    ]);

    // Recent completed tasks (last 10)
    const recentTasks: CompletedTask[] = recentRaw.slice(0, 10).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      completedAt: t.updated_at ?? '',
      durationMs: computeDuration(t),
    }));

    // Utilization: compute from current active slots + in-progress tasks
    const currentInProgress = inProgressTasks.length;
    const avgSlotsInUse = Math.min(
      currentInProgress,
      PARALLEL_DISPATCH_WORKERS,
    );
    const peakSlotsInUse = Math.min(
      currentInProgress,
      PARALLEL_DISPATCH_WORKERS,
    );

    // Find peak time from dispatched_at of in-progress tasks
    let peakTime: string | null = null;
    if (inProgressTasks.length > 0) {
      const earliest = inProgressTasks
        .filter((t) => t.dispatched_at)
        .sort((a, b) =>
          (a.dispatched_at ?? '').localeCompare(b.dispatched_at ?? ''),
        );
      if (earliest.length > 0) {
        peakTime = earliest[0].dispatched_at ?? null;
      }
    }

    // Idle percentage: slots not in use out of total
    const idlePercent =
      PARALLEL_DISPATCH_WORKERS > 0
        ? ((PARALLEL_DISPATCH_WORKERS - avgSlotsInUse) /
            PARALLEL_DISPATCH_WORKERS) *
          100
        : 100;

    const utilization: UtilizationMetrics = {
      avgSlotsInUse,
      peakSlotsInUse,
      peakTime,
      idlePercent,
    };

    // Queue metrics
    const waitTimes = recentRaw
      .map((t) => {
        if (!t.created_at || !t.dispatched_at) return null;
        const created = new Date(t.created_at).getTime();
        const dispatched = new Date(t.dispatched_at).getTime();
        if (isNaN(created) || isNaN(dispatched) || dispatched < created)
          return null;
        return { waitMs: dispatched - created, taskId: t.id };
      })
      .filter((w): w is { waitMs: number; taskId: string } => w !== null);

    const avgWaitMs =
      waitTimes.length > 0
        ? waitTimes.reduce((sum, w) => sum + w.waitMs, 0) / waitTimes.length
        : 0;

    const longestWait = waitTimes.reduce<{
      waitMs: number;
      taskId: string;
    } | null>((max, w) => (!max || w.waitMs > max.waitMs ? w : max), null);

    const queue: QueueMetrics = {
      avgDepth: readyTasks,
      avgWaitMs,
      longestWaitMs: longestWait?.waitMs ?? 0,
      longestWaitTaskId: longestWait?.taskId ?? null,
    };

    // Performance trends
    const completedTasks = recentRaw.filter((t) => t.status === 'done');
    const failedTasks = recentRaw.filter((t) => t.status === 'failed');
    const totalCompleted = completedTasks.length;
    const totalFailed = failedTasks.length;
    const total = totalCompleted + totalFailed;

    const completionTimes = completedTasks
      .map(computeDuration)
      .filter((d): d is number => d !== null);

    const avgCompletionMs =
      completionTimes.length > 0
        ? completionTimes.reduce((sum, d) => sum + d, 0) /
          completionTimes.length
        : 0;

    // Top 3 slowest tasks
    const slowestTasks = completedTasks
      .map((t) => ({
        id: t.id,
        title: t.title,
        durationMs: computeDuration(t),
      }))
      .filter(
        (t): t is { id: string; title: string; durationMs: number } =>
          t.durationMs !== null,
      )
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 3);

    const errorRate = total > 0 ? (totalFailed / total) * 100 : 0;

    const performance: PerformanceTrends = {
      avgCompletionMs,
      slowestTasks,
      errorRate,
      totalCompleted,
      totalFailed,
    };

    return {
      recentTasks,
      utilization,
      queue,
      performance,
      error: null,
    };
  } catch (err) {
    return {
      recentTasks: [],
      utilization: {
        avgSlotsInUse: 0,
        peakSlotsInUse: 0,
        peakTime: null,
        idlePercent: 100,
      },
      queue: {
        avgDepth: 0,
        avgWaitMs: 0,
        longestWaitMs: 0,
        longestWaitTaskId: null,
      },
      performance: {
        avgCompletionMs: 0,
        slowestTasks: [],
        errorRate: 0,
        totalCompleted: 0,
        totalFailed: 0,
      },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fallback: fetch active slots directly from Agency HQ's HTTP API
 * when the local SQLite backend is not available (e.g. standalone CLI).
 */
async function fetchActiveSlotsFromAgencyHq(): Promise<ActiveSlotInfo[]> {
  const res = await agencyFetch('/dispatch-slots/active');
  if (!res.ok) return [];

  const json = (await res.json()) as {
    success: boolean;
    data: Array<{
      slot_index: number;
      ahq_task_id: string;
      status: string;
      executing_at?: string | null;
    }>;
  };

  return (json.data ?? []).map((slot) => ({
    slotId: slot.slot_index,
    slotIndex: slot.slot_index,
    ahqTaskId: slot.ahq_task_id,
    state: slot.status,
    worktreePath: null,
    executingAt: slot.executing_at ?? null,
  }));
}

// --- Formatting ---

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

/**
 * Format a StatusSnapshot as plain text (no ANSI codes).
 */
export function formatStatusPlain(snapshot: StatusSnapshot): string {
  const lines: string[] = [];

  lines.push(`NanoClaw Status  ${snapshot.timestamp}`);
  lines.push('─'.repeat(56));

  if (snapshot.error) {
    lines.push(`  Error: ${snapshot.error}`);
    lines.push('');
  }

  for (const slot of snapshot.slots) {
    const indicator =
      slot.state === 'BUSY'
        ? '[BUSY]'
        : slot.state === 'FREE'
          ? '[FREE]'
          : '[UNKNOWN]';
    let line = `  Slot ${slot.index}  ${indicator}`;

    if (slot.state === 'BUSY' && slot.taskId) {
      const label = slot.taskTitle
        ? `${slot.taskTitle} (${slot.taskId.slice(0, 8)})`
        : slot.taskId.slice(0, 8);
      line += `  ${label}`;
      if (slot.elapsedMs !== null) {
        line += `  ${formatElapsed(slot.elapsedMs)}`;
      }
    }

    lines.push(line);
  }

  lines.push('');
  lines.push(
    `  Queue: ${snapshot.queueDepth} task${snapshot.queueDepth === 1 ? '' : 's'} ready`,
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * Format a StatusSnapshot with ANSI color codes for terminal output.
 */
export function formatStatusColor(snapshot: StatusSnapshot): string {
  const RESET = '\x1b[0m';
  const BOLD = '\x1b[1m';
  const DIM = '\x1b[2m';
  const GREEN = '\x1b[32m';
  const RED = '\x1b[31m';
  const YELLOW = '\x1b[33m';
  const CYAN = '\x1b[36m';

  const lines: string[] = [];

  lines.push(
    `${BOLD}NanoClaw Status${RESET}  ${DIM}${snapshot.timestamp}${RESET}`,
  );
  lines.push(`${DIM}${'─'.repeat(56)}${RESET}`);

  if (snapshot.error) {
    lines.push(`  ${RED}Error: ${snapshot.error}${RESET}`);
    lines.push('');
  }

  for (const slot of snapshot.slots) {
    let indicator: string;
    if (slot.state === 'BUSY') {
      indicator = `${RED}[BUSY]${RESET}`;
    } else if (slot.state === 'FREE') {
      indicator = `${GREEN}[FREE]${RESET}`;
    } else {
      indicator = `${YELLOW}[UNKNOWN]${RESET}`;
    }

    let line = `  Slot ${slot.index}  ${indicator}`;

    if (slot.state === 'BUSY' && slot.taskId) {
      const label = slot.taskTitle
        ? `${BOLD}${slot.taskTitle}${RESET} ${DIM}(${slot.taskId.slice(0, 8)})${RESET}`
        : `${DIM}${slot.taskId.slice(0, 8)}${RESET}`;
      line += `  ${label}`;
      if (slot.elapsedMs !== null) {
        line += `  ${CYAN}${formatElapsed(slot.elapsedMs)}${RESET}`;
      }
    }

    lines.push(line);
  }

  lines.push('');
  lines.push(
    `  ${BOLD}Queue:${RESET} ${snapshot.queueDepth} task${snapshot.queueDepth === 1 ? '' : 's'} ready`,
  );
  lines.push('');

  return lines.join('\n');
}

// --- Historical formatting helpers ---

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60)
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return `${hours}h ${remainMinutes.toString().padStart(2, '0')}m`;
}

function statusIcon(status: string): string {
  if (status === 'done') return '\u2713'; // checkmark
  if (status === 'failed') return '\u2717'; // x mark
  return '\u25cb'; // circle
}

/**
 * Format a HistoricalSnapshot as plain text with Unicode box-drawing.
 */
export function formatHistoricalPlain(
  snapshot: StatusSnapshot,
  historical: HistoricalSnapshot,
): string {
  const lines: string[] = [];
  const W = 64;

  lines.push('\u250c' + '\u2500'.repeat(W - 2) + '\u2510');
  lines.push(
    '\u2502' +
      ` NanoClaw Status Dashboard  ${snapshot.timestamp}`.padEnd(W - 2) +
      '\u2502',
  );
  lines.push('\u251c' + '\u2500'.repeat(W - 2) + '\u2524');

  // --- Current slots ---
  lines.push('\u2502' + '  Worker Slots'.padEnd(W - 2) + '\u2502');
  lines.push('\u2502' + '\u2500'.repeat(W - 2) + '\u2502');

  for (const slot of snapshot.slots) {
    const indicator =
      slot.state === 'BUSY'
        ? '[BUSY]'
        : slot.state === 'FREE'
          ? '[FREE]'
          : '[????]';
    let line = `  Slot ${slot.index}  ${indicator}`;
    if (slot.state === 'BUSY' && slot.taskId) {
      const label = slot.taskTitle
        ? `${slot.taskTitle} (${slot.taskId.slice(0, 8)})`
        : slot.taskId.slice(0, 8);
      line += `  ${label}`;
      if (slot.elapsedMs !== null) {
        line += `  ${formatElapsed(slot.elapsedMs)}`;
      }
    }
    lines.push('\u2502' + line.padEnd(W - 2) + '\u2502');
  }

  lines.push(
    '\u2502' +
      `  Queue: ${snapshot.queueDepth} task${snapshot.queueDepth === 1 ? '' : 's'} ready`.padEnd(
        W - 2,
      ) +
      '\u2502',
  );

  if (snapshot.error) {
    lines.push(
      '\u2502' + `  Error: ${snapshot.error}`.padEnd(W - 2) + '\u2502',
    );
  }

  // --- Recent Activity ---
  lines.push('\u251c' + '\u2500'.repeat(W - 2) + '\u2524');
  lines.push(
    '\u2502' + '  Recent Activity (last 10 tasks)'.padEnd(W - 2) + '\u2502',
  );
  lines.push('\u2502' + '\u2500'.repeat(W - 2) + '\u2502');

  if (historical.recentTasks.length === 0) {
    lines.push('\u2502' + '  No recent tasks'.padEnd(W - 2) + '\u2502');
  } else {
    for (const task of historical.recentTasks) {
      const icon = statusIcon(task.status);
      const dur =
        task.durationMs !== null ? formatDuration(task.durationMs) : '--';
      const title =
        task.title.length > 28 ? task.title.slice(0, 25) + '...' : task.title;
      const line = `  ${icon} ${task.id.slice(0, 8)}  ${title.padEnd(28)}  ${dur.padStart(8)}`;
      lines.push('\u2502' + line.padEnd(W - 2) + '\u2502');
    }
  }

  // --- Utilization ---
  lines.push('\u251c' + '\u2500'.repeat(W - 2) + '\u2524');
  lines.push('\u2502' + '  Worker Utilization'.padEnd(W - 2) + '\u2502');
  lines.push('\u2502' + '\u2500'.repeat(W - 2) + '\u2502');

  const { utilization } = historical;
  lines.push(
    '\u2502' +
      `  Avg slots in use:  ${utilization.avgSlotsInUse}/${PARALLEL_DISPATCH_WORKERS}`.padEnd(
        W - 2,
      ) +
      '\u2502',
  );
  lines.push(
    '\u2502' +
      `  Peak slots:        ${utilization.peakSlotsInUse}/${PARALLEL_DISPATCH_WORKERS}`.padEnd(
        W - 2,
      ) +
      '\u2502',
  );
  if (utilization.peakTime) {
    lines.push(
      '\u2502' +
        `  Peak time:         ${utilization.peakTime}`.padEnd(W - 2) +
        '\u2502',
    );
  }
  lines.push(
    '\u2502' +
      `  Idle:              ${utilization.idlePercent.toFixed(1)}%`.padEnd(
        W - 2,
      ) +
      '\u2502',
  );

  // --- Queue Metrics ---
  lines.push('\u251c' + '\u2500'.repeat(W - 2) + '\u2524');
  lines.push('\u2502' + '  Queue Metrics'.padEnd(W - 2) + '\u2502');
  lines.push('\u2502' + '\u2500'.repeat(W - 2) + '\u2502');

  const { queue } = historical;
  lines.push(
    '\u2502' +
      `  Current depth:     ${queue.avgDepth}`.padEnd(W - 2) +
      '\u2502',
  );
  lines.push(
    '\u2502' +
      `  Avg wait time:     ${formatDuration(queue.avgWaitMs)}`.padEnd(W - 2) +
      '\u2502',
  );
  const longestLabel = queue.longestWaitTaskId
    ? `${formatDuration(queue.longestWaitMs)} (${queue.longestWaitTaskId.slice(0, 8)})`
    : formatDuration(queue.longestWaitMs);
  lines.push(
    '\u2502' + `  Longest queued:    ${longestLabel}`.padEnd(W - 2) + '\u2502',
  );

  // --- Performance Trends ---
  lines.push('\u251c' + '\u2500'.repeat(W - 2) + '\u2524');
  lines.push('\u2502' + '  Performance Trends'.padEnd(W - 2) + '\u2502');
  lines.push('\u2502' + '\u2500'.repeat(W - 2) + '\u2502');

  const { performance } = historical;
  lines.push(
    '\u2502' +
      `  Avg completion:    ${formatDuration(performance.avgCompletionMs)}`.padEnd(
        W - 2,
      ) +
      '\u2502',
  );
  lines.push(
    '\u2502' +
      `  Error rate:        ${performance.errorRate.toFixed(1)}% (${performance.totalFailed}/${performance.totalCompleted + performance.totalFailed})`.padEnd(
        W - 2,
      ) +
      '\u2502',
  );

  if (performance.slowestTasks.length > 0) {
    lines.push('\u2502' + '  Slowest tasks:'.padEnd(W - 2) + '\u2502');
    for (const task of performance.slowestTasks) {
      const title =
        task.title.length > 30 ? task.title.slice(0, 27) + '...' : task.title;
      lines.push(
        '\u2502' +
          `    ${task.id.slice(0, 8)}  ${title.padEnd(30)}  ${formatDuration(task.durationMs).padStart(8)}`.padEnd(
            W - 2,
          ) +
          '\u2502',
      );
    }
  }

  if (historical.error) {
    lines.push('\u2502' + '\u2500'.repeat(W - 2) + '\u2502');
    lines.push(
      '\u2502' +
        `  Historical data error: ${historical.error}`.padEnd(W - 2) +
        '\u2502',
    );
  }

  lines.push('\u2514' + '\u2500'.repeat(W - 2) + '\u2518');
  lines.push('');

  return lines.join('\n');
}

/**
 * Format a HistoricalSnapshot with ANSI color codes.
 */
export function formatHistoricalColor(
  snapshot: StatusSnapshot,
  historical: HistoricalSnapshot,
): string {
  const RESET = '\x1b[0m';
  const BOLD = '\x1b[1m';
  const DIM = '\x1b[2m';
  const GREEN = '\x1b[32m';
  const RED = '\x1b[31m';
  const YELLOW = '\x1b[33m';
  const CYAN = '\x1b[36m';

  const W = 64;

  const lines: string[] = [];

  lines.push(`${DIM}\u250c${'\u2500'.repeat(W - 2)}\u2510${RESET}`);
  lines.push(
    `${DIM}\u2502${RESET}` +
      ` ${BOLD}NanoClaw Status Dashboard${RESET}  ${DIM}${snapshot.timestamp}${RESET}`.padEnd(
        W - 2 + (BOLD.length + RESET.length + DIM.length + RESET.length),
      ) +
      `${DIM}\u2502${RESET}`,
  );
  // Use raw approach for colored sections to avoid padEnd counting ANSI codes
  const rawLines: string[] = [];

  rawLines.push(`${DIM}\u251c${'\u2500'.repeat(W - 2)}\u2524${RESET}`);

  // --- Worker Slots ---
  rawLines.push(`${DIM}\u2502${RESET}  ${BOLD}Worker Slots${RESET}`);
  rawLines.push(`${DIM}\u2502${'\u2500'.repeat(W - 2)}\u2502${RESET}`);

  for (const slot of snapshot.slots) {
    let indicator: string;
    if (slot.state === 'BUSY') indicator = `${RED}[BUSY]${RESET}`;
    else if (slot.state === 'FREE') indicator = `${GREEN}[FREE]${RESET}`;
    else indicator = `${YELLOW}[????]${RESET}`;

    let line = `${DIM}\u2502${RESET}  Slot ${slot.index}  ${indicator}`;
    if (slot.state === 'BUSY' && slot.taskId) {
      const label = slot.taskTitle
        ? `${BOLD}${slot.taskTitle}${RESET} ${DIM}(${slot.taskId.slice(0, 8)})${RESET}`
        : `${DIM}${slot.taskId.slice(0, 8)}${RESET}`;
      line += `  ${label}`;
      if (slot.elapsedMs !== null) {
        line += `  ${CYAN}${formatElapsed(slot.elapsedMs)}${RESET}`;
      }
    }
    rawLines.push(line);
  }

  rawLines.push(
    `${DIM}\u2502${RESET}  ${BOLD}Queue:${RESET} ${snapshot.queueDepth} task${snapshot.queueDepth === 1 ? '' : 's'} ready`,
  );

  if (snapshot.error) {
    rawLines.push(
      `${DIM}\u2502${RESET}  ${RED}Error: ${snapshot.error}${RESET}`,
    );
  }

  // --- Recent Activity ---
  rawLines.push(`${DIM}\u251c${'\u2500'.repeat(W - 2)}\u2524${RESET}`);
  rawLines.push(
    `${DIM}\u2502${RESET}  ${BOLD}Recent Activity${RESET} ${DIM}(last 10 tasks)${RESET}`,
  );
  rawLines.push(`${DIM}\u2502${'\u2500'.repeat(W - 2)}\u2502${RESET}`);

  if (historical.recentTasks.length === 0) {
    rawLines.push(`${DIM}\u2502${RESET}  ${DIM}No recent tasks${RESET}`);
  } else {
    for (const task of historical.recentTasks) {
      const icon =
        task.status === 'done'
          ? `${GREEN}\u2713${RESET}`
          : task.status === 'failed'
            ? `${RED}\u2717${RESET}`
            : `${DIM}\u25cb${RESET}`;
      const dur =
        task.durationMs !== null
          ? `${CYAN}${formatDuration(task.durationMs)}${RESET}`
          : `${DIM}--${RESET}`;
      const title =
        task.title.length > 28 ? task.title.slice(0, 25) + '...' : task.title;
      rawLines.push(
        `${DIM}\u2502${RESET}  ${icon} ${DIM}${task.id.slice(0, 8)}${RESET}  ${title}  ${dur}`,
      );
    }
  }

  // --- Utilization ---
  rawLines.push(`${DIM}\u251c${'\u2500'.repeat(W - 2)}\u2524${RESET}`);
  rawLines.push(`${DIM}\u2502${RESET}  ${BOLD}Worker Utilization${RESET}`);
  rawLines.push(`${DIM}\u2502${'\u2500'.repeat(W - 2)}\u2502${RESET}`);

  const { utilization } = historical;
  rawLines.push(
    `${DIM}\u2502${RESET}  Avg slots in use:  ${CYAN}${utilization.avgSlotsInUse}/${PARALLEL_DISPATCH_WORKERS}${RESET}`,
  );
  rawLines.push(
    `${DIM}\u2502${RESET}  Peak slots:        ${CYAN}${utilization.peakSlotsInUse}/${PARALLEL_DISPATCH_WORKERS}${RESET}`,
  );
  if (utilization.peakTime) {
    rawLines.push(
      `${DIM}\u2502${RESET}  Peak time:         ${DIM}${utilization.peakTime}${RESET}`,
    );
  }
  const idleColor =
    utilization.idlePercent > 75
      ? GREEN
      : utilization.idlePercent > 25
        ? YELLOW
        : RED;
  rawLines.push(
    `${DIM}\u2502${RESET}  Idle:              ${idleColor}${utilization.idlePercent.toFixed(1)}%${RESET}`,
  );

  // --- Queue Metrics ---
  rawLines.push(`${DIM}\u251c${'\u2500'.repeat(W - 2)}\u2524${RESET}`);
  rawLines.push(`${DIM}\u2502${RESET}  ${BOLD}Queue Metrics${RESET}`);
  rawLines.push(`${DIM}\u2502${'\u2500'.repeat(W - 2)}\u2502${RESET}`);

  const { queue } = historical;
  rawLines.push(
    `${DIM}\u2502${RESET}  Current depth:     ${CYAN}${queue.avgDepth}${RESET}`,
  );
  rawLines.push(
    `${DIM}\u2502${RESET}  Avg wait time:     ${CYAN}${formatDuration(queue.avgWaitMs)}${RESET}`,
  );
  const longestLabel = queue.longestWaitTaskId
    ? `${formatDuration(queue.longestWaitMs)} ${DIM}(${queue.longestWaitTaskId.slice(0, 8)})${RESET}`
    : formatDuration(queue.longestWaitMs);
  rawLines.push(
    `${DIM}\u2502${RESET}  Longest queued:    ${CYAN}${longestLabel}${RESET}`,
  );

  // --- Performance Trends ---
  rawLines.push(`${DIM}\u251c${'\u2500'.repeat(W - 2)}\u2524${RESET}`);
  rawLines.push(`${DIM}\u2502${RESET}  ${BOLD}Performance Trends${RESET}`);
  rawLines.push(`${DIM}\u2502${'\u2500'.repeat(W - 2)}\u2502${RESET}`);

  const { performance } = historical;
  rawLines.push(
    `${DIM}\u2502${RESET}  Avg completion:    ${CYAN}${formatDuration(performance.avgCompletionMs)}${RESET}`,
  );
  const errColor =
    performance.errorRate > 10
      ? RED
      : performance.errorRate > 0
        ? YELLOW
        : GREEN;
  rawLines.push(
    `${DIM}\u2502${RESET}  Error rate:        ${errColor}${performance.errorRate.toFixed(1)}%${RESET} ${DIM}(${performance.totalFailed}/${performance.totalCompleted + performance.totalFailed})${RESET}`,
  );

  if (performance.slowestTasks.length > 0) {
    rawLines.push(`${DIM}\u2502${RESET}  Slowest tasks:`);
    for (const task of performance.slowestTasks) {
      const title =
        task.title.length > 30 ? task.title.slice(0, 27) + '...' : task.title;
      rawLines.push(
        `${DIM}\u2502${RESET}    ${DIM}${task.id.slice(0, 8)}${RESET}  ${title}  ${CYAN}${formatDuration(task.durationMs)}${RESET}`,
      );
    }
  }

  if (historical.error) {
    rawLines.push(`${DIM}\u2502${'\u2500'.repeat(W - 2)}\u2502${RESET}`);
    rawLines.push(
      `${DIM}\u2502${RESET}  ${RED}Historical data error: ${historical.error}${RESET}`,
    );
  }

  rawLines.push(`${DIM}\u2514${'\u2500'.repeat(W - 2)}\u2518${RESET}`);
  rawLines.push('');

  return lines.join('\n') + '\n' + rawLines.join('\n');
}
