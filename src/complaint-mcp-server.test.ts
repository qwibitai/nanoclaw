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
  setUserRoleTool,
} from './complaint-mcp-server.js';
import { _initTestDatabase, _getTestDatabase, runMigrations } from './db.js';

let db: Database.Database;

function seedTenantConfig(database: Database.Database): void {
  database
    .prepare(
      "INSERT OR REPLACE INTO tenant_config (key, value) VALUES ('complaint_id_prefix', 'RK')",
    )
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
      .get('919876543210') as {
      phone: string;
      language: string;
      total_complaints: number;
    };
    expect(user).toBeDefined();
    expect(user.language).toBe('hi');
    expect(user.total_complaints).toBe(1);
  });

  it('increments total_complaints for existing user', () => {
    createComplaint(db, {
      phone: '919876543210',
      description: 'First',
      language: 'mr',
    });
    createComplaint(db, {
      phone: '919876543210',
      description: 'Second',
      language: 'mr',
    });

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

  it('auto-resolves area_id from location when validation is enabled', () => {
    // Enable karyakarta validation
    db.prepare(
      "INSERT INTO tenant_config (key, value) VALUES ('karyakarta_validation_enabled', 'true')",
    ).run();

    // Create an area
    db.prepare(
      "INSERT INTO areas (id, name, is_active, created_at, updated_at) VALUES ('shivaji-nagar', 'Shivaji Nagar', 1, datetime('now'), datetime('now'))",
    ).run();

    const id = createComplaint(db, {
      phone: '919876543210',
      description: 'Pothole near bus stop',
      location: 'Shivaji Nagar, Ward 7',
      language: 'mr',
    });

    const complaint = db
      .prepare('SELECT status, area_id FROM complaints WHERE id = ?')
      .get(id) as { status: string; area_id: string | null };
    expect(complaint.status).toBe('pending_validation');
    expect(complaint.area_id).toBe('shivaji-nagar');
  });

  it('sets status to registered when no area matches location', () => {
    // Enable karyakarta validation
    db.prepare(
      "INSERT INTO tenant_config (key, value) VALUES ('karyakarta_validation_enabled', 'true')",
    ).run();

    // Create an area that won't match
    db.prepare(
      "INSERT INTO areas (id, name, is_active, created_at, updated_at) VALUES ('kedgaon', 'Kedgaon', 1, datetime('now'), datetime('now'))",
    ).run();

    const id = createComplaint(db, {
      phone: '919876543210',
      description: 'Power outage',
      location: 'Remote village XYZ',
      language: 'mr',
    });

    const complaint = db
      .prepare('SELECT status, area_id FROM complaints WHERE id = ?')
      .get(id) as { status: string; area_id: string | null };
    expect(complaint.status).toBe('registered');
    expect(complaint.area_id).toBeNull();
  });

  it('uses explicit area_id when provided even with validation enabled', () => {
    db.prepare(
      "INSERT INTO tenant_config (key, value) VALUES ('karyakarta_validation_enabled', 'true')",
    ).run();
    db.prepare(
      "INSERT INTO areas (id, name, is_active, created_at, updated_at) VALUES ('daund-city', 'Daund City', 1, datetime('now'), datetime('now'))",
    ).run();

    const id = createComplaint(db, {
      phone: '919876543210',
      description: 'Water issue',
      location: 'Some random place',
      language: 'mr',
      area_id: 'daund-city',
    });

    const complaint = db
      .prepare('SELECT status, area_id FROM complaints WHERE id = ?')
      .get(id) as { status: string; area_id: string | null };
    expect(complaint.status).toBe('pending_validation');
    expect(complaint.area_id).toBe('daund-city');
  });

  it('throws if complaint_id_prefix is missing', () => {
    db.prepare(
      "DELETE FROM tenant_config WHERE key = 'complaint_id_prefix'",
    ).run();

    expect(() =>
      createComplaint(db, {
        phone: '919876543210',
        description: 'Test',
        language: 'mr',
      }),
    ).toThrow('complaint_id_prefix not found');
  });

  it('stores source as voice when specified', () => {
    const id = createComplaint(db, {
      phone: '919876543210',
      description: 'Voice complaint about water',
      language: 'mr',
      source: 'voice',
      voice_message_id: 'wmsg-abc123',
    });

    const complaint = db
      .prepare('SELECT source, voice_message_id FROM complaints WHERE id = ?')
      .get(id) as { source: string; voice_message_id: string | null };
    expect(complaint.source).toBe('voice');
    expect(complaint.voice_message_id).toBe('wmsg-abc123');
  });

  it('rejects description exceeding 5000 characters', () => {
    const longDescription = 'x'.repeat(5001);
    expect(() =>
      createComplaint(db, {
        phone: '919876543210',
        description: longDescription,
        language: 'mr',
      }),
    ).toThrow('description exceeds 5000 character limit');
  });

  it('defaults source to text when not specified', () => {
    const id = createComplaint(db, {
      phone: '919876543210',
      description: 'Text complaint',
      language: 'mr',
    });

    const complaint = db
      .prepare('SELECT source, voice_message_id FROM complaints WHERE id = ?')
      .get(id) as { source: string; voice_message_id: string | null };
    expect(complaint.source).toBe('text');
    expect(complaint.voice_message_id).toBeNull();
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
    const all = queryComplaints(db, { phone: '919876543210' }) as {
      id: string;
    }[];
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
    expect(() => queryComplaints(db, {})).toThrow(
      'Either phone or id is required',
    );
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
    const result = updateComplaint(db, {
      id: complaintId,
      status: 'in_progress',
    });
    expect(result).toBe('OK');

    const complaint = db
      .prepare('SELECT status FROM complaints WHERE id = ?')
      .get(complaintId) as { status: string };
    expect(complaint.status).toBe('in_progress');
  });

  it('creates audit record', () => {
    updateComplaint(db, {
      id: complaintId,
      status: 'acknowledged',
      note: 'Reviewed by admin',
    });

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
    const result = updateUser(db, {
      phone: '919876543210',
      name: 'Riyaz Shaikh',
    });
    expect(result).toBe('OK');

    const user = getUser(db, { phone: '919876543210' }) as {
      name: string;
      language: string;
    };
    expect(user.name).toBe('Riyaz Shaikh');
    expect(user.language).toBe('mr'); // default
  });

  it('updates name for existing user', () => {
    createComplaint(db, {
      phone: '919876543210',
      description: 'Test',
      language: 'hi',
    });
    updateUser(db, { phone: '919876543210', name: 'Rajesh Kumar' });

    const user = getUser(db, { phone: '919876543210' }) as { name: string };
    expect(user.name).toBe('Rajesh Kumar');
  });

  it('updates date_of_birth', () => {
    updateUser(db, {
      phone: '919876543210',
      name: 'Test User',
      date_of_birth: '1990-05-15',
    });

    const user = getUser(db, { phone: '919876543210' }) as {
      date_of_birth: string;
    };
    expect(user.date_of_birth).toBe('1990-05-15');
  });

  it('updates language preference', () => {
    updateUser(db, { phone: '919876543210', language: 'hi' });

    const user = getUser(db, { phone: '919876543210' }) as { language: string };
    expect(user.language).toBe('hi');
  });

  it('preserves existing fields when updating selectively', () => {
    updateUser(db, {
      phone: '919876543210',
      name: 'Riyaz Shaikh',
      language: 'mr',
    });
    updateUser(db, { phone: '919876543210', date_of_birth: '1990-01-01' });

    const user = getUser(db, { phone: '919876543210' }) as {
      name: string;
      language: string;
      date_of_birth: string;
    };
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
    createComplaint(db, {
      phone: '919876543210',
      description: 'Test',
      language: 'mr',
    });
    const result = blockUser(db, {
      phone: '919876543210',
      reason: 'Abusive messages',
    });
    expect(result).toBe('OK');

    const user = getUser(db, { phone: '919876543210' }) as {
      is_blocked: number;
    };
    expect(user.is_blocked).toBe(1);

    // Verify block_reason via direct SQL (not exposed via getUser API)
    const row = db
      .prepare('SELECT block_reason FROM users WHERE phone = ?')
      .get('919876543210') as { block_reason: string };
    expect(row.block_reason).toBe('Abusive messages');
  });

  it('blocks a new user (creates record)', () => {
    blockUser(db, { phone: '910000000000', reason: 'Spam' });

    const user = getUser(db, { phone: '910000000000' }) as {
      is_blocked: number;
    };
    expect(user.is_blocked).toBe(1);

    const row = db
      .prepare('SELECT block_reason FROM users WHERE phone = ?')
      .get('910000000000') as { block_reason: string };
    expect(row.block_reason).toBe('Spam');
  });

  it('refuses to block admin user', () => {
    createComplaint(db, {
      phone: '919876543210',
      description: 'Test',
      language: 'mr',
    });
    db.prepare(
      "UPDATE users SET role = 'admin' WHERE phone = '919876543210'",
    ).run();

    const result = blockUser(db, { phone: '919876543210', reason: 'Test' });
    expect(result).toContain('cannot be blocked');

    const user = getUser(db, { phone: '919876543210' }) as {
      is_blocked: number;
    };
    expect(user.is_blocked).toBe(0);
  });

  it('refuses to block superadmin user', () => {
    createComplaint(db, {
      phone: '919876543210',
      description: 'Test',
      language: 'mr',
    });
    db.prepare(
      "UPDATE users SET role = 'superadmin' WHERE phone = '919876543210'",
    ).run();

    const result = blockUser(db, { phone: '919876543210', reason: 'Test' });
    expect(result).toContain('cannot be blocked');
  });

  it('sets blocked_until when blocking', () => {
    createComplaint(db, {
      phone: '919876543210',
      description: 'Test',
      language: 'mr',
    });
    blockUser(db, { phone: '919876543210', reason: 'Spam' });

    const row = db
      .prepare('SELECT blocked_until FROM users WHERE phone = ?')
      .get('919876543210') as { blocked_until: string };
    expect(row.blocked_until).toBeTruthy();

    // Default is 24 hours from now
    const blockedUntil = new Date(row.blocked_until).getTime();
    const expectedApprox = Date.now() + 24 * 60 * 60 * 1000;
    expect(Math.abs(blockedUntil - expectedApprox)).toBeLessThan(5000);
  });

  it('respects block_duration_hours from tenant config', () => {
    db.prepare(
      "INSERT OR REPLACE INTO tenant_config (key, value) VALUES ('block_duration_hours', '48')",
    ).run();
    createComplaint(db, {
      phone: '919876543210',
      description: 'Test',
      language: 'mr',
    });
    blockUser(db, { phone: '919876543210', reason: 'Spam' });

    const row = db
      .prepare('SELECT blocked_until FROM users WHERE phone = ?')
      .get('919876543210') as { blocked_until: string };
    const blockedUntil = new Date(row.blocked_until).getTime();
    const expectedApprox = Date.now() + 48 * 60 * 60 * 1000;
    expect(Math.abs(blockedUntil - expectedApprox)).toBeLessThan(5000);
  });
});

// ============================================================
// getUser — role and blocked_until fields
// ============================================================

describe('getUser — role fields', () => {
  it('includes role and blocked_until in response', () => {
    createComplaint(db, {
      phone: '919876543210',
      description: 'Test',
      language: 'mr',
    });

    const user = getUser(db, { phone: '919876543210' }) as {
      role: string;
      blocked_until: string | null;
    };
    expect(user.role).toBe('user');
    expect(user.blocked_until).toBeNull();
  });

  it('returns updated role after setUserRoleTool', () => {
    createComplaint(db, {
      phone: '919876543210',
      description: 'Test',
      language: 'mr',
    });
    setUserRoleTool(db, {
      phone: '919876543210',
      role: 'admin',
      caller_role: 'superadmin',
    });

    const user = getUser(db, { phone: '919876543210' }) as { role: string };
    expect(user.role).toBe('admin');
  });
});

// ============================================================
// setUserRoleTool
// ============================================================

describe('setUserRoleTool', () => {
  beforeEach(() => {
    createComplaint(db, {
      phone: '919876543210',
      description: 'Test',
      language: 'mr',
    });
  });

  it('sets role via superadmin caller', () => {
    const result = setUserRoleTool(db, {
      phone: '919876543210',
      role: 'admin',
      caller_role: 'superadmin',
    });
    expect(result).toBe('OK');
  });

  it('rejects invalid role', () => {
    const result = setUserRoleTool(db, {
      phone: '919876543210',
      role: 'invalid',
      caller_role: 'superadmin',
    });
    expect(result).toContain('Invalid role');
  });

  it('rejects invalid caller_role', () => {
    const result = setUserRoleTool(db, {
      phone: '919876543210',
      role: 'admin',
      caller_role: 'invalid',
    });
    expect(result).toContain('Invalid caller_role');
  });
});
