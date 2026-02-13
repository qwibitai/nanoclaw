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

describe('GET /api/categories', () => {
  it('returns empty array when no categories exist', async () => {
    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/categories', { headers });
    expect(res.status).toBe(200);
    const body = await res.json() as Json;
    expect(body).toEqual({ categories: [] });
  });

  it('returns active categories with display names and counts', async () => {
    db.prepare(
      `INSERT INTO categories (name, display_name_en, display_name_mr, display_name_hi, complaint_count, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('water_supply', 'Water Supply', 'पाणी पुरवठा', 'पानी आपूर्ति', 5, 1);
    db.prepare(
      `INSERT INTO categories (name, display_name_en, display_name_mr, display_name_hi, complaint_count, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('road', 'Road', 'रस्ता', 'सड़क', 3, 1);
    db.prepare(
      `INSERT INTO categories (name, display_name_en, display_name_mr, display_name_hi, complaint_count, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('inactive_cat', 'Inactive', null, null, 0, 0);

    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/categories', { headers });
    const body = await res.json() as Json;
    expect(body.categories).toHaveLength(2); // excludes inactive
    expect(body.categories[0].name).toBe('road'); // sorted by name
    expect(body.categories[1].name).toBe('water_supply');
    expect(body.categories[1].complaint_count).toBe(5);
  });
});
