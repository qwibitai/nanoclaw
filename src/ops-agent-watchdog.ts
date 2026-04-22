/**
 * Ops-Agent Dispatch Watchdog
 *
 * Periodically checks for stuck dispatch slots — slots in 'executing' state
 * with no corresponding tmux session. When detected, restarts NanoClaw via
 * systemctl so that stale slot recovery (recoverStaleSlots) can clean up on
 * the next boot.
 *
 * Registered as an interval scheduled task (15 min) in SQLite via
 * ensureWatchdogTask() so it appears in NanoClaw's standard cron/task flow.
 * Default interval: 15 minutes.
 */

import { execSync } from 'child_process';

import { agencyFetch } from './agency-hq-client.js';
import { createTask, getTaskById, updateTaskAfterRun } from './db/index.js';
import { getDispatchSlotBackend } from './dispatch-slot-backends.js';
import { createCorrelationLogger, logger } from './logger.js';
import { getAgentRuntime } from './runtime-adapter.js';
import type { NotificationBatcher } from './notification-batcher.js';
import type { SchedulerDependencies } from './task-scheduler.js';

export const OPS_AGENT_WATCHDOG_INTERVAL = 15 * 60_000; // 15 minutes

/** Max retries for transient Agency HQ API failures within a single tick. */
const AHQ_MAX_RETRIES = 3;

/** Base delay between retries (doubles each attempt). */
const AHQ_RETRY_BASE_MS = 1_000;

/** Cooldown after a restart to avoid restart loops. */
const RESTART_COOLDOWN_MS = 20 * 60_000; // 20 minutes

/**
 * Grace period before a slot can be considered stuck.
 * Slots that entered 'executing' less than this duration ago are assumed to be
 * legitimately working — their worker process may still be starting up.
 */
export const SLOT_GRACE_PERIOD_MS = 5 * 60_000; // 5 minutes

/** Well-known task ID for the watchdog scheduled task row. */
export const WATCHDOG_TASK_ID = 'ops-dispatch-watchdog';

let lastRestartTimestamp = 0;

// --- Retry helper ---

/**
 * Retry an async operation with exponential backoff.
 * Returns the result on success, or throws the last error after exhausting retries.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  log: ReturnType<typeof createCorrelationLogger>,
  label: string,
  maxRetries = AHQ_MAX_RETRIES,
  baseMs = AHQ_RETRY_BASE_MS,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries - 1) {
        const delayMs = baseMs * Math.pow(2, attempt);
        log.warn(
          { err, attempt: attempt + 1, maxRetries, delayMs, label },
          `Retrying ${label} after transient failure`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastErr;
}

// --- Scheduled task registration ---

/**
 * Ensure the watchdog is registered as an interval scheduled task in SQLite.
 * Idempotent — skips if the row already exists (INSERT OR IGNORE).
 */
export function ensureWatchdogTask(): void {
  const existing = getTaskById(WATCHDOG_TASK_ID);
  if (existing) return;

  const now = new Date().toISOString();
  const nextRun = new Date(
    Date.now() + OPS_AGENT_WATCHDOG_INTERVAL,
  ).toISOString();

  createTask({
    id: WATCHDOG_TASK_ID,
    group_folder: 'system',
    chat_jid: 'internal:ops-watchdog',
    prompt: '__ops_watchdog_tick__',
    schedule_type: 'interval',
    schedule_value: String(OPS_AGENT_WATCHDOG_INTERVAL),
    context_mode: 'isolated',
    next_run: nextRun,
    status: 'active',
    created_at: now,
  });

  logger.info(
    { taskId: WATCHDOG_TASK_ID, nextRun },
    'Registered ops-watchdog scheduled task',
  );
}

// --- Core detection ---

export interface StuckSlotInfo {
  slotId: number;
  slotIndex: number;
  ahqTaskId: string;
  state: string;
  /** How long the slot has been in 'executing' state (ms), or null if unknown. */
  slotAgeMs: number | null;
  /** Whether a tmux session matching the slot prefix was found. */
  hasSession: boolean;
}

/**
 * Detect stuck dispatch slots: slots in 'executing' state with no
 * corresponding tmux session running AND past the grace period.
 *
 * A slot is considered stuck only when ALL of these conditions are met:
 * 1. It has been in 'executing' state for longer than SLOT_GRACE_PERIOD_MS
 * 2. No tmux session matching its worker prefix exists
 * 3. The runtime confirms the session does not exist (double-check via hasSession)
 *
 * Returns the list of stuck slots, or empty if everything is healthy.
 */
export async function detectStuckSlots(): Promise<StuckSlotInfo[]> {
  const log = createCorrelationLogger(undefined, { op: 'ops-watchdog' });
  const now = Date.now();

  let activeSlots;
  try {
    activeSlots = await withRetry(
      () => getDispatchSlotBackend().listActiveSlots(),
      log,
      'listActiveSlots',
    );
  } catch (err) {
    log.error({ err }, 'Failed to query active dispatch slots after retries');
    return [];
  }

  if (activeSlots.length === 0) return [];

  // Get all nanoclaw tmux sessions for per-slot matching
  let activeSessions: string[];
  try {
    activeSessions = getAgentRuntime().listSessionNames('nanoclaw-');
  } catch (err) {
    log.warn({ err }, 'Failed to list tmux sessions');
    // If we can't check tmux, don't trigger a false positive
    return [];
  }

  const runtime = getAgentRuntime();

  // Check each executing slot against its expected session prefix
  const stuckSlots: StuckSlotInfo[] = [];
  for (const slot of activeSlots) {
    if (slot.state !== 'executing') continue;

    // Calculate slot age from executing_at timestamp
    const slotAgeMs = slot.executingAt
      ? now - new Date(slot.executingAt).getTime()
      : null;

    // Grace period: skip slots that entered executing recently
    if (slotAgeMs !== null && slotAgeMs < SLOT_GRACE_PERIOD_MS) {
      log.debug(
        {
          slotIndex: slot.slotIndex,
          ahqTaskId: slot.ahqTaskId,
          slotAgeMs,
          gracePeriodMs: SLOT_GRACE_PERIOD_MS,
        },
        'Slot within grace period, skipping stuck check',
      );
      continue;
    }

    // Worker slot sessions are named nanoclaw-devworker{slotIndex}-{timestamp}
    const sessionPrefix = `nanoclaw-devworker${slot.slotIndex}-`;
    const hasMatchingSession = activeSessions.some((name) =>
      name.startsWith(sessionPrefix),
    );

    if (hasMatchingSession) continue;

    // Double-check: use hasSession for a direct tmux has-session query
    // in case the list was stale or incomplete.
    let hasSessionConfirmed = false;
    try {
      hasSessionConfirmed = runtime.hasSession(
        `nanoclaw-devworker${slot.slotIndex}`,
      );
    } catch {
      // hasSession failure — treat as no session found
    }

    if (hasSessionConfirmed) {
      log.debug(
        {
          slotIndex: slot.slotIndex,
          ahqTaskId: slot.ahqTaskId,
        },
        'Slot has active process confirmed via hasSession, not stuck',
      );
      continue;
    }

    stuckSlots.push({
      slotId: slot.slotId,
      slotIndex: slot.slotIndex,
      ahqTaskId: slot.ahqTaskId,
      state: slot.state,
      slotAgeMs,
      hasSession: false,
    });
  }

  if (stuckSlots.length > 0) {
    log.warn(
      {
        stuckCount: stuckSlots.length,
        totalExecuting: activeSlots.filter((s) => s.state === 'executing')
          .length,
        activeSessions: activeSessions.length,
        slots: stuckSlots.map((s) => ({
          slotIndex: s.slotIndex,
          ahqTaskId: s.ahqTaskId,
          slotAgeMs: s.slotAgeMs,
          hasSession: s.hasSession,
        })),
      },
      'Detected stuck dispatch slots (executing past grace period with no worker process)',
    );
  }

  return stuckSlots;
}

// --- Recovery action ---

/**
 * Restart NanoClaw via systemctl to trigger stale slot recovery on next boot.
 * Returns true if the restart was initiated successfully.
 */
export function restartNanoClaw(): boolean {
  const log = createCorrelationLogger(undefined, {
    op: 'ops-watchdog-restart',
  });

  // Cooldown check — avoid restart loops
  const now = Date.now();
  if (now - lastRestartTimestamp < RESTART_COOLDOWN_MS) {
    log.warn(
      {
        lastRestart: new Date(lastRestartTimestamp).toISOString(),
        cooldownMs: RESTART_COOLDOWN_MS,
      },
      'Restart cooldown active, skipping restart',
    );
    return false;
  }

  try {
    execSync('systemctl --user restart nanoclaw', {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    });
    lastRestartTimestamp = now;
    log.info('NanoClaw restart initiated via systemctl');
    return true;
  } catch (err) {
    log.error({ err }, 'Failed to restart NanoClaw via systemctl');
    return false;
  }
}

// --- Recovery logging ---

/**
 * Log the recovery action to Agency HQ via the notifications endpoint.
 * Retries with exponential backoff on transient failures.
 */
async function logRecoveryToAgencyHq(
  stuckSlots: StuckSlotInfo[],
  log: ReturnType<typeof createCorrelationLogger>,
): Promise<void> {
  try {
    await withRetry(
      () =>
        agencyFetch('/notifications', {
          method: 'POST',
          body: JSON.stringify({
            type: 'dispatch-watchdog-recovery',
            title: `Ops watchdog: restarted NanoClaw — ${stuckSlots.length} stuck slot(s) detected`,
            target: 'ceo',
            channel: 'telegram',
            reference_type: 'system',
            reference_id: `watchdog-${Date.now()}`,
            metadata: {
              stuck_slots: stuckSlots.map((s) => ({
                slot_index: s.slotIndex,
                ahq_task_id: s.ahqTaskId,
                slot_age_ms: s.slotAgeMs,
                has_session: s.hasSession,
              })),
              timestamp: new Date().toISOString(),
            },
          }),
        }),
      log,
      'logRecoveryToAgencyHq',
    );
  } catch (err) {
    log.error({ err }, 'Failed to log recovery to Agency HQ after retries');
  }
}

// --- Notification ---

/**
 * Find the CEO group JID for sending watchdog notifications.
 */
function findCeoJid(
  deps: SchedulerDependencies,
): { jid: string; folder: string } | null {
  const groups = deps.registeredGroups();
  for (const [jid, group] of Object.entries(groups)) {
    if (group.folder === 'ceo') return { jid, folder: group.folder };
  }
  return null;
}

// --- Main tick ---

/**
 * Single watchdog tick: detect stuck slots and recover if needed.
 * Exported for testing.
 */
export async function runWatchdogTick(
  deps: SchedulerDependencies,
  isStopping: () => boolean,
  notificationBatcher?: NotificationBatcher,
): Promise<void> {
  if (isStopping()) return;

  const log = createCorrelationLogger(undefined, { op: 'ops-watchdog' });

  const stuckSlots = await detectStuckSlots();
  if (stuckSlots.length === 0) return;

  log.warn(
    { count: stuckSlots.length },
    'Stuck dispatch slots detected, initiating recovery',
  );

  // Send Telegram notification before restart (restart kills this process)
  const ceo = findCeoJid(deps);
  if (ceo) {
    const slotDetails = stuckSlots
      .map((s) => {
        const ageMin = s.slotAgeMs !== null ? Math.round(s.slotAgeMs / 60_000) : '?';
        return `slot ${s.slotIndex} (task: ${s.ahqTaskId}, age: ${ageMin}min, process: none)`;
      })
      .join('\n');
    const msg = `🔧 *Ops Watchdog Recovery*\nDetected ${stuckSlots.length} stuck dispatch slot(s):\n${slotDetails}\nRestarting NanoClaw to trigger slot recovery.`;
    try {
      if (notificationBatcher) {
        await notificationBatcher.send(ceo.jid, msg, 'critical');
      } else {
        await deps.sendMessage(ceo.jid, msg);
      }
    } catch (err) {
      log.error({ err }, 'Failed to send watchdog notification');
    }
  }

  // Log to Agency HQ
  await logRecoveryToAgencyHq(stuckSlots, log);

  // Restart NanoClaw
  const restarted = restartNanoClaw();

  if (!restarted) {
    log.error('Recovery restart failed or on cooldown — stuck slots remain');
  }
}

// --- Lifecycle ---

let watchdogIntervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Update the watchdog's scheduled task row after each tick so cron bookkeeping
 * (last_run, next_run) stays current.
 */
function updateWatchdogTaskRow(): void {
  try {
    const now = new Date().toISOString();
    const nextRun = new Date(
      Date.now() + OPS_AGENT_WATCHDOG_INTERVAL,
    ).toISOString();
    updateTaskAfterRun(WATCHDOG_TASK_ID, nextRun, `Ran at ${now}`);
  } catch {
    // Non-fatal — the interval still fires regardless of bookkeeping.
  }
}

export function startOpsAgentWatchdog(
  deps: SchedulerDependencies,
  isStopping: () => boolean,
  notificationBatcher?: NotificationBatcher,
): void {
  // Register the watchdog as a scheduled task in SQLite (idempotent).
  try {
    ensureWatchdogTask();
  } catch (err) {
    logger.warn({ err }, 'Failed to register watchdog scheduled task row');
  }

  logger.info(
    { intervalMs: OPS_AGENT_WATCHDOG_INTERVAL },
    'Starting ops-agent dispatch watchdog',
  );

  watchdogIntervalHandle = setInterval(() => {
    runWatchdogTick(deps, isStopping, notificationBatcher)
      .then(() => updateWatchdogTaskRow())
      .catch((err) =>
        logger.error({ err }, 'Ops watchdog tick failed'),
      );
  }, OPS_AGENT_WATCHDOG_INTERVAL);
}

export function stopOpsAgentWatchdog(): void {
  if (watchdogIntervalHandle) {
    clearInterval(watchdogIntervalHandle);
    watchdogIntervalHandle = null;
  }
}

/** Reset module state (for testing). */
export function _resetWatchdogState(): void {
  lastRestartTimestamp = 0;
  stopOpsAgentWatchdog();
}
