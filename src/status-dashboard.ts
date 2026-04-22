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
