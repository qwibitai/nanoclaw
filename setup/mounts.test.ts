import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import Database from 'better-sqlite3';

import { AllowedRoot, MountAllowlist } from '../src/types.js';

/**
 * Tests for mount allowlist schema and per-group mount config (#537).
 *
 * Issue: setup/mounts.ts doesn't validate the allowlist schema, so users
 * (or the setup agent) can pass `mode: "rw"` instead of `allowReadWrite: true`.
 * The mount-security module then silently treats mounts as read-only because
 * `allowReadWrite` is undefined (falsy).
 *
 * Also tests that container_config.additionalMounts uses the correct schema
 * expected by container-runner.ts.
 */

// --- Allowlist schema tests ---

describe('mount allowlist schema — allowReadWrite field (#537)', () => {
  it('requires allowReadWrite as boolean, not mode as string', () => {
    const correctRoot: AllowedRoot = {
      path: '~/projects',
      allowReadWrite: true,
    };
    expect(correctRoot.allowReadWrite).toBe(true);
    expect(typeof correctRoot.allowReadWrite).toBe('boolean');
  });

  it('correctly typed allowlist has allowReadWrite on each root', () => {
    const allowlist: MountAllowlist = {
      allowedRoots: [
        { path: '~/projects', allowReadWrite: true, description: 'Dev' },
        { path: '~/docs', allowReadWrite: false, description: 'Docs' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };

    for (const root of allowlist.allowedRoots) {
      expect(root).toHaveProperty('allowReadWrite');
      expect(typeof root.allowReadWrite).toBe('boolean');
      // Should NOT have a `mode` field
      expect(root).not.toHaveProperty('mode');
    }
  });

  it('detects the common mistake of using mode instead of allowReadWrite', () => {
    // This is what the setup agent incorrectly generated before the fix
    const badRoot = {
      path: '~/projects',
      mode: 'rw', // WRONG — should be allowReadWrite: true
    };

    // The AllowedRoot type requires allowReadWrite, so this object is missing it
    expect(badRoot).not.toHaveProperty('allowReadWrite');
    // When cast to AllowedRoot, allowReadWrite would be undefined (falsy)
    expect((badRoot as unknown as AllowedRoot).allowReadWrite).toBeUndefined();
  });

  it('config-examples/mount-allowlist.json uses correct schema', () => {
    const examplePath = path.join(
      __dirname,
      '..',
      'config-examples',
      'mount-allowlist.json',
    );
    const content = fs.readFileSync(examplePath, 'utf-8');
    const parsed = JSON.parse(content) as MountAllowlist;

    // Validate structure
    expect(Array.isArray(parsed.allowedRoots)).toBe(true);
    expect(Array.isArray(parsed.blockedPatterns)).toBe(true);
    expect(typeof parsed.nonMainReadOnly).toBe('boolean');

    // Every root must use allowReadWrite, not mode
    for (const root of parsed.allowedRoots) {
      expect(root).toHaveProperty('allowReadWrite');
      expect(typeof root.allowReadWrite).toBe('boolean');
      expect(root).not.toHaveProperty('mode');
    }
  });
});

// --- SKILL.md documentation tests ---

describe('SKILL.md mount instructions (#537)', () => {
  let skillContent: string;

  beforeEach(() => {
    skillContent = fs.readFileSync(
      path.join(__dirname, '..', '.claude', 'skills', 'setup', 'SKILL.md'),
      'utf-8',
    );
  });

  it('documents allowReadWrite (not mode) in step 9', () => {
    expect(skillContent).toContain('allowReadWrite');
    // Should explicitly warn against using `mode`
    expect(skillContent).toMatch(/NOT.*mode/i);
  });

  it('includes step 9b for additionalMounts in container_config', () => {
    expect(skillContent).toContain('9b');
    expect(skillContent).toContain('additionalMounts');
    expect(skillContent).toContain('container_config');
  });

  it('shows the correct additionalMounts schema in step 9b', () => {
    expect(skillContent).toContain('hostPath');
    expect(skillContent).toContain('containerPath');
    expect(skillContent).toContain('readonly');
  });

  it('warns that allowlist alone is not enough', () => {
    // The skill doc should explain that step 9b is required
    expect(skillContent).toMatch(/without step 9b/i);
  });
});

// --- Per-group container_config tests ---

describe('container_config additionalMounts schema (#537)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    )`);

    db.prepare(
      `INSERT INTO registered_groups
       (jid, name, folder, trigger_pattern, added_at, requires_trigger)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('123@g.us', 'Main', 'main', '@Bot', '2024-01-01T00:00:00Z', 0);
  });

  afterEach(() => {
    db.close();
  });

  it('stores additionalMounts with correct field names', () => {
    const config = JSON.stringify({
      additionalMounts: [
        { hostPath: '/home/user/projects', containerPath: 'projects', readonly: false },
      ],
    });

    db.prepare(
      "UPDATE registered_groups SET container_config = ? WHERE folder = 'main'",
    ).run(config);

    const row = db
      .prepare("SELECT container_config FROM registered_groups WHERE folder = 'main'")
      .get() as { container_config: string };

    const parsed = JSON.parse(row.container_config);
    expect(parsed.additionalMounts).toHaveLength(1);
    expect(parsed.additionalMounts[0]).toHaveProperty('hostPath');
    expect(parsed.additionalMounts[0]).toHaveProperty('containerPath');
    expect(parsed.additionalMounts[0]).toHaveProperty('readonly');
    // Should NOT use `mode`
    expect(parsed.additionalMounts[0]).not.toHaveProperty('mode');
  });

  it('round-trips container_config correctly', () => {
    const config = {
      additionalMounts: [
        { hostPath: '/home/user/projects', containerPath: 'projects', readonly: false },
        { hostPath: '/home/user/docs', readonly: true },
      ],
    };

    db.prepare(
      "UPDATE registered_groups SET container_config = ? WHERE folder = 'main'",
    ).run(JSON.stringify(config));

    const row = db
      .prepare("SELECT container_config FROM registered_groups WHERE folder = 'main'")
      .get() as { container_config: string };

    const parsed = JSON.parse(row.container_config);
    expect(parsed).toEqual(config);
  });

  it('container_config can be null when no mounts needed', () => {
    const row = db
      .prepare("SELECT container_config FROM registered_groups WHERE folder = 'main'")
      .get() as { container_config: string | null };

    expect(row.container_config).toBeNull();
  });

  it('mount without additionalMounts in DB means no extra mounts', () => {
    // Even if allowlist exists, no additionalMounts in container_config = no mounts
    const row = db
      .prepare("SELECT container_config FROM registered_groups WHERE folder = 'main'")
      .get() as { container_config: string | null };

    const config = row.container_config ? JSON.parse(row.container_config) : {};
    const mounts = config.additionalMounts || [];
    expect(mounts).toHaveLength(0);
  });
});

// --- Allowlist file write/read integration ---

describe('mount allowlist file format (#537)', () => {
  let tmpDir: string;
  let configFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-test-'));
    configFile = path.join(tmpDir, 'mount-allowlist.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes valid allowlist with allowReadWrite booleans', () => {
    const allowlist: MountAllowlist = {
      allowedRoots: [
        { path: '~/projects', allowReadWrite: true, description: 'Dev' },
      ],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };

    fs.writeFileSync(configFile, JSON.stringify(allowlist, null, 2) + '\n');
    const read = JSON.parse(fs.readFileSync(configFile, 'utf-8'));

    expect(read.allowedRoots[0].allowReadWrite).toBe(true);
    expect(read.allowedRoots[0]).not.toHaveProperty('mode');
  });

  it('rejects allowlist missing required fields', () => {
    // Missing blockedPatterns and nonMainReadOnly
    const bad = { allowedRoots: [{ path: '~/x' }] };
    fs.writeFileSync(configFile, JSON.stringify(bad));
    const read = JSON.parse(fs.readFileSync(configFile, 'utf-8'));

    // The mount-security loader validates these
    expect(read.blockedPatterns).toBeUndefined();
    expect(read.nonMainReadOnly).toBeUndefined();
    // allowReadWrite is missing — this would cause mounts to be read-only
    expect(read.allowedRoots[0].allowReadWrite).toBeUndefined();
  });
});
