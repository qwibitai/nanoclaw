/**
 * test-helpers.ts — Shared test seeding utilities.
 *
 * Provides a createTestDb() that builds a fresh in-memory database
 * with all tables and migrations applied, plus seed functions for
 * common entities (users, areas, karyakartas, complaints).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { slugify } from './area-db.js';
import { nowISO } from './utils.js';

/**
 * Create a fresh in-memory DB with all tables and migrations applied.
 * Includes default tenant_config (complaint_id_prefix = 'RK').
 */
export function createTestDb(): Database.Database {
  const db = new Database(':memory:');

  // Base schema from 001-complaints.sql
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenant_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      name TEXT,
      language TEXT DEFAULT 'mr',
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen TEXT NOT NULL DEFAULT (datetime('now')),
      total_complaints INTEGER DEFAULT 0,
      is_blocked INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS complaints (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      category TEXT,
      subcategory TEXT,
      description TEXT NOT NULL,
      location TEXT,
      language TEXT NOT NULL DEFAULT 'mr',
      status TEXT DEFAULT 'registered',
      status_reason TEXT,
      priority TEXT DEFAULT 'normal',
      source TEXT DEFAULT 'text',
      voice_message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT,
      days_open INTEGER DEFAULT 0,
      FOREIGN KEY (phone) REFERENCES users(phone)
    );
    CREATE INDEX IF NOT EXISTS idx_complaints_phone ON complaints(phone);
    CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
    CREATE INDEX IF NOT EXISTS idx_complaints_category ON complaints(category);
    CREATE INDEX IF NOT EXISTS idx_complaints_created ON complaints(created_at);
    CREATE TABLE IF NOT EXISTS complaint_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT,
      note TEXT,
      updated_by TEXT DEFAULT 'system',
      created_at TEXT NOT NULL,
      FOREIGN KEY (complaint_id) REFERENCES complaints(id)
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      complaint_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (phone) REFERENCES users(phone)
    );
    CREATE TABLE IF NOT EXISTS rate_limits (
      phone TEXT NOT NULL,
      date TEXT NOT NULL,
      message_count INTEGER DEFAULT 0,
      last_message_at TEXT,
      recent_timestamps TEXT,
      PRIMARY KEY (phone, date)
    );
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      complaint_id TEXT,
      model TEXT NOT NULL,
      purpose TEXT,
      container_duration_ms INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      name TEXT PRIMARY KEY,
      display_name_en TEXT,
      display_name_mr TEXT,
      display_name_hi TEXT,
      complaint_count INTEGER DEFAULT 0,
      first_seen TEXT NOT NULL DEFAULT (datetime('now')),
      is_active INTEGER DEFAULT 1
    );
  `);

  // Migration 002: date_of_birth and block_reason
  db.exec(`
    ALTER TABLE users ADD COLUMN date_of_birth TEXT;
    ALTER TABLE users ADD COLUMN block_reason TEXT;
  `);

  // Migration 003: role and blocked_until
  db.exec(`
    ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user';
    ALTER TABLE users ADD COLUMN blocked_until TEXT;
  `);

  // Migration 004: areas, karyakartas, validations, area_id on complaints
  const migrationPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    'migrations',
    '004-areas-karyakartas.sql',
  );
  const migrationSql = fs.readFileSync(migrationPath, 'utf-8');
  db.exec(migrationSql);

  // Default tenant config
  db.prepare(
    "INSERT INTO tenant_config (key, value) VALUES ('complaint_id_prefix', 'RK')",
  ).run();

  return db;
}

/** Seed an area. Returns the slug id. */
export function seedArea(
  db: Database.Database,
  params: { name: string; name_mr?: string },
): string {
  const id = slugify(params.name);
  const now = nowISO();
  db.prepare(
    `INSERT INTO areas (id, name, name_mr, type, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 'custom', 1, ?, ?)`,
  ).run(id, params.name, params.name_mr ?? null, now, now);
  return id;
}

/** Seed a user. */
export function seedUser(
  db: Database.Database,
  phone: string,
  opts?: { role?: string; language?: string },
): void {
  const now = nowISO();
  db.prepare(
    `INSERT OR IGNORE INTO users (phone, role, language, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(phone, opts?.role ?? 'user', opts?.language ?? 'mr', now, now);
}

/** Seed a karyakarta (also creates user if needed). */
export function seedKaryakarta(
  db: Database.Database,
  phone: string,
  areaIds?: string[],
): void {
  const now = nowISO();
  // Ensure user exists with karyakarta role
  db.prepare(
    `INSERT INTO users (phone, role, language, first_seen, last_seen)
     VALUES (?, 'karyakarta', 'mr', ?, ?)
     ON CONFLICT(phone) DO UPDATE SET role = 'karyakarta'`,
  ).run(phone, now, now);

  // Insert karyakarta record
  db.prepare(
    `INSERT OR REPLACE INTO karyakartas (phone, is_active, created_at, updated_at)
     VALUES (?, 1, ?, ?)`,
  ).run(phone, now, now);

  // Assign areas
  if (areaIds) {
    for (const areaId of areaIds) {
      db.prepare(
        `INSERT OR IGNORE INTO karyakarta_areas (karyakarta_phone, area_id, assigned_at)
         VALUES (?, ?, ?)`,
      ).run(phone, areaId, now);
    }
  }
}

/** Seed a complaint. Returns the complaint id. */
let _seedCounter = 0;
export function seedComplaint(
  db: Database.Database,
  opts: {
    phone: string;
    id?: string;
    status?: string;
    area_id?: string;
    category?: string;
    created_at?: string;
  },
): string {
  const now = opts.created_at ?? nowISO();
  _seedCounter++;
  const id = opts.id ?? `RK-SEED-${String(_seedCounter).padStart(4, '0')}`;

  db.prepare(
    `INSERT INTO complaints (id, phone, category, description, location, language, status, priority, source, area_id, created_at, updated_at)
     VALUES (?, ?, ?, 'Test complaint', NULL, 'mr', ?, 'normal', 'text', ?, ?, ?)`,
  ).run(
    id,
    opts.phone,
    opts.category ?? null,
    opts.status ?? 'registered',
    opts.area_id ?? null,
    now,
    now,
  );

  return id;
}
