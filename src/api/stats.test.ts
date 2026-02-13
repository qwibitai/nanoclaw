import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createApiApp } from './index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let db: Database.Database;
const API_KEY = 'test-key-123';
const headers = { 'X-API-Key': API_KEY };

function createTestDb(): Database.Database {
  const testDb = new Database(':memory:');
  testDb.exec(`
    CREATE TABLE complaints (
      id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      category TEXT,
      subcategory TEXT,
      description TEXT NOT NULL,
      location TEXT,
      language TEXT DEFAULT 'mr',
      status TEXT DEFAULT 'registered',
      priority TEXT DEFAULT 'normal',
      source TEXT DEFAULT 'text',
      voice_message_id TEXT,
      area_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE TABLE complaint_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT,
      note TEXT,
      updated_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE categories (
      name TEXT PRIMARY KEY,
      display_name_en TEXT,
      display_name_mr TEXT,
      display_name_hi TEXT,
      complaint_count INTEGER DEFAULT 0,
      first_seen TEXT,
      is_active INTEGER DEFAULT 1
    );
    CREATE TABLE usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      complaint_id TEXT,
      model TEXT NOT NULL,
      purpose TEXT NOT NULL,
      container_duration_ms INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE areas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_mr TEXT,
      name_hi TEXT,
      type TEXT DEFAULT 'village',
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tenant_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return testDb;
}

beforeEach(() => {
  db = createTestDb();
  vi.stubEnv('DASHBOARD_API_KEY', API_KEY);
});

describe('GET /api/stats', () => {
  it('returns zeroes for empty database', async () => {
    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/stats', { headers });
    expect(res.status).toBe(200);
    const body = await res.json() as Json;
    expect(body.totalOpen).toBe(0);
    expect(body.totalAll).toBe(0);
    expect(body.resolvedCount).toBe(0);
    expect(body.newToday).toBe(0);
    expect(body.topCategories).toEqual([]);
    expect(body.topAreas).toEqual([]);
  });

  it('returns correct counts with data', async () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO complaints (id, phone, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('C1', '91123', 'test', 'registered', now, now);
    db.prepare(
      `INSERT INTO complaints (id, phone, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('C2', '91456', 'test2', 'in_progress', now, now);
    db.prepare(
      `INSERT INTO complaints (id, phone, description, status, created_at, updated_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('C3', '91789', 'test3', 'resolved', now, now, now);

    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/stats', { headers });
    const body = await res.json() as Json;
    expect(body.totalOpen).toBe(2);
    expect(body.totalAll).toBe(3);
    expect(body.resolvedCount).toBe(1);
    expect(body.newToday).toBe(3);
  });

  it('includes byStatus breakdown', async () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO complaints (id, phone, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('C1', '91123', 'test', 'registered', now, now);
    db.prepare(
      `INSERT INTO complaints (id, phone, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('C2', '91456', 'test2', 'registered', now, now);
    db.prepare(
      `INSERT INTO complaints (id, phone, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('C3', '91789', 'test3', 'in_progress', now, now);

    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/stats', { headers });
    const body = await res.json() as Json;
    expect(body.byStatus).toEqual({ registered: 2, in_progress: 1 });
  });
});
