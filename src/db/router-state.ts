import { getDb } from './connection.js';

export function getRouterState(key: string): string | undefined {
  const row = getDb()
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)')
    .run(key, value);
}
