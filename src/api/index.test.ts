import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createApiApp } from './index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let db: Database.Database;

function createTestDb(): Database.Database {
  const testDb = new Database(':memory:');
  // Minimal schema for API tests
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS complaints (
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
    CREATE TABLE IF NOT EXISTS complaint_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id TEXT NOT NULL,
      old_status TEXT,
      new_status TEXT,
      note TEXT,
      updated_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS categories (
      name TEXT PRIMARY KEY,
      display_name_en TEXT,
      display_name_mr TEXT,
      display_name_hi TEXT,
      complaint_count INTEGER DEFAULT 0,
      first_seen TEXT,
      is_active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      complaint_id TEXT,
      model TEXT NOT NULL,
      purpose TEXT NOT NULL,
      container_duration_ms INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS areas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_mr TEXT,
      name_hi TEXT,
      type TEXT DEFAULT 'village',
      is_active INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tenant_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return testDb;
}

beforeEach(() => {
  db = createTestDb();
  vi.stubEnv('DASHBOARD_API_KEY', 'test-key-123');
});

describe('API auth middleware', () => {
  it('returns 401 when X-API-Key header is missing', async () => {
    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/stats');
    expect(res.status).toBe(401);
    const body = await res.json() as Json;
    expect(body).toEqual({ error: 'API key required' });
  });

  it('returns 403 when X-API-Key header has wrong value', async () => {
    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/stats', {
      headers: { 'X-API-Key': 'wrong-key' },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as Json;
    expect(body).toEqual({ error: 'Invalid API key' });
  });

  it('returns 200 when X-API-Key header is correct', async () => {
    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/stats', {
      headers: { 'X-API-Key': 'test-key-123' },
    });
    expect(res.status).toBe(200);
  });
});

describe('API error handling', () => {
  it('returns JSON error for unknown routes', async () => {
    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/nonexistent', {
      headers: { 'X-API-Key': 'test-key-123' },
    });
    expect(res.status).toBe(404);
    const body = await res.json() as Json;
    expect(body).toHaveProperty('error');
  });
});
