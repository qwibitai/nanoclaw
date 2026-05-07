import Database from 'better-sqlite3';

export function runMnemonRecallFactContentMigration(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
  `);

  const applied = new Set<string>(
    (db.prepare('SELECT name FROM schema_version').all() as { name: string }[]).map((r) => r.name),
  );

  if (!applied.has('mnemon-recall-fact-content-v1')) {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE recall_outcomes
          ADD COLUMN fact_content_excerpt TEXT NOT NULL DEFAULT '';
      `);

      const next = (db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version').get() as { v: number })
        .v;
      db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
        next,
        'mnemon-recall-fact-content-v1',
        new Date().toISOString(),
      );
    })();
  }
}
