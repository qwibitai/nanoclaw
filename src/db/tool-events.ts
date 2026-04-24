import Database from 'better-sqlite3';

export interface ToolEvent {
  id: number;
  session_id: string;
  group_folder: string;
  tool_name: string;
  tool_use_id: string | null;
  hook_event: string;
  tool_input: string | null;
  tool_response: string | null;
  timestamp: string;
  created_at: string;
}

let db: Database.Database | null = null;

/** @internal - set database instance. Called from db/index.ts */
export function _setToolEventsDb(database: Database.Database): void {
  db = database;
}

function getDb(): Database.Database {
  if (!db) {
    throw new Error(
      'Tool events database not initialized. Call initDatabase() first.',
    );
  }
  return db;
}

/**
 * Insert a tool call event from IPC processing.
 */
export function insertToolEvent(event: {
  session_id: string;
  group_folder: string;
  tool_name: string;
  tool_use_id?: string;
  hook_event: string;
  tool_input?: string;
  tool_response?: string;
  timestamp: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO tool_call_events (session_id, group_folder, tool_name, tool_use_id, hook_event, tool_input, tool_response, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.session_id,
      event.group_folder,
      event.tool_name,
      event.tool_use_id ?? null,
      event.hook_event,
      event.tool_input ?? null,
      event.tool_response ?? null,
      event.timestamp,
    );
}

/**
 * Get recent tool events for a group within a time window.
 * Returns events in reverse chronological order (newest first).
 */
export function getRecentToolEvents(
  groupFolder: string,
  sinceMs: number,
): ToolEvent[] {
  const cutoff = new Date(Date.now() - sinceMs).toISOString();
  return getDb()
    .prepare(
      `SELECT * FROM tool_call_events
       WHERE group_folder = ? AND timestamp >= ?
       ORDER BY timestamp DESC`,
    )
    .all(groupFolder, cutoff) as ToolEvent[];
}

/**
 * Delete tool events older than the retention period.
 * Returns the number of rows deleted.
 */
export function pruneToolEvents(retentionDays: number = 7): number {
  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
  const result = getDb()
    .prepare('DELETE FROM tool_call_events WHERE timestamp < ?')
    .run(cutoff);
  return result.changes;
}
