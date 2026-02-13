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

describe('GET /api/usage', () => {
  it('returns zeroes for empty database', async () => {
    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/usage', { headers });
    expect(res.status).toBe(200);
    const body = await res.json() as Json;
    expect(body.totalMessages).toBe(0);
    expect(body.containerRuns).toBe(0);
    expect(body.avgDurationMs).toBe(0);
    expect(body.byModel).toEqual({});
    expect(body.date).toBeDefined();
  });

  it('returns usage data for specific date', async () => {
    db.prepare(
      `INSERT INTO usage_log (phone, model, purpose, container_duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('91123', 'sonnet-4.5', 'complaint', 5000, '2026-02-10T10:00:00.000Z');
    db.prepare(
      `INSERT INTO usage_log (phone, model, purpose, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run('91456', 'sonnet-4.5', 'admin', '2026-02-10T11:00:00.000Z');
    db.prepare(
      `INSERT INTO usage_log (phone, model, purpose, created_at)
       VALUES (?, ?, ?, ?)`,
    ).run('91789', 'opus-4.6', 'analysis', '2026-02-11T10:00:00.000Z');

    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/usage?date=2026-02-10', { headers });
    const body = await res.json() as Json;
    expect(body.date).toBe('2026-02-10');
    expect(body.totalMessages).toBe(2);
    expect(body.containerRuns).toBe(1);
    expect(body.avgDurationMs).toBe(5000);
    expect(body.byModel).toEqual({ 'sonnet-4.5': 2 });
  });

  it('defaults to today when no date param', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/usage', { headers });
    const body = await res.json() as Json;
    expect(body.date).toBe(today);
  });
});
