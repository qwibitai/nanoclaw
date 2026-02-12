import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';

import { matchArea, clearAreaCache, type AreaMatch } from './area-matcher.js';
import { resolveArea } from './complaint-mcp-server.js';
import { createTestDb, seedArea } from './test-helpers.js';

let db: Database.Database;

beforeEach(() => {
  clearAreaCache();
  db = createTestDb();
  seedArea(db, { name: 'Shivaji Nagar', name_mr: 'शिवाजी नगर' });
  seedArea(db, { name: 'Kothrud' });
  seedArea(db, { name: 'Hadapsar' });
  seedArea(db, { name: 'Deccan Gymkhana' });
});

// ============================================================
// matchArea — exact matching
// ============================================================

describe('matchArea — exact matching', () => {
  it('returns confidence 1.0 for exact name match', () => {
    const matches = matchArea(db, 'Shivaji Nagar');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].name).toBe('Shivaji Nagar');
    expect(matches[0].confidence).toBe(1.0);
  });

  it('returns confidence 1.0 for exact Marathi name match', () => {
    const matches = matchArea(db, 'शिवाजी नगर');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].name).toBe('Shivaji Nagar');
    expect(matches[0].confidence).toBe(1.0);
  });

  it('is case-insensitive for exact matches', () => {
    const matches = matchArea(db, 'shivaji nagar');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].name).toBe('Shivaji Nagar');
    expect(matches[0].confidence).toBe(1.0);
  });

  it('matches exact name for single-word area', () => {
    const matches = matchArea(db, 'Kothrud');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].name).toBe('Kothrud');
    expect(matches[0].confidence).toBe(1.0);
  });
});

// ============================================================
// matchArea — contains matching
// ============================================================

describe('matchArea — contains matching', () => {
  it('returns high confidence when area name is substring of location text', () => {
    const matches = matchArea(db, 'Ward 7, Shivaji Nagar area');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const shivaji = matches.find((m) => m.name === 'Shivaji Nagar');
    expect(shivaji).toBeDefined();
    expect(shivaji!.confidence).toBe(0.9);
  });

  it('is case-insensitive for contains matching', () => {
    const matches = matchArea(db, 'near kothrud bus stop');
    const kothrud = matches.find((m) => m.name === 'Kothrud');
    expect(kothrud).toBeDefined();
    expect(kothrud!.confidence).toBe(0.9);
  });
});

// ============================================================
// matchArea — fuzzy matching
// ============================================================

describe('matchArea — fuzzy matching', () => {
  it('matches "Shivaji Nagr" to "Shivaji Nagar" with high confidence', () => {
    const matches = matchArea(db, 'Shivaji Nagr');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    const shivaji = matches.find((m) => m.name === 'Shivaji Nagar');
    expect(shivaji).toBeDefined();
    expect(shivaji!.confidence).toBeGreaterThan(0.6);
  });

  it('matches "Kothrd" to "Kothrud" with confidence > 0.6', () => {
    const matches = matchArea(db, 'Kothrd');
    const kothrud = matches.find((m) => m.name === 'Kothrud');
    expect(kothrud).toBeDefined();
    expect(kothrud!.confidence).toBeGreaterThan(0.6);
  });
});

// ============================================================
// matchArea — no match / edge cases
// ============================================================

describe('matchArea — no match / edge cases', () => {
  it('returns empty array when no areas match', () => {
    const matches = matchArea(db, 'Timbuktu');
    expect(matches).toEqual([]);
  });

  it('returns empty array for empty location text', () => {
    const matches = matchArea(db, '');
    expect(matches).toEqual([]);
  });

  it('ignores inactive areas', () => {
    // Deactivate Kothrud
    db.prepare("UPDATE areas SET is_active = 0 WHERE name = 'Kothrud'").run();
    const matches = matchArea(db, 'Kothrud');
    const kothrud = matches.find((m) => m.name === 'Kothrud');
    expect(kothrud).toBeUndefined();
  });

  it('returns at most 5 results', () => {
    // Seed many areas
    for (let i = 0; i < 10; i++) {
      seedArea(db, { name: `Area ${i}` });
    }
    // "Area" is a common substring — should be limited to 5
    const matches = matchArea(db, 'Area');
    expect(matches.length).toBeLessThanOrEqual(5);
  });
});

// ============================================================
// matchArea — ranking
// ============================================================

describe('matchArea — ranking', () => {
  it('ranks exact match above contains match', () => {
    // "Shivaji Nagar" is both an exact match and could be a contains match
    const matches = matchArea(db, 'Shivaji Nagar');
    expect(matches[0].confidence).toBe(1.0);
  });

  it('ranks matches by confidence descending', () => {
    // Should get multiple fuzzy matches; verify they are sorted
    const matches = matchArea(db, 'Shivaji Nagr area');
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].confidence).toBeGreaterThanOrEqual(
        matches[i].confidence,
      );
    }
  });
});

// ============================================================
// matchArea — Hindi name matching
// ============================================================

describe('matchArea — Hindi name matching', () => {
  it('matches Hindi name field', () => {
    // Add area with Hindi name
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO areas (id, name, name_hi, type, is_active, created_at, updated_at)
       VALUES ('test-hi', 'Test Area', 'टेस्ट एरिया', 'custom', 1, ?, ?)`,
    ).run(now, now);

    const matches = matchArea(db, 'टेस्ट एरिया');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].name).toBe('Test Area');
    expect(matches[0].confidence).toBe(1.0);
  });
});

// ============================================================
// resolveArea
// ============================================================

describe('resolveArea', () => {
  it('returns formatted matches for valid location', () => {
    const result = resolveArea(db, { location_text: 'Shivaji Nagar' }) as {
      matches: AreaMatch[];
    };
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    expect(result.matches[0].name).toBe('Shivaji Nagar');
  });

  it('returns empty matches with message for no match', () => {
    const result = resolveArea(db, { location_text: 'Timbuktu' }) as {
      matches: AreaMatch[];
      message: string;
    };
    expect(result.matches).toEqual([]);
    expect(result.message).toBe('No matching area found');
  });
});

// ============================================================
// createComplaint — feature flag behavior
// ============================================================

describe('createComplaint — karyakarta_validation_enabled feature flag', () => {
  // Import inline to avoid circular issues
  let createComplaint: typeof import('./complaint-mcp-server.js').createComplaint;

  beforeEach(async () => {
    const mod = await import('./complaint-mcp-server.js');
    createComplaint = mod.createComplaint;
  });

  it('sets status to registered when feature flag is off (default)', () => {
    const id = createComplaint(db, {
      phone: '919876543210',
      description: 'Water issue',
      language: 'mr',
      area_id: 'shivaji-nagar',
    });

    const complaint = db
      .prepare('SELECT status, area_id FROM complaints WHERE id = ?')
      .get(id) as {
      status: string;
      area_id: string | null;
    };
    expect(complaint.status).toBe('registered');
    // area_id still set even without flag
    expect(complaint.area_id).toBe('shivaji-nagar');
  });

  it('sets status to pending_validation when feature flag is on and area_id provided', () => {
    db.prepare(
      "INSERT INTO tenant_config (key, value) VALUES ('karyakarta_validation_enabled', 'true')",
    ).run();

    const id = createComplaint(db, {
      phone: '919876543210',
      description: 'Water issue',
      language: 'mr',
      area_id: 'shivaji-nagar',
    });

    const complaint = db
      .prepare('SELECT status, area_id FROM complaints WHERE id = ?')
      .get(id) as {
      status: string;
      area_id: string | null;
    };
    expect(complaint.status).toBe('pending_validation');
    expect(complaint.area_id).toBe('shivaji-nagar');
  });

  it('sets status to registered when feature flag is on but no area_id', () => {
    db.prepare(
      "INSERT INTO tenant_config (key, value) VALUES ('karyakarta_validation_enabled', 'true')",
    ).run();

    const id = createComplaint(db, {
      phone: '919876543210',
      description: 'Water issue',
      language: 'mr',
    });

    const complaint = db
      .prepare('SELECT status, area_id FROM complaints WHERE id = ?')
      .get(id) as {
      status: string;
      area_id: string | null;
    };
    expect(complaint.status).toBe('registered');
    expect(complaint.area_id).toBeNull();
  });

  it('emits correct status in event when pending_validation', async () => {
    db.prepare(
      "INSERT INTO tenant_config (key, value) VALUES ('karyakarta_validation_enabled', 'true')",
    ).run();

    // Listen for event
    const { eventBus } = await import('./event-bus.js');
    let emittedStatus: string | undefined;
    eventBus.on('complaint:created', (data: { status: string }) => {
      emittedStatus = data.status;
    });

    createComplaint(db, {
      phone: '919876543210',
      description: 'Water issue',
      language: 'mr',
      area_id: 'shivaji-nagar',
    });

    expect(emittedStatus).toBe('pending_validation');
  });
});

// ============================================================
// updateComplaint — new statuses
// ============================================================

describe('updateComplaint — new statuses', () => {
  let updateComplaint: typeof import('./complaint-mcp-server.js').updateComplaint;
  let createComplaint: typeof import('./complaint-mcp-server.js').createComplaint;
  let complaintId: string;

  beforeEach(async () => {
    const mod = await import('./complaint-mcp-server.js');
    updateComplaint = mod.updateComplaint;
    createComplaint = mod.createComplaint;
    complaintId = createComplaint(db, {
      phone: '919876543210',
      description: 'Test complaint',
      language: 'mr',
    });
  });

  it('accepts pending_validation status', () => {
    const result = updateComplaint(db, {
      id: complaintId,
      status: 'pending_validation',
    });
    expect(result).toBe('OK');
  });

  it('accepts validated status', () => {
    const result = updateComplaint(db, {
      id: complaintId,
      status: 'validated',
    });
    expect(result).toBe('OK');
  });

  it('accepts rejected status', () => {
    const result = updateComplaint(db, { id: complaintId, status: 'rejected' });
    expect(result).toBe('OK');
  });

  it('accepts escalated_timeout status', () => {
    const result = updateComplaint(db, {
      id: complaintId,
      status: 'escalated_timeout',
    });
    expect(result).toBe('OK');
  });

  it('still rejects truly invalid statuses', () => {
    expect(() =>
      updateComplaint(db, { id: complaintId, status: 'bogus_status' }),
    ).toThrow('Invalid status');
  });
});
