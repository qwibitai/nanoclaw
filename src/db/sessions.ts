import { getDb } from './connection.js';

export function getSession(groupFolder: string): string | undefined {
  const row = getDb()
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  getDb()
    .prepare(
      'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
    )
    .run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  getDb()
    .prepare('DELETE FROM sessions WHERE group_folder = ?')
    .run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = getDb()
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}
