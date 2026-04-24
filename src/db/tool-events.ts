import Database from 'better-sqlite3';

let db: Database.Database;

/** @internal */
export function _setToolEventsDb(database: Database.Database): void {
  db = database;
}

export interface ToolCallEvent {
  id: number;
  session_id: string;
  event_type: string;
  tool_name: string;
  payload: string | null;
  created_at: string;
}

export interface InsertToolCallEvent {
  session_id: string;
  event_type: string;
  tool_name: string;
  payload?: Record<string, unknown>;
}

const MAX_PAYLOAD_LENGTH = 4096;

export function insertToolCallEvent(event: InsertToolCallEvent): void {
  let payloadStr: string | null = null;
  if (event.payload) {
    payloadStr = JSON.stringify(event.payload);
    if (payloadStr.length > MAX_PAYLOAD_LENGTH) {
      payloadStr = payloadStr.slice(0, MAX_PAYLOAD_LENGTH);
    }
  }

  db.prepare(
    `INSERT INTO tool_call_events (session_id, event_type, tool_name, payload)
     VALUES (?, ?, ?, ?)`,
  ).run(event.session_id, event.event_type, event.tool_name, payloadStr);
}

/**
 * Get recent tool call events, defaulting to last 5 minutes.
 * Uses SQLite's datetime() for comparison since created_at uses SQLite format.
 */
export function getRecentToolEvents(
  minutesAgo: number = 5,
  limit: number = 100,
): ToolCallEvent[] {
  return db
    .prepare(
      `SELECT id, session_id, event_type, tool_name, payload, created_at
       FROM tool_call_events
       WHERE created_at >= datetime('now', ?)
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(`-${minutesAgo} minutes`, limit) as ToolCallEvent[];
}

/**
 * Delete tool call events older than the given retention period.
 */
export function pruneToolEvents(retentionDays: number = 7): number {
  const result = db
    .prepare(
      `DELETE FROM tool_call_events WHERE created_at < datetime('now', ?)`,
    )
    .run(`-${retentionDays} days`);
  return result.changes;
}
