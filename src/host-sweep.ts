/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * Two-DB architecture:
 *   - Reads processing_ack from outbound.db to sync message status
 *   - Writes to inbound.db (host-owned) for status updates and recurrence
 *   - Uses heartbeat file mtime for stale container detection (not DB writes)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 */
import type Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { getActiveSessions, updateSession } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import {
  countDueMessages,
  syncProcessingAcks,
  getStuckProcessingIds,
  getMessageForRetry,
  markMessageFailed,
  retryWithBackoff,
  getCompletedRecurring,
  insertRecurrence,
  clearRecurrence,
} from './db/session-db.js';
import { toSqliteUtc } from './db/sqlite-utc.js';
import { log } from './log.js';
import { openInboundDb, openOutboundDb, inboundDbPath, outboundDbPath, heartbeatPath } from './session-manager.js';
import { wakeContainer, isContainerRunning } from './container-runner.js';
import type { Session } from './types.js';

const SWEEP_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

let running = false;

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
}

async function sweep(): Promise<void> {
  if (!running) return;

  try {
    const sessions = getActiveSessions();
    for (const session of sessions) {
      await sweepSession(session);
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

async function sweepSession(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return;
  }

  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch {
    // outbound.db might not exist yet (container hasn't started)
  }

  try {
    // 1. Sync processing_ack → messages_in status
    if (outDb) {
      syncProcessingAcks(inDb, outDb);
    }

    // 2. Check for due pending messages → wake container
    const dueCount = countDueMessages(inDb);

    if (dueCount > 0 && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
      await wakeContainer(session);
    }

    // 3. Detect stale containers via heartbeat file
    if (outDb) {
      detectStaleContainers(inDb, outDb, session, agentGroup.id);
    }

    // 4. Handle recurrence for completed messages
    handleRecurrence(inDb, session);
  } finally {
    inDb.close();
    outDb?.close();
  }
}

/**
 * Detect stale containers using heartbeat file mtime.
 * If the heartbeat is older than STALE_THRESHOLD and processing_ack has
 * 'processing' entries, the container likely crashed — reset with backoff.
 */
function detectStaleContainers(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
): void {
  const hbPath = heartbeatPath(agentGroupId, session.id);
  let heartbeatAge = Infinity;
  try {
    const stat = fs.statSync(hbPath);
    heartbeatAge = Date.now() - stat.mtimeMs;
  } catch {
    // No heartbeat file — container may never have started, or it's very old
  }

  if (heartbeatAge < STALE_THRESHOLD_MS) return; // Container is alive

  // Heartbeat is stale — check for stuck processing entries
  const processingIds = getStuckProcessingIds(outDb);
  if (processingIds.length === 0) return;

  for (const messageId of processingIds) {
    const msg = getMessageForRetry(inDb, messageId, 'pending');
    if (!msg) continue;

    if (msg.tries >= MAX_TRIES) {
      markMessageFailed(inDb, msg.id);
      log.warn('Message marked as failed after max retries', { messageId: msg.id, sessionId: session.id });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      retryWithBackoff(inDb, msg.id, backoffSec);
      log.info('Reset stale message with backoff', { messageId: msg.id, tries: msg.tries, backoffMs });
    }
  }
}

/**
 * Insert the next occurrence for each completed recurring message. Synchronous
 * because the caller (sweepSession) closes inDb in its finally — if this was
 * async with an unawaited dynamic import, inDb would close mid-call and
 * insertRecurrence would throw "database connection is not open". See Plan 2.6
 * spec §2 (Bug B) for the original failure mode.
 *
 * Exported so src/host-sweep.test.ts can test it directly.
 */
export function handleRecurrence(inDb: Database.Database, session: Session): void {
  const recurring = getCompletedRecurring(inDb);

  for (const msg of recurring) {
    try {
      const interval = CronExpressionParser.parse(msg.recurrence);
      const nextRun = toSqliteUtc(interval.next().toDate());
      const newId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      insertRecurrence(inDb, msg, newId, nextRun);
      clearRecurrence(inDb, msg.id);

      log.info('Inserted next recurrence', { originalId: msg.id, newId, nextRun });
    } catch (err) {
      log.error('Failed to compute next recurrence', { messageId: msg.id, recurrence: msg.recurrence, err });
    }
  }
}
