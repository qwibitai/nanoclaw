/**
 * Backup & restore core logic.
 * Extracted for testability with :memory: databases.
 */
import Database from 'better-sqlite3';

const GOV_TABLES = [
  'products',
  'gov_tasks',
  'gov_activities',
  'gov_approvals',
  'gov_dispatches',
  'ext_capabilities',
  'ext_calls',
] as const;

/** Count rows in all governance tables. */
export function snapshotTableCounts(db: Database.Database): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of GOV_TABLES) {
    try {
      const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).get() as { cnt: number };
      counts[table] = row.cnt;
    } catch {
      counts[table] = 0;
    }
  }
  return counts;
}

/** Serialize all gov tables to a portable JSON structure. */
export function exportGovData(db: Database.Database): Record<string, unknown[]> {
  const data: Record<string, unknown[]> = {};
  for (const table of GOV_TABLES) {
    try {
      data[table] = db.prepare(`SELECT * FROM ${table}`).all();
    } catch {
      data[table] = [];
    }
  }
  return data;
}

/** Import gov data into a database (schema must already exist). */
export function importGovData(db: Database.Database, data: Record<string, unknown[]>): void {
  for (const [table, rows] of Object.entries(data)) {
    if (rows.length === 0) continue;
    const columns = Object.keys(rows[0] as Record<string, unknown>);
    const placeholders = columns.map(() => '?').join(', ');
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
    );
    for (const row of rows) {
      const values = columns.map((c) => (row as Record<string, unknown>)[c]);
      stmt.run(...values);
    }
  }
}
