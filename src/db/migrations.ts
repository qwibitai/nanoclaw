import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';

import { setRegisteredGroup } from './groups.js';
import { setRouterState, setSession } from './sessions.js';

/**
 * Resolve the migrations directory. Supports an override for testing.
 */
let migrationsDir = path.join(process.cwd(), 'migrations');

/** @internal - for tests only. Override the migrations directory path. */
export function _setMigrationsDir(dir: string): void {
  migrationsDir = dir;
}

/**
 * Run pending SQL migrations from the migrations/ directory.
 * Creates a schema_migrations tracking table, skips already-applied versions,
 * and wraps each migration in a transaction for atomicity.
 *
 * For existing databases (tables present but no schema_migrations records),
 * all current migration versions are seeded as already applied to avoid
 * re-running ALTER TABLE statements that have already been applied ad-hoc.
 */
export function runMigrations(database: Database.Database): void {
  // Create tracking table
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      version TEXT UNIQUE NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  // Read migration files in numeric order
  if (!fs.existsSync(migrationsDir)) {
    logger.warn(
      { dir: migrationsDir },
      'Migrations directory not found, skipping',
    );
    return;
  }
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) return;

  // Check which migrations have already been applied
  const appliedVersions = new Set(
    (
      database.prepare('SELECT version FROM schema_migrations').all() as Array<{
        version: string;
      }>
    ).map((r) => r.version),
  );

  // Detect existing database: has user tables but no migration records yet
  if (appliedVersions.size === 0) {
    const existingTables = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migrations')",
      )
      .all() as Array<{ name: string }>;

    if (existingTables.length > 0) {
      // Seed all migration versions as already applied
      const now = new Date().toISOString();
      const insert = database.prepare(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      );
      for (const file of files) {
        const version = file.replace(/\.sql$/, '');
        insert.run(version, now);
      }
      logger.info(
        { count: files.length },
        'Seeded schema_migrations for existing database',
      );
      return;
    }
  }

  // Run pending migrations
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (appliedVersions.has(version)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const now = new Date().toISOString();

    try {
      database.exec('BEGIN');
      database.exec(sql);
      database
        .prepare(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        )
        .run(version, now);
      database.exec('COMMIT');
      logger.info({ version }, 'Applied migration');
    } catch (err) {
      try {
        database.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw new Error(`Migration ${version} failed: ${(err as Error).message}`);
    }
  }
}

// --- JSON migration ---

export function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
