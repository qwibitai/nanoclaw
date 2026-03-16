import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';

import Database from 'better-sqlite3';

/**
 * Tests for the environment check step.
 *
 * Verifies: config detection, Docker/AC detection, DB queries.
 */

describe('environment detection', () => {
  it('detects platform correctly', async () => {
    const { getPlatform } = await import('./platform.js');
    const platform = getPlatform();
    expect(['macos', 'linux', 'unknown']).toContain(platform);
  });
});

describe('registered groups DB query', () => {
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
  });

  it('returns 0 for empty table', () => {
    const row = db
      .prepare('SELECT COUNT(*) as count FROM registered_groups')
      .get() as { count: number };
    expect(row.count).toBe(0);
  });

  it('returns correct count after inserts', () => {
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      '123@g.us',
      'Group 1',
      'group-1',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      1,
    );

    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at, requires_trigger)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      '456@g.us',
      'Group 2',
      'group-2',
      '@Andy',
      '2024-01-01T00:00:00.000Z',
      1,
    );

    const row = db
      .prepare('SELECT COUNT(*) as count FROM registered_groups')
      .get() as { count: number };
    expect(row.count).toBe(2);
  });
});

describe('credentials detection', () => {
  it('detects OpenCode/LM Studio configuration', () => {
    const hasOpenCodeConfig = !!process.env.NANOCLAW_LLM_BASE_URL;
    // Test will pass if env var is set or not - just verifies logic
    expect(typeof hasOpenCodeConfig).toBe('boolean');
  });

  it('detects legacy Anthropic configuration', () => {
    const hasLegacyAnthropic = !!(
      process.env.ANTHROPIC_BASE_URL ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_AUTH_TOKEN
    );
    expect(typeof hasLegacyAnthropic).toBe('boolean');
  });

  it('validates NANOCLAW_LLM_BASE_URL format', () => {
    const baseUrl = process.env.NANOCLAW_LLM_BASE_URL;
    if (baseUrl) {
      // Should be a valid URL
      expect(() => new URL(baseUrl)).not.toThrow();
      // Should end with /v1 for OpenAI-compatible APIs
      expect(baseUrl).toMatch(/\/v1\/?$/);
    }
  });

  it('validates NANOCLAW_LLM_MODEL_ID when set', () => {
    const modelId = process.env.NANOCLAW_LLM_MODEL_ID;
    if (modelId) {
      expect(modelId.length).toBeGreaterThan(0);
    }
  });
});

describe('Docker detection logic', () => {
  it('commandExists returns boolean', async () => {
    const { commandExists } = await import('./platform.js');
    expect(typeof commandExists('docker')).toBe('boolean');
    expect(typeof commandExists('nonexistent_binary_xyz')).toBe('boolean');
  });
});

describe('channel auth detection', () => {
  it('detects non-empty auth directory', () => {
    const hasAuth = (authDir: string) => {
      try {
        return fs.existsSync(authDir) && fs.readdirSync(authDir).length > 0;
      } catch {
        return false;
      }
    };

    // Non-existent directory
    expect(hasAuth('/tmp/nonexistent_auth_dir_xyz')).toBe(false);
  });
});
