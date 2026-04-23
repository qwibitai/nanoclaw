/**
 * Step: migrate-validate
 *
 * Before touching v1 data, assert the DB has the shape we expect. We know
 * v1's schema (see docs/v1-to-v2-changes.md "Entity model") — different
 * shapes happened over v1's development, but by v1.2.x the `registered_groups`
 * columns and `scheduled_tasks` columns stabilized. If we see something else,
 * we bail early so later steps don't write garbage to v2.db.
 *
 * Output:
 *   - `logs/setup-migration/schema-mismatch.json` on failure (read by the skill)
 *   - Status block MIGRATE_VALIDATE with OK/FAILED
 *   - Even on failure, subsequent steps still run — they'll short-circuit
 *     on their own if validate marked the DB unusable. This keeps env + group
 *     folder migration working when only the DB is broken.
 */
import fs from 'fs';

import Database from 'better-sqlite3';

import { emitStatus } from '../status.js';
import {
  SCHEMA_MISMATCH_PATH,
  readHandoff,
  recordStep,
  safeJsonStringify,
  v1PathsFor,
} from './shared.js';

const EXPECTED_TABLES = [
  'registered_groups',
  'scheduled_tasks',
  'chats',
  'messages',
  'sessions',
  'router_state',
];

const REQUIRED_REGISTERED_GROUPS_COLUMNS = [
  'jid',
  'name',
  'folder',
  'trigger_pattern',
  'added_at',
  'requires_trigger',
];

const REQUIRED_SCHEDULED_TASKS_COLUMNS = [
  'id',
  'group_folder',
  'chat_jid',
  'prompt',
  'schedule_type',
  'schedule_value',
  'status',
];

interface TableInfo {
  table: string;
  columns: string[];
  missing_columns: string[];
}

export async function run(_args: string[]): Promise<void> {
  const h = readHandoff();
  if (!h.v1_path) {
    recordStep('migrate-validate', {
      status: 'skipped',
      fields: { REASON: 'detect-not-run' },
      notes: [],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_VALIDATE', { STATUS: 'skipped', REASON: 'no_v1_path' });
    return;
  }

  const paths = v1PathsFor(h.v1_path);
  if (!fs.existsSync(paths.db)) {
    recordStep('migrate-validate', {
      status: 'failed',
      fields: { REASON: 'db-missing', DB_PATH: paths.db },
      notes: ['v1 DB file does not exist at expected path'],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_VALIDATE', {
      STATUS: 'failed',
      REASON: 'db_missing',
      DB_PATH: paths.db,
    });
    return;
  }

  let db: Database.Database;
  try {
    db = new Database(paths.db, { readonly: true, fileMustExist: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordStep('migrate-validate', {
      status: 'failed',
      fields: { REASON: 'db-open-failed' },
      notes: [message],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_VALIDATE', {
      STATUS: 'failed',
      REASON: 'db_open_failed',
      ERROR: message,
    });
    return;
  }

  try {
    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tables = new Set(tableRows.map((r) => r.name));

    const missingTables = EXPECTED_TABLES.filter((t) => !tables.has(t));
    const tableInfos: TableInfo[] = [];

    for (const t of EXPECTED_TABLES) {
      if (!tables.has(t)) continue;
      const cols = db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>;
      const columnNames = cols.map((c) => c.name);
      const missing =
        t === 'registered_groups'
          ? REQUIRED_REGISTERED_GROUPS_COLUMNS.filter((c) => !columnNames.includes(c))
          : t === 'scheduled_tasks'
            ? REQUIRED_SCHEDULED_TASKS_COLUMNS.filter((c) => !columnNames.includes(c))
            : [];
      tableInfos.push({ table: t, columns: columnNames, missing_columns: missing });
    }

    const columnMismatches = tableInfos.filter((t) => t.missing_columns.length > 0);
    const groupCount =
      tables.has('registered_groups')
        ? ((db.prepare('SELECT COUNT(*) AS c FROM registered_groups').get() as { c: number }).c)
        : 0;
    const taskCount =
      tables.has('scheduled_tasks')
        ? ((db.prepare('SELECT COUNT(*) AS c FROM scheduled_tasks').get() as { c: number }).c)
        : 0;

    db.close();

    if (missingTables.length > 0 || columnMismatches.length > 0) {
      const mismatch = {
        v1_path: h.v1_path,
        v1_version: h.v1_version,
        present_tables: [...tables].sort(),
        missing_tables: missingTables,
        column_mismatches: columnMismatches,
        scanned_at: new Date().toISOString(),
      };
      fs.writeFileSync(SCHEMA_MISMATCH_PATH, safeJsonStringify(mismatch));

      recordStep('migrate-validate', {
        status: 'failed',
        fields: {
          MISSING_TABLES: missingTables.join(',') || 'none',
          COLUMN_MISMATCHES: String(columnMismatches.length),
          REPORT: SCHEMA_MISMATCH_PATH,
        },
        notes: [
          missingTables.length > 0 ? `Missing tables: ${missingTables.join(', ')}` : '',
          columnMismatches.length > 0
            ? `Column mismatches in: ${columnMismatches.map((c) => c.table).join(', ')}`
            : '',
        ].filter(Boolean),
        at: new Date().toISOString(),
      });

      emitStatus('MIGRATE_VALIDATE', {
        STATUS: 'failed',
        REASON: 'schema_mismatch',
        MISSING_TABLES: missingTables.join(',') || 'none',
        COLUMN_MISMATCHES: String(columnMismatches.length),
        REPORT: SCHEMA_MISMATCH_PATH,
      });
      return;
    }

    recordStep('migrate-validate', {
      status: 'success',
      fields: {
        V1_GROUPS: groupCount,
        V1_TASKS: taskCount,
      },
      notes: [],
      at: new Date().toISOString(),
    });

    emitStatus('MIGRATE_VALIDATE', {
      STATUS: 'success',
      V1_GROUPS: String(groupCount),
      V1_TASKS: String(taskCount),
    });
  } catch (err) {
    db.close();
    const message = err instanceof Error ? err.message : String(err);
    recordStep('migrate-validate', {
      status: 'failed',
      fields: { REASON: 'validate-error' },
      notes: [message],
      at: new Date().toISOString(),
    });
    emitStatus('MIGRATE_VALIDATE', {
      STATUS: 'failed',
      REASON: 'validate_error',
      ERROR: message,
    });
  }
}
