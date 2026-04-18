/**
 * Inbound message operations (container side).
 *
 * Reads from inbound.db (host-owned, opened read-only).
 * Writes processing status to processing_ack in outbound.db (container-owned).
 *
 * The container never writes to inbound.db — all status tracking goes through
 * processing_ack. The host reads processing_ack to sync message lifecycle.
 */
import { getInboundDb, getOutboundDb } from './connection.js';

export interface MessageInRow {
  id: string;
  seq: number | null;
  kind: string;
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

/**
 * Fetch pending messages that are due for processing.
 * Reads from inbound.db (read-only), filters against processing_ack in outbound.db
 * to skip messages already picked up by this or a previous container run.
 */
export function getPendingMessages(): MessageInRow[] {
  const inbound = getInboundDb();
  const outbound = getOutboundDb();

  const pending = inbound
    .prepare(
      `SELECT * FROM messages_in
       WHERE status = 'pending'
         AND (process_after IS NULL OR datetime(process_after) <= datetime('now'))
       ORDER BY timestamp ASC`,
    )
    .all() as MessageInRow[];

  if (pending.length === 0) return [];

  // Filter out messages already acknowledged in outbound.db
  const ackedIds = new Set(
    (outbound.prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>).map(
      (r) => r.message_id,
    ),
  );

  return pending.filter((m) => !ackedIds.has(m.id));
}

/** Mark messages as processing — writes to processing_ack in outbound.db. */
export function markProcessing(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'processing', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

/** Mark messages as completed — updates processing_ack in outbound.db. */
export function markCompleted(ids: string[]): void {
  if (ids.length === 0) return;
  const db = getOutboundDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'completed', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  );
  db.transaction(() => {
    for (const id of ids) stmt.run(id);
  })();
}

/** Mark a single message as failed — writes to processing_ack in outbound.db. */
export function markFailed(id: string): void {
  getOutboundDb()
    .prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, 'failed', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
    )
    .run(id);
}

/** Get a message by ID (read from inbound.db). */
export function getMessageIn(id: string): MessageInRow | undefined {
  return getInboundDb().prepare('SELECT * FROM messages_in WHERE id = ?').get(id) as MessageInRow | undefined;
}

/**
 * Find a pending response to a question (by questionId in content).
 * Reads from inbound.db, checks processing_ack to skip already-handled responses.
 */
export function findQuestionResponse(questionId: string): MessageInRow | undefined {
  const inbound = getInboundDb();
  const outbound = getOutboundDb();

  const response = inbound
    .prepare("SELECT * FROM messages_in WHERE status = 'pending' AND content LIKE ?")
    .get(`%"questionId":"${questionId}"%`) as MessageInRow | undefined;

  if (!response) return undefined;

  // Check it hasn't been acked already
  const acked = outbound.prepare('SELECT 1 FROM processing_ack WHERE message_id = ?').get(response.id);
  if (acked) return undefined;

  return response;
}

