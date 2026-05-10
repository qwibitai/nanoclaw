import Database from 'better-sqlite3';
import fs from 'fs';

import { log } from '../../log.js';
import { outboundDbPath } from '../../session-manager.js';
import type { Task } from './db/tasks.js';

export type TaskActionDecision =
  | { action: 'ok' }
  | { action: 'fail-deadline' }
  | { action: 'fail-no-progress' }
  | { action: 'fail-container-exit' }
  | { action: 'fail-spawn-deadline' };

/**
 * Pure decision function for whether a task should be reaped this sweep tick.
 * No IO — all DB reads happen at the call site (C3).
 * Decision order is load-bearing (C20, M24, C21) — do not reorder.
 */
export function decideTaskAction(args: {
  now: number;
  task: Task;
  childContainerStatus: 'running' | 'stopped' | null;
  terminalOutboundSeenAt: string | null;
  noProgressTimeoutSec: number;
  spawnDeadlineSec: number;
  drainGraceSec: number;
}): TaskActionDecision {
  const {
    now,
    task,
    childContainerStatus,
    terminalOutboundSeenAt,
    noProgressTimeoutSec,
    spawnDeadlineSec,
    drainGraceSec,
  } = args;

  // 1. Hard deadline — ALWAYS wins, even over drain-first (C20).
  if (task.deadline !== null) {
    const deadlineMs = Date.parse(task.deadline);
    if (!Number.isNaN(deadlineMs) && now > deadlineMs) {
      return { action: 'fail-deadline' };
    }
  }

  // 2. Spawn deadline — only for pending tasks that have been admitted but not yet started.
  if (task.status === 'pending' && task.admitted_at !== null && task.started_at === null) {
    const admittedMs = Date.parse(task.admitted_at);
    if (!Number.isNaN(admittedMs) && now - admittedMs > spawnDeadlineSec * 1000) {
      return { action: 'fail-spawn-deadline' };
    }
    // Still within spawn window — reconciler will complete admission.
    return { action: 'ok' };
  }

  // 3. Drain-first guard (M24) — activates ONLY when a terminal dispatch action
  //    is pending in the child's outbound.db. Grace measured from THAT row's
  //    timestamp, not from last_progress_at.
  if (terminalOutboundSeenAt !== null) {
    const seenAtMs = Date.parse(terminalOutboundSeenAt);
    if (!Number.isNaN(seenAtMs)) {
      const drainAge = now - seenAtMs;
      if (drainAge <= drainGraceSec * 1000) {
        return { action: 'ok' };
      }
      // Grace elapsed — fall through to terminal evaluation.
    }
  }

  // 4. No-progress timer with triple fallback (C21):
  //    last_signal = last_progress_at OR started_at OR admitted_at
  const lastSignalStr = task.last_progress_at ?? task.started_at ?? task.admitted_at;
  if (lastSignalStr !== null) {
    const lastSignalMs = Date.parse(lastSignalStr);
    if (!Number.isNaN(lastSignalMs) && now - lastSignalMs > noProgressTimeoutSec * 1000) {
      return { action: 'fail-no-progress' };
    }
  }

  // 5. Container exit — only meaningful when there is a known child session.
  if (task.child_session_id !== null && childContainerStatus === 'stopped') {
    return { action: 'fail-container-exit' };
  }

  return { action: 'ok' };
}

/**
 * Reads the child session's outbound.db and returns the earliest timestamp of
 * any pending terminal spawn system action (spawn_complete or spawn_failed),
 * or null if none exists.
 *
 * Host-invariant: opens outbound.db read-only (container is the sole writer).
 * Content is deserialized as JSON to avoid substring false-positive matches (S20).
 */
export function pendingTerminalSpawnOutboundSeenAt(agentGroupId: string, sessionId: string): string | null {
  const dbPath = outboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return null;

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });

    const rows = db.prepare(`SELECT timestamp, content FROM messages_out WHERE kind = 'system'`).all() as Array<{
      timestamp: string;
      content: string;
    }>;

    let earliest: string | null = null;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.content) as Record<string, unknown>;
        if (parsed.action === 'spawn_complete' || parsed.action === 'spawn_failed') {
          if (earliest === null || row.timestamp < earliest) {
            earliest = row.timestamp;
          }
        }
      } catch {
        // Skip rows with invalid JSON
      }
    }
    return earliest;
  } catch (err) {
    log.warn('pendingTerminalSpawnOutboundSeenAt: failed to read outbound.db', { agentGroupId, sessionId, err });
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore close errors */
    }
  }
}
