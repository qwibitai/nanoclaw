/**
 * Step: corsair — run migrations then initialise corsair (tables, DEKs, auth check).
 */
import Database from 'better-sqlite3';
import { setupCorsair } from 'corsair';
import path from 'path';

import { STORE_DIR } from '../src/config.js';
import { corsair } from '../src/corsair.js';
import { emitStatus } from './status.js';

function migrate(db: InstanceType<typeof Database>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS corsair_integrations (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      name TEXT NOT NULL,
      config TEXT,
      dek TEXT
    );

    CREATE TABLE IF NOT EXISTS corsair_accounts (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      integration_id TEXT NOT NULL REFERENCES corsair_integrations(id),
      config TEXT,
      dek TEXT
    );

    CREATE TABLE IF NOT EXISTS corsair_entities (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES corsair_accounts(id),
      entity_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      version TEXT NOT NULL,
      data TEXT
    );

    CREATE TABLE IF NOT EXISTS corsair_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      account_id TEXT NOT NULL REFERENCES corsair_accounts(id),
      event_type TEXT NOT NULL,
      payload TEXT,
      status TEXT
    );

    CREATE TABLE IF NOT EXISTS corsair_permissions (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      plugin TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      args TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      expires_at TEXT NOT NULL,
      error TEXT
    );
  `);
}

export async function run(_args: string[]): Promise<void> {
  const db = new Database(path.join(STORE_DIR, 'messages.db'));
  migrate(db);
  db.close();

  await setupCorsair(corsair);

  emitStatus('CORSAIR', {
    STATUS: 'success',
  });
}
