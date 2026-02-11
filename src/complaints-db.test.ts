import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';

import { _initTestDatabase, _getTestDatabase, runMigrations } from './db.js';

const TOOLS_DIR = path.resolve(import.meta.dirname, '..', 'tools');

// Helper: run a shell script against a temp DB
function runTool(
  script: string,
  args: string[],
  dbPath: string,
  env?: Record<string, string>,
): { stdout: string; exitCode: number } {
  const scriptPath = path.join(TOOLS_DIR, script);
  try {
    const stdout = execFileSync('bash', [scriptPath, ...args], {
      encoding: 'utf-8',
      env: {
        ...process.env,
        DB_PATH: dbPath,
        ...env,
      },
      timeout: 5000,
    });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return {
      stdout: (e.stdout || '').toString().trim(),
      exitCode: e.status ?? 1,
    };
  }
}

// ============================================================
// MIGRATION TESTS
// ============================================================

describe('P1-S3: Database migrations', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('migration creates all expected tables', () => {
    const db = _getTestDatabase();
    runMigrations(db);

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);

    // Complaint-specific tables
    expect(tableNames).toContain('tenant_config');
    expect(tableNames).toContain('users');
    expect(tableNames).toContain('complaints');
    expect(tableNames).toContain('complaint_updates');
    expect(tableNames).toContain('conversations');
    expect(tableNames).toContain('rate_limits');
    expect(tableNames).toContain('usage_log');
    expect(tableNames).toContain('categories');
  });

  it('all specified indexes exist after migration', () => {
    const db = _getTestDatabase();
    runMigrations(db);

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'`)
      .all() as { name: string }[];

    const indexNames = indexes.map((i) => i.name);

    const expectedIndexes = [
      'idx_complaints_phone',
      'idx_complaints_status',
      'idx_complaints_category',
      'idx_complaints_created',
      'idx_complaints_days_open',
      'idx_updates_complaint',
      'idx_conversations_phone',
      'idx_usage_phone',
      'idx_usage_date',
      'idx_usage_model',
    ];

    for (const idx of expectedIndexes) {
      expect(indexNames, `missing index: ${idx}`).toContain(idx);
    }
  });

  it('days_open_live computed via view returns correct value', () => {
    const db = _getTestDatabase();
    runMigrations(db);

    // Insert a user first (FK constraint)
    db.prepare(
      `INSERT INTO users (phone, first_seen, last_seen) VALUES ('919999999999', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();

    // Insert a complaint created 5 days ago
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO complaints (id, phone, description, language, status, created_at, updated_at) VALUES (?, '919999999999', 'test', 'en', 'registered', ?, ?)`,
    ).run('TEST-20260101-0001', fiveDaysAgo, fiveDaysAgo);

    const row = db
      .prepare(`SELECT days_open_live FROM complaints_view WHERE id = ?`)
      .get('TEST-20260101-0001') as { days_open_live: number };

    // Should be approximately 5 (allow +/- 1 for timezone edge)
    expect(row.days_open_live).toBeGreaterThanOrEqual(4);
    expect(row.days_open_live).toBeLessThanOrEqual(6);
  });

  it('migration is idempotent (can run twice without error)', () => {
    const db = _getTestDatabase();
    runMigrations(db);
    // Second run should not throw
    expect(() => runMigrations(db)).not.toThrow();
  });
});

// ============================================================
// SHELL SCRIPT TOOL TESTS
// ============================================================

describe('P1-S3: Shell script tools', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    // Create a fresh temp DB for each test
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'complaints-test-'));
    dbPath = path.join(tmpDir, 'test.db');

    // Initialize db with both nanoclaw schema and complaint migrations
    const db = new Database(dbPath);
    // Create nanoclaw base schema (minimal)
    db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        last_message_time TEXT
      );
    `);

    // Run complaint migrations
    const migrationPath = path.resolve(
      import.meta.dirname,
      '..',
      'src',
      'migrations',
      '001-complaints.sql',
    );
    if (fs.existsSync(migrationPath)) {
      const sql = fs.readFileSync(migrationPath, 'utf-8');
      db.exec(sql);
    }

    // Seed tenant config with prefix
    db.prepare(`INSERT INTO tenant_config (key, value) VALUES ('complaint_id_prefix', 'RK')`).run();

    // Seed a test user
    db.prepare(
      `INSERT INTO users (phone, name, first_seen, last_seen) VALUES ('919876543210', 'Test User', datetime('now'), datetime('now'))`,
    ).run();

    // Seed some categories
    db.prepare(
      `INSERT INTO categories (name, display_name_en, display_name_mr, display_name_hi, first_seen) VALUES ('water_supply', 'Water Supply', 'पाणी पुरवठा', 'जल आपूर्ति', datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO categories (name, display_name_en, display_name_mr, display_name_hi, first_seen) VALUES ('roads', 'Roads', 'रस्ते', 'सड़कें', datetime('now'))`,
    ).run();

    db.close();
  });

  // --- create-complaint.sh ---

  describe('create-complaint.sh', () => {
    it('generates sequential IDs within the same day', () => {
      const r1 = runTool('create-complaint.sh', [
        '--phone', '919876543210',
        '--description', 'Water not available',
        '--language', 'en',
      ], dbPath);
      expect(r1.exitCode).toBe(0);
      expect(r1.stdout).toMatch(/^RK-\d{8}-0001$/);

      const r2 = runTool('create-complaint.sh', [
        '--phone', '919876543210',
        '--description', 'Road is broken',
        '--language', 'en',
      ], dbPath);
      expect(r2.exitCode).toBe(0);
      expect(r2.stdout).toMatch(/^RK-\d{8}-0002$/);
    });

    it('tracking ID prefix comes from tenant config', () => {
      // Change prefix to 'XY'
      const db = new Database(dbPath);
      db.prepare(`UPDATE tenant_config SET value = 'XY' WHERE key = 'complaint_id_prefix'`).run();
      db.close();

      const r = runTool('create-complaint.sh', [
        '--phone', '919876543210',
        '--description', 'Test complaint',
        '--language', 'mr',
      ], dbPath);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/^XY-\d{8}-0001$/);
    });

    it('returns non-zero on missing required args', () => {
      // Missing --phone
      const r = runTool('create-complaint.sh', [
        '--description', 'Test',
        '--language', 'en',
      ], dbPath);
      expect(r.exitCode).not.toBe(0);
    });

    it('returns non-zero on missing --description', () => {
      const r = runTool('create-complaint.sh', [
        '--phone', '919876543210',
        '--language', 'en',
      ], dbPath);
      expect(r.exitCode).not.toBe(0);
    });

    it('accepts optional --category and --location', () => {
      const r = runTool('create-complaint.sh', [
        '--phone', '919876543210',
        '--description', 'Pothole on main road',
        '--language', 'en',
        '--category', 'roads',
        '--location', 'Ward 5',
      ], dbPath);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/^RK-\d{8}-0001$/);

      // Verify stored
      const db = new Database(dbPath);
      const row = db.prepare(`SELECT category, location FROM complaints WHERE id = ?`).get(r.stdout) as { category: string; location: string };
      expect(row.category).toBe('roads');
      expect(row.location).toBe('Ward 5');
      db.close();
    });

    it('auto-creates user if not exists', () => {
      const r = runTool('create-complaint.sh', [
        '--phone', '919111111111',
        '--description', 'New user complaint',
        '--language', 'hi',
      ], dbPath);
      expect(r.exitCode).toBe(0);

      const db = new Database(dbPath);
      const user = db.prepare(`SELECT * FROM users WHERE phone = '919111111111'`).get() as { phone: string } | undefined;
      expect(user).toBeDefined();
      db.close();
    });
  });

  // --- query-complaints.sh ---

  describe('query-complaints.sh', () => {
    beforeEach(() => {
      // Create two complaints
      runTool('create-complaint.sh', [
        '--phone', '919876543210',
        '--description', 'Water issue',
        '--language', 'en',
        '--category', 'water_supply',
      ], dbPath);
      runTool('create-complaint.sh', [
        '--phone', '919876543210',
        '--description', 'Road issue',
        '--language', 'en',
        '--category', 'roads',
      ], dbPath);
    });

    it('returns complaints by phone number', () => {
      const r = runTool('query-complaints.sh', [
        '--phone', '919876543210',
      ], dbPath);
      expect(r.exitCode).toBe(0);
      // Should contain both complaints in JSON
      const data = JSON.parse(r.stdout);
      expect(data).toHaveLength(2);
    });

    it('returns complaint by complaint ID', () => {
      const r = runTool('query-complaints.sh', [
        '--id', `RK-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-0001`,
      ], dbPath);
      expect(r.exitCode).toBe(0);
      const data = JSON.parse(r.stdout);
      expect(data).toHaveLength(1);
      expect(data[0].description).toBe('Water issue');
    });

    it('returns empty array for unknown phone', () => {
      const r = runTool('query-complaints.sh', [
        '--phone', '910000000000',
      ], dbPath);
      expect(r.exitCode).toBe(0);
      const data = JSON.parse(r.stdout);
      expect(data).toHaveLength(0);
    });

    it('returns non-zero when no filter provided', () => {
      const r = runTool('query-complaints.sh', [], dbPath);
      expect(r.exitCode).not.toBe(0);
    });
  });

  // --- update-complaint.sh ---

  describe('update-complaint.sh', () => {
    let complaintId: string;

    beforeEach(() => {
      const r = runTool('create-complaint.sh', [
        '--phone', '919876543210',
        '--description', 'Test for update',
        '--language', 'en',
      ], dbPath);
      complaintId = r.stdout;
    });

    it('changes status and creates audit record', () => {
      const r = runTool('update-complaint.sh', [
        '--id', complaintId,
        '--status', 'acknowledged',
      ], dbPath);
      expect(r.exitCode).toBe(0);

      // Verify status changed
      const db = new Database(dbPath);
      const complaint = db.prepare(`SELECT status FROM complaints WHERE id = ?`).get(complaintId) as { status: string };
      expect(complaint.status).toBe('acknowledged');

      // Verify audit record
      const audit = db.prepare(`SELECT * FROM complaint_updates WHERE complaint_id = ?`).all(complaintId) as Array<{ old_status: string; new_status: string }>;
      expect(audit).toHaveLength(1);
      expect(audit[0].old_status).toBe('registered');
      expect(audit[0].new_status).toBe('acknowledged');
      db.close();
    });

    it('rejects invalid status values', () => {
      const r = runTool('update-complaint.sh', [
        '--id', complaintId,
        '--status', 'invalid_status',
      ], dbPath);
      expect(r.exitCode).not.toBe(0);
    });

    it('accepts all valid statuses', () => {
      const validStatuses = [
        'registered', 'acknowledged', 'in_progress',
        'action_taken', 'resolved', 'on_hold', 'escalated',
      ];
      for (const status of validStatuses) {
        const r = runTool('update-complaint.sh', [
          '--id', complaintId,
          '--status', status,
        ], dbPath);
        expect(r.exitCode, `status '${status}' should be accepted`).toBe(0);
      }
    });

    it('accepts optional --note and --updated-by', () => {
      const r = runTool('update-complaint.sh', [
        '--id', complaintId,
        '--status', 'in_progress',
        '--note', 'Work has started',
        '--updated-by', '919876543210',
      ], dbPath);
      expect(r.exitCode).toBe(0);

      const db = new Database(dbPath);
      const audit = db.prepare(`SELECT note, updated_by FROM complaint_updates WHERE complaint_id = ? ORDER BY id DESC LIMIT 1`).get(complaintId) as { note: string; updated_by: string };
      expect(audit.note).toBe('Work has started');
      expect(audit.updated_by).toBe('919876543210');
      db.close();
    });

    it('returns non-zero for non-existent complaint', () => {
      const r = runTool('update-complaint.sh', [
        '--id', 'NONEXIST-00000000-0000',
        '--status', 'acknowledged',
      ], dbPath);
      expect(r.exitCode).not.toBe(0);
    });

    it('sets resolved_at when transitioning to resolved', () => {
      const r = runTool('update-complaint.sh', [
        '--id', complaintId,
        '--status', 'resolved',
      ], dbPath);
      expect(r.exitCode).toBe(0);

      const db = new Database(dbPath);
      const complaint = db.prepare(`SELECT resolved_at FROM complaints WHERE id = ?`).get(complaintId) as { resolved_at: string | null };
      expect(complaint.resolved_at).not.toBeNull();
      db.close();
    });
  });

  // --- get-categories.sh ---

  describe('get-categories.sh', () => {
    it('returns list of active categories', () => {
      const r = runTool('get-categories.sh', [], dbPath);
      expect(r.exitCode).toBe(0);
      const data = JSON.parse(r.stdout);
      expect(data).toHaveLength(2);
      expect(data.map((c: { name: string }) => c.name)).toContain('water_supply');
      expect(data.map((c: { name: string }) => c.name)).toContain('roads');
    });

    it('excludes inactive categories', () => {
      const db = new Database(dbPath);
      db.prepare(`UPDATE categories SET is_active = 0 WHERE name = 'roads'`).run();
      db.close();

      const r = runTool('get-categories.sh', [], dbPath);
      expect(r.exitCode).toBe(0);
      const data = JSON.parse(r.stdout);
      expect(data).toHaveLength(1);
      expect(data[0].name).toBe('water_supply');
    });
  });
});
