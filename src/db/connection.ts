import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from '../config.js';

import { createSchema } from './schema.js';
import { migrateJsonState } from './json-migration.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error(
      'Database not initialized — call initDatabase() or _initTestDatabase() first',
    );
  }
  return db;
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db?.close();
  db = null;
}
