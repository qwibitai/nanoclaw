import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import {
  createComplaint,
  queryComplaints,
  updateComplaint,
  getCategories,
  getUser,
  updateUser,
  blockUser,
} from './complaint-mcp-server.js';
import { _initTestDatabase, _getTestDatabase, runMigrations } from './db.js';

let db: Database.Database;

function seedTenantConfig(database: Database.Database): void {
  database
    .prepare("INSERT OR REPLACE INTO tenant_config (key, value) VALUES ('complaint_id_prefix', 'RK')")
    .run();
}

function seedCategories(database: Database.Database): void {
  database
    .prepare(
      `INSERT OR REPLACE INTO categories (name, display_name_en, display_name_mr, display_name_hi, complaint_count, first_seen, is_active)
       VALUES ('water_supply', 'Water Supply', 'पाणीपुरवठा', 'जलापूर्ति', 0, datetime('now'), 1)`,
    )
    .run();
  database
    .prepare(
      `INSERT OR REPLACE INTO categories (name, display_name_en, display_name_mr, display_name_hi, complaint_count, first_seen, is_active)
       VALUES ('roads', 'Roads', 'रस्ते', 'सड़कें', 0, datetime('now'), 1)`,
    )
    .run();
  database
    .prepare(
      `INSERT OR REPLACE INTO categories (name, display_name_en, display_name_mr, display_name_hi, complaint_count, first_seen, is_active)
       VALUES ('inactive_cat', 'Inactive', NULL, NULL, 0, datetime('now'), 0)`,
    )
    .run();
}

beforeEach(() => {
  _initTestDatabase();
  db = _getTestDatabase();
  runMigrations(db);
  seedTenantConfig(db);
});

// ============================================================
// createComplaint
// ============================================================

describe('createComplaint', () => {
  it('creates a complaint and returns a tracking ID', () => {
    const id = createComplaint(db, {
      phone: '919876543210',
      category: 'water_supply',
      description: 'No water for 3 days',
      location: 'Ward 7',
      language: 'mr',
    });

    expect(id).toMatch(/^RK-\d{8}-0001$/);
  });

  it('increments counter for multiple complaints on the same day', () => {
    const id1 = createComplaint(db, {
      phone: '919876543210',
      description: 'Issue 1',
      language: 'mr',
    });
    const id2 = createComplaint(db, {
      phone: '919876543210',
      description: 'Issue 2',
      language: 'mr',
    });

    expect(id1).toMatch(/-0001$/);
    expect(id2).toMatch(/-0002$/);
  });

  it('creates user record on first complaint', () => {
    createComplaint(db, {
      phone: '919876543210',
      description: 'Test',
      language: 'hi',
    });

    const user = db
      .prepare('SELECT * FROM users WHERE phone = ?')
      .get('919876543210') as { phone: string; language: string; total_complaints: number };
    expect(user).toBeDefined();
    expect(user.language).toBe('hi');
    expect(user.total_complaints).toBe(1);
  });

  it('increments total_complaints for existing user', () => {
    createComplaint(db, { phone: '919876543210', description: 'First', language: 'mr' });
    createComplaint(db, { phone: '919876543210', description: 'Second', language: 'mr' });

    const user = db
      .prepare('SELECT total_complaints FROM users WHERE phone = ?')
      .get('919876543210') as { total_complaints: number };
    expect(user.total_complaints).toBe(2);
  });

  it('handles optional category and location', () => {
    const id = createComplaint(db, {
      phone: '919876543210',
      description: 'General issue',
      language: 'en',
    });

    const complaint = db
      .prepare('SELECT category, location FROM complaints WHERE id = ?')
      .get(id) as { category: string | null; location: string | null };
    expect(complaint.category).toBeNull();
    expect(complaint.location).toBeNull();
  });

  it('throws if complaint_id_prefix is missing', () => {
    db.prepare("DELETE FROM tenant_config WHERE key = 'complaint_id_prefix'").run();

    expect(() =>
      createComplaint(db, {
        phone: '919876543210',
        description: 'Test',
        language: 'mr',
      }),
    ).toThrow('complaint_id_prefix not found');
  });
});

// ============================================================
// queryComplaints
// ============================================================

describe('queryComplaints', () => {
  beforeEach(() => {
    createComplaint(db, {
      phone: '919876543210',
      category: 'water_supply',
      description: 'No water',
      location: 'Ward 7',
      language: 'mr',
    });
    createComplaint(db, {
      phone: '919876543210',
      category: 'roads',
      description: 'Pothole',
      location: 'Ward 3',
      language: 'hi',
    });
    createComplaint(db, {
      phone: '919999999999',
      category: 'electricity',
      description: 'Power cut',
      language: 'en',
    });
  });

  it('queries by phone number', () => {
    const results = queryComplaints(db, { phone: '919876543210' });
    expect(results).toHaveLength(2);
  });

  it('queries by complaint ID', () => {
    const all = queryComplaints(db, { phone: '919876543210' }) as { id: string }[];
    const id = all[0].id;

    const results = queryComplaints(db, { id });
    expect(results).toHaveLength(1);
    expect((results[0] as { id: string }).id).toBe(id);
  });

  it('returns empty array for unknown phone', () => {
    const results = queryComplaints(db, { phone: '910000000000' });
    expect(results).toHaveLength(0);
  });

  it('returns empty array for unknown ID', () => {
    const results = queryComplaints(db, { id: 'RK-99999999-9999' });
    expect(results).toHaveLength(0);
  });

  it('throws if neither phone nor id provided', () => {
    expect(() => queryComplaints(db, {})).toThrow('Either phone or id is required');
  });
});

// ============================================================
// updateComplaint
// ============================================================

describe('updateComplaint', () => {
  let complaintId: string;

  beforeEach(() => {
    complaintId = createComplaint(db, {
      phone: '919876543210',
      description: 'Test complaint',
      language: 'mr',
    });
  });

  it('updates complaint status', () => {
    const result = updateComplaint(db, { id: complaintId, status: 'in_progress' });
    expect(result).toBe('OK');

    const complaint = db
      .prepare('SELECT status FROM complaints WHERE id = ?')
      .get(complaintId) as { status: string };
    expect(complaint.status).toBe('in_progress');
  });

  it('creates audit record', () => {
    updateComplaint(db, { id: complaintId, status: 'acknowledged', note: 'Reviewed by admin' });

    const updates = db
      .prepare('SELECT * FROM complaint_updates WHERE complaint_id = ?')
      .all(complaintId) as {
        old_status: string;
        new_status: string;
        note: string | null;
        updated_by: string;
      }[];

    expect(updates).toHaveLength(1);
    expect(updates[0].old_status).toBe('registered');
    expect(updates[0].new_status).toBe('acknowledged');
    expect(updates[0].note).toBe('Reviewed by admin');
    expect(updates[0].updated_by).toBe('chatbot');
  });

  it('sets resolved_at when status is resolved', () => {
    updateComplaint(db, { id: complaintId, status: 'resolved' });

    const complaint = db
      .prepare('SELECT resolved_at FROM complaints WHERE id = ?')
      .get(complaintId) as { resolved_at: string | null };
    expect(complaint.resolved_at).not.toBeNull();
  });

  it('does not set resolved_at for non-resolved statuses', () => {
    updateComplaint(db, { id: complaintId, status: 'in_progress' });

    const complaint = db
      .prepare('SELECT resolved_at FROM complaints WHERE id = ?')
      .get(complaintId) as { resolved_at: string | null };
    expect(complaint.resolved_at).toBeNull();
  });

  it('throws for invalid status', () => {
    expect(() =>
      updateComplaint(db, { id: complaintId, status: 'invalid_status' }),
    ).toThrow('Invalid status');
  });

  it('throws for non-existent complaint', () => {
    expect(() =>
      updateComplaint(db, { id: 'RK-99999999-9999', status: 'in_progress' }),
    ).toThrow('not found');
  });

  it('handles optional note', () => {
    updateComplaint(db, { id: complaintId, status: 'acknowledged' });

    const updates = db
      .prepare('SELECT note FROM complaint_updates WHERE complaint_id = ?')
      .all(complaintId) as { note: string | null }[];
    expect(updates[0].note).toBeNull();
  });
});

// ============================================================
// getCategories
// ============================================================

describe('getCategories', () => {
  it('returns empty array when no categories exist', () => {
    const categories = getCategories(db);
    expect(categories).toEqual([]);
  });

  it('returns only active categories', () => {
    seedCategories(db);
    const categories = getCategories(db) as { name: string }[];

    expect(categories).toHaveLength(2);
    const names = categories.map((c) => c.name);
    expect(names).toContain('water_supply');
    expect(names).toContain('roads');
    expect(names).not.toContain('inactive_cat');
  });

  it('returns display names in all languages', () => {
    seedCategories(db);
    const categories = getCategories(db) as {
      name: string;
      display_name_en: string;
      display_name_mr: string;
      display_name_hi: string;
    }[];

    const water = categories.find((c) => c.name === 'water_supply')!;
    expect(water.display_name_en).toBe('Water Supply');
    expect(water.display_name_mr).toBe('पाणीपुरवठा');
    expect(water.display_name_hi).toBe('जलापूर्ति');
  });
});

// ============================================================
// getUser
// ============================================================

describe('getUser', () => {
  it('returns null for unknown phone', () => {
    expect(getUser(db, { phone: '919876543210' })).toBeNull();
  });

  it('returns user profile after complaint creation', () => {
    createComplaint(db, {
      phone: '919876543210',
      description: 'Test',
      language: 'mr',
    });

    const user = getUser(db, { phone: '919876543210' }) as {
      phone: string;
      name: string | null;
      language: string;
      total_complaints: number;
      is_blocked: number;
    };
    expect(user).not.toBeNull();
    expect(user.phone).toBe('919876543210');
    expect(user.language).toBe('mr');
    expect(user.total_complaints).toBe(1);
    expect(user.is_blocked).toBe(0);
  });
});

// ============================================================
// updateUser
// ============================================================

describe('updateUser', () => {
  it('creates user if not exists', () => {
    const result = updateUser(db, { phone: '919876543210', name: 'Riyaz Shaikh' });
    expect(result).toBe('OK');

    const user = getUser(db, { phone: '919876543210' }) as { name: string; language: string };
    expect(user.name).toBe('Riyaz Shaikh');
    expect(user.language).toBe('mr'); // default
  });

  it('updates name for existing user', () => {
    createComplaint(db, { phone: '919876543210', description: 'Test', language: 'hi' });
    updateUser(db, { phone: '919876543210', name: 'Rajesh Kumar' });

    const user = getUser(db, { phone: '919876543210' }) as { name: string };
    expect(user.name).toBe('Rajesh Kumar');
  });

  it('updates date_of_birth', () => {
    updateUser(db, { phone: '919876543210', name: 'Test User', date_of_birth: '1990-05-15' });

    const user = getUser(db, { phone: '919876543210' }) as { date_of_birth: string };
    expect(user.date_of_birth).toBe('1990-05-15');
  });

  it('updates language preference', () => {
    updateUser(db, { phone: '919876543210', language: 'hi' });

    const user = getUser(db, { phone: '919876543210' }) as { language: string };
    expect(user.language).toBe('hi');
  });

  it('preserves existing fields when updating selectively', () => {
    updateUser(db, { phone: '919876543210', name: 'Riyaz Shaikh', language: 'mr' });
    updateUser(db, { phone: '919876543210', date_of_birth: '1990-01-01' });

    const user = getUser(db, { phone: '919876543210' }) as { name: string; language: string; date_of_birth: string };
    expect(user.name).toBe('Riyaz Shaikh');
    expect(user.language).toBe('mr');
    expect(user.date_of_birth).toBe('1990-01-01');
  });
});

// ============================================================
// blockUser
// ============================================================

describe('blockUser', () => {
  it('blocks an existing user', () => {
    createComplaint(db, { phone: '919876543210', description: 'Test', language: 'mr' });
    const result = blockUser(db, { phone: '919876543210', reason: 'Abusive messages' });
    expect(result).toBe('OK');

    const user = getUser(db, { phone: '919876543210' }) as { is_blocked: number };
    expect(user.is_blocked).toBe(1);

    // Verify block_reason via direct SQL (not exposed via getUser API)
    const row = db.prepare('SELECT block_reason FROM users WHERE phone = ?').get('919876543210') as { block_reason: string };
    expect(row.block_reason).toBe('Abusive messages');
  });

  it('blocks a new user (creates record)', () => {
    blockUser(db, { phone: '910000000000', reason: 'Spam' });

    const user = getUser(db, { phone: '910000000000' }) as { is_blocked: number };
    expect(user.is_blocked).toBe(1);

    const row = db.prepare('SELECT block_reason FROM users WHERE phone = ?').get('910000000000') as { block_reason: string };
    expect(row.block_reason).toBe('Spam');
  });
});
