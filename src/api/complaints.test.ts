import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createApiApp } from './index.js';
import { eventBus } from '../event-bus.js';

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

function insertComplaint(
  overrides: Partial<{
    id: string;
    phone: string;
    category: string;
    description: string;
    location: string;
    status: string;
    area_id: string;
    created_at: string;
    updated_at: string;
    resolved_at: string | null;
  }> = {},
): void {
  const defaults = {
    id: 'RK-20260201-0001',
    phone: '919876543210',
    category: 'water_supply',
    description: 'No water for 3 days',
    location: 'Baramati',
    status: 'registered',
    area_id: null,
    created_at: '2026-02-01T10:00:00.000Z',
    updated_at: '2026-02-01T10:00:00.000Z',
    resolved_at: null,
  };
  const c = { ...defaults, ...overrides };
  db.prepare(
    `INSERT INTO complaints (id, phone, category, description, location, status, area_id, created_at, updated_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(c.id, c.phone, c.category, c.description, c.location, c.status, c.area_id, c.created_at, c.updated_at, c.resolved_at);
}

function insertUpdate(complaintId: string, oldStatus: string, newStatus: string, note: string | null = null): void {
  db.prepare(
    `INSERT INTO complaint_updates (complaint_id, old_status, new_status, note, updated_by, created_at)
     VALUES (?, ?, ?, ?, 'admin', '2026-02-01T11:00:00.000Z')`,
  ).run(complaintId, oldStatus, newStatus, note);
}

beforeEach(() => {
  db = createTestDb();
  vi.stubEnv('DASHBOARD_API_KEY', API_KEY);
});

afterEach(() => {
  eventBus.removeAllListeners();
});

describe('GET /api/complaints', () => {
  it('returns empty array when no complaints exist', async () => {
    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/complaints', { headers });
    expect(res.status).toBe(200);
    const body = await res.json() as Json;
    expect(body).toEqual({ data: [], total: 0, page: 1, limit: 50 });
  });

  it('returns all complaints with pagination metadata', async () => {
    insertComplaint();
    insertComplaint({ id: 'RK-20260201-0002', category: 'road', description: 'Pothole' });

    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/complaints', { headers });
    expect(res.status).toBe(200);
    const body = await res.json() as Json;
    expect(body.data).toHaveLength(2);
    expect(body.total).toBe(2);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(50);
  });

  it('filters by status', async () => {
    insertComplaint({ id: 'RK-1', status: 'registered' });
    insertComplaint({ id: 'RK-2', status: 'resolved', resolved_at: '2026-02-02T10:00:00.000Z' });

    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/complaints?status=registered', { headers });
    const body = await res.json() as Json;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('RK-1');
    expect(body.total).toBe(1);
  });

  it('filters by category', async () => {
    insertComplaint({ id: 'RK-1', category: 'water_supply' });
    insertComplaint({ id: 'RK-2', category: 'road' });

    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/complaints?category=road', { headers });
    const body = await res.json() as Json;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('RK-2');
  });

  it('filters by date range', async () => {
    insertComplaint({ id: 'RK-1', created_at: '2026-01-15T10:00:00.000Z' });
    insertComplaint({ id: 'RK-2', created_at: '2026-02-05T10:00:00.000Z' });
    insertComplaint({ id: 'RK-3', created_at: '2026-03-01T10:00:00.000Z' });

    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/complaints?from=2026-02-01&to=2026-02-28', { headers });
    const body = await res.json() as Json;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('RK-2');
  });

  it('filters by area_id', async () => {
    insertComplaint({ id: 'RK-1', area_id: 'area-1' });
    insertComplaint({ id: 'RK-2', area_id: 'area-2' });

    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/complaints?area_id=area-1', { headers });
    const body = await res.json() as Json;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('RK-1');
  });

  it('paginates results', async () => {
    for (let i = 1; i <= 5; i++) {
      insertComplaint({ id: `RK-${i}`, created_at: `2026-02-01T${String(i).padStart(2, '0')}:00:00.000Z` });
    }

    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/complaints?page=2&limit=2', { headers });
    const body = await res.json() as Json;
    expect(body.data).toHaveLength(2);
    expect(body.total).toBe(5);
    expect(body.page).toBe(2);
    expect(body.limit).toBe(2);
  });

  it('clamps limit to max 200', async () => {
    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/complaints?limit=500', { headers });
    const body = await res.json() as Json;
    expect(body.limit).toBe(200);
  });

  it('combines multiple filters', async () => {
    insertComplaint({ id: 'RK-1', status: 'registered', category: 'water_supply' });
    insertComplaint({ id: 'RK-2', status: 'resolved', category: 'water_supply' });
    insertComplaint({ id: 'RK-3', status: 'registered', category: 'road' });

    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/complaints?status=registered&category=water_supply', { headers });
    const body = await res.json() as Json;
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('RK-1');
  });
});

describe('GET /api/complaints/:id', () => {
  it('returns complaint with update history', async () => {
    insertComplaint({ id: 'RK-1' });
    insertUpdate('RK-1', 'registered', 'acknowledged', 'Looking into it');

    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/complaints/RK-1', { headers });
    expect(res.status).toBe(200);
    const body = await res.json() as Json;
    expect(body.complaint.id).toBe('RK-1');
    expect(body.updates).toHaveLength(1);
    expect(body.updates[0].old_status).toBe('registered');
    expect(body.updates[0].new_status).toBe('acknowledged');
    expect(body.updates[0].note).toBe('Looking into it');
  });

  it('returns 404 for non-existent complaint', async () => {
    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/complaints/NONEXISTENT', { headers });
    expect(res.status).toBe(404);
    const body = await res.json() as Json;
    expect(body).toEqual({ error: 'Complaint not found' });
  });
});

describe('PATCH /api/complaints/:id', () => {
  it('transitions status and returns old/new status', async () => {
    insertComplaint({ id: 'RK-1', status: 'registered' });

    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/complaints/RK-1', {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'acknowledged' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Json;
    expect(body).toEqual({ success: true, oldStatus: 'registered', newStatus: 'acknowledged' });
  });

  it('accepts optional note', async () => {
    insertComplaint({ id: 'RK-1', status: 'registered' });

    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/complaints/RK-1', {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'acknowledged', note: 'Will check tomorrow' }),
    });
    expect(res.status).toBe(200);

    // Verify note was stored in complaint_updates
    const updates = db.prepare('SELECT * FROM complaint_updates WHERE complaint_id = ?').all('RK-1') as Array<{ note: string }>;
    expect(updates).toHaveLength(1);
    expect(updates[0].note).toBe('Will check tomorrow');
  });

  it('returns 404 for non-existent complaint', async () => {
    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/complaints/NONEXISTENT', {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'acknowledged' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as Json;
    expect(body).toEqual({ error: 'Complaint not found' });
  });

  it('returns 400 for missing status', async () => {
    insertComplaint({ id: 'RK-1' });

    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/complaints/RK-1', {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Json;
    expect(body).toEqual({ error: 'status is required' });
  });

  it('returns 400 for invalid status value', async () => {
    insertComplaint({ id: 'RK-1' });

    const app = createApiApp({ db: () => db });
    const res = await app.request('/api/complaints/RK-1', {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'invalid_status' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as Json;
    expect(body.error).toContain('Invalid status');
  });

  it('emits complaint:status-changed event', async () => {
    insertComplaint({ id: 'RK-1', status: 'registered', phone: '919876543210' });

    const events: unknown[] = [];
    eventBus.on('complaint:status-changed', (data) => events.push(data));

    const app = createApiApp({ db: () => db });
    await app.request('/api/complaints/RK-1', {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'acknowledged' }),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      complaintId: 'RK-1',
      oldStatus: 'registered',
      newStatus: 'acknowledged',
    });
  });
});
