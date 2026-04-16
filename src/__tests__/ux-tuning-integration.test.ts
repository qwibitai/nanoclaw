import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { UxConfig } from '../ux-config.js';
import { parseCommand, handleConfigCommand, handleSmokeTest } from '../chat-commands.js';
import { classifyMessage } from '../message-classifier.js';
import { classifyAndFormat } from '../router.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS ux_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  return db;
}

describe('UX tuning integration', () => {
  let db: Database.Database;
  let config: UxConfig;

  beforeEach(() => {
    db = createTestDb();
    config = new UxConfig(db);
    config.seedDefaults();
  });

  it('should update classifier rules via config set and use them', () => {
    const newRules = JSON.stringify([
      { patterns: ['custom trigger'], category: 'security', urgency: 'urgent', batchable: false },
    ]);
    const setResult = handleConfigCommand(
      { type: 'config', action: 'set', key: 'classifier.rules', value: newRules },
      config,
    );
    expect(setResult).toContain('✅');

    const rules = config.getClassifierRules();
    const meta = classifyMessage('this is a custom trigger message', rules);
    expect(meta.category).toBe('security');
    expect(meta.urgency).toBe('urgent');
  });

  it('should reset and restore default rules', () => {
    config.set(
      'classifier.rules',
      JSON.stringify([
        { patterns: ['only match'], category: 'team', urgency: 'info', batchable: true },
      ]),
    );

    const resetResult = handleConfigCommand(
      { type: 'config', action: 'reset', key: 'classifier.rules' },
      config,
    );
    expect(resetResult).toContain('✅');

    const rules = config.getClassifierRules();
    const meta = classifyMessage('incoming wire transfer', rules);
    expect(meta.category).toBe('financial');
  });

  it('full flow: parse command → handle → verify', () => {
    const cmd = parseCommand('config set batcher.maxItems 20');
    expect(cmd).not.toBeNull();

    const result = handleConfigCommand(cmd!, config);
    expect(result).toContain('✅');
    expect(config.getNumber('batcher.maxItems')).toBe(20);
  });

  it('smoketest should complete without errors', async () => {
    const result = await handleSmokeTest({
      classifyAndFormat,
      gmailOpsRouter: { listRecentDrafts: async () => [], accounts: [] },
      archiveTracker: { getUnarchived: () => [] },
      draftWatcherRunning: false,
      uxConfig: { list: () => config.list() },
      miniAppPort: 0,
    });

    expect(result).toContain('🔍 Smoke Test Results');
    expect(result).toContain('Classifier');
    expect(result).toContain('checks passed');
  });

  it('should reject invalid config values in full flow', () => {
    const cmd = parseCommand('config set batcher.maxItems not-a-number');
    expect(cmd).not.toBeNull();
    const result = handleConfigCommand(cmd!, config);
    expect(result).toContain('❌');
    // Value should remain unchanged
    expect(config.getNumber('batcher.maxItems')).toBe(5);
  });

  it('config list should show all keys after modifications', () => {
    config.set('batcher.maxItems', '42');
    const cmd = parseCommand('config list');
    expect(cmd).not.toBeNull();
    const result = handleConfigCommand(cmd!, config);
    expect(result).toContain('batcher.maxItems: 42 (modified)');
  });

  afterEach(() => {
    db.close();
  });
});
