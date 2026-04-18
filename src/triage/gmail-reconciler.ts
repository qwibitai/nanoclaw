import type Database from 'better-sqlite3';

import type { GmailOps } from '../gmail-ops.js';
import { logger } from '../logger.js';

/**
 * Gmail → local state reconciler.
 *
 * Catches out-of-band archives: if the user archives a thread directly in
 * Gmail (phone, web, another client), the local tracked_items row is still
 * 'queued' — the mini-app would keep showing it. This loop scans queued
 * gmail items and marks them resolved when their thread no longer has the
 * INBOX label.
 *
 * Design choices:
 * - Gmail is the source of truth. Local state converges to Gmail, never
 *   the other way around.
 * - Race guard: skip items detected < RACE_GUARD_MS ago. The triage
 *   worker may still be writing to them.
 * - Per-thread `threads.get` (metadata format) is cheap and bounded by
 *   queue size. Rotating threads.list with history IDs would be more
 *   efficient for large queues but adds complexity for little gain at
 *   current volumes.
 * - Failures are logged but non-fatal: a single 500 from Gmail must not
 *   halt the loop.
 */

export const RECONCILE_INTERVAL_MS = 2 * 60 * 1000;
export const RACE_GUARD_MS = 60 * 1000;
export const MAX_ITEMS_PER_TICK = 100;

export interface ReconcileDeps {
  db: Database.Database;
  gmailOps: Pick<GmailOps, 'getThreadInboxStatus'>;
  now?: () => number;
  logger?: Pick<typeof logger, 'info' | 'warn' | 'error'>;
}

export interface ReconcileResult {
  checked: number;
  resolved: number;
  skipped: number;
  errors: number;
}

interface QueuedRow {
  id: string;
  thread_id: string;
  metadata: string | null;
}

/**
 * One reconciler pass. Exposed separately from the loop so tests can
 * drive it directly and assert the resulting DB state.
 */
export async function reconcileOnce(
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const now = (deps.now ?? Date.now)();
  const log = deps.logger ?? logger;

  const rows = deps.db
    .prepare(
      `SELECT id, thread_id, metadata FROM tracked_items
       WHERE state = 'queued'
         AND source = 'gmail'
         AND thread_id IS NOT NULL
         AND detected_at < ?
       LIMIT ?`,
    )
    .all(now - RACE_GUARD_MS, MAX_ITEMS_PER_TICK) as QueuedRow[];

  const result: ReconcileResult = {
    checked: 0,
    resolved: 0,
    skipped: 0,
    errors: 0,
  };

  if (rows.length === 0) return result;

  const resolveStmt = deps.db.prepare(
    `UPDATE tracked_items
     SET state = 'resolved',
         resolution_method = 'gmail:external',
         resolved_at = ?
     WHERE state = 'queued' AND id = ?`,
  );

  for (const row of rows) {
    let account: string | null = null;
    if (row.metadata) {
      try {
        const m = JSON.parse(row.metadata) as { account?: string };
        account = m.account ?? null;
      } catch {
        // malformed metadata — skip silently
      }
    }
    if (!account) {
      result.skipped++;
      continue;
    }

    result.checked++;
    try {
      const status = await deps.gmailOps.getThreadInboxStatus(
        account,
        row.thread_id,
      );
      if (status === 'in') continue;
      // 'out' = user archived outside the mini-app
      // 'missing' = thread deleted; treat as resolved too
      resolveStmt.run(now, row.id);
      result.resolved++;
    } catch (err) {
      result.errors++;
      log.warn(
        { itemId: row.id, threadId: row.thread_id, account, err },
        'Gmail reconciler: thread check failed',
      );
    }
  }

  if (result.resolved > 0 || result.errors > 0) {
    log.info({ ...result }, 'Gmail reconciler tick');
  }
  return result;
}

/**
 * Start the reconciler loop. Returns a stop function for tests / shutdown.
 */
export function startGmailReconciler(
  deps: ReconcileDeps,
  intervalMs: number = RECONCILE_INTERVAL_MS,
): () => void {
  const log = deps.logger ?? logger;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await reconcileOnce(deps);
    } catch (err) {
      log.error({ err }, 'Gmail reconciler tick crashed');
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // Fire one tick immediately so startup catches up without waiting.
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
