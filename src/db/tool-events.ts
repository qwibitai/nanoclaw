import Database from 'better-sqlite3';

let db: Database.Database;

/** @internal */
export function _setToolEventsDb(database: Database.Database): void {
  db = database;
}

export interface ToolCallEvent {
  id: number;
  session_id: string;
  group_folder: string;
  tool_name: string;
  tool_use_id: string | null;
  hook_event: string;
  tool_input: string | null;
  tool_response: string | null;
  created_at: string;
}

export interface InsertToolCallEvent {
  session_id: string;
  group_folder: string;
  tool_name: string;
  tool_use_id?: string;
  hook_event: string;
  tool_input?: string;
  tool_response?: string;
}

const MAX_TOOL_RESPONSE_LENGTH = 2048;

export function insertToolCallEvent(event: InsertToolCallEvent): void {
  const toolResponse = event.tool_response
    ? event.tool_response.slice(0, MAX_TOOL_RESPONSE_LENGTH)
    : null;

  db.prepare(
    `INSERT INTO tool_call_events (session_id, group_folder, tool_name, tool_use_id, hook_event, tool_input, tool_response)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.session_id,
    event.group_folder,
    event.tool_name,
    event.tool_use_id ?? null,
    event.hook_event,
    event.tool_input ?? null,
    toolResponse,
  );
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
      `SELECT id, session_id, group_folder, tool_name, tool_use_id, hook_event, tool_input, tool_response, created_at
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
