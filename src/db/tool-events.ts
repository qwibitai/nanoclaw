import Database from 'better-sqlite3';

let db: Database.Database | null = null;

/** @internal - for tests and database initialization only */
export function _setToolEventsDb(database: Database.Database): void {
  db = database;
}

export interface ToolEvent {
  id?: number;
  session_id: string;
  group_folder: string;
  tool_name: string;
  tool_use_id?: string;
  hook_event: string;
  tool_input?: string;
  tool_response?: string;
  timestamp: string;
  created_at?: string;
}

/**
 * Insert a new tool call event into the database.
 */
export function insertToolEvent(event: ToolEvent): void {
  if (!db) {
    throw new Error('Database not initialized');
  }

  db.prepare(
    `INSERT INTO tool_call_events (
      session_id, group_folder, tool_name, tool_use_id,
      hook_event, tool_input, tool_response, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
 * Get recent tool events (for the /activity command).
 * Returns events from the last N minutes.
 */
export function getRecentToolEvents(minutesBack: number = 5): ToolEvent[] {
  if (!db) {
    throw new Error('Database not initialized');
  }

  const cutoff = new Date(Date.now() - minutesBack * 60_000).toISOString();

  return db
    .prepare(
      `SELECT * FROM tool_call_events
       WHERE timestamp >= ?
       ORDER BY timestamp DESC
       LIMIT 100`,
    )
    .all(cutoff) as ToolEvent[];
}

/**
 * Prune tool events older than the retention period.
 * Called on startup and periodically.
 */
export function pruneToolEvents(retentionDays: number = 7): void {
  if (!db) {
    throw new Error('Database not initialized');
  }

  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
  const result = db
    .prepare('DELETE FROM tool_call_events WHERE timestamp < ?')
    .run(cutoff);

  if (result.changes > 0) {
    // Optional: log the cleanup
  }
}
