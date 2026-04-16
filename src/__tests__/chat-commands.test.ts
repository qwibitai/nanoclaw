import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { UxConfig } from '../ux-config.js';
import {
  parseCommand,
  handleConfigCommand,
  formatConfigList,
  handleSmokeTest,
} from '../chat-commands.js';
import type { SmokeTestDeps } from '../chat-commands.js';
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

describe('parseCommand', () => {
  it('should parse "config list"', () => {
    expect(parseCommand('config list')).toEqual({ type: 'config', action: 'list' });
  });

  it('should parse "Config List" case-insensitively', () => {
    expect(parseCommand('Config List')).toEqual({ type: 'config', action: 'list' });
  });

  it('should parse "config set key value"', () => {
    expect(parseCommand('config set batcher.maxItems 10')).toEqual({
      type: 'config',
      action: 'set',
      key: 'batcher.maxItems',
      value: '10',
    });
  });

  it('should parse "config set" with multi-word value', () => {
    expect(parseCommand('config set enrichment.prompt Hello {body} world')).toEqual({
      type: 'config',
      action: 'set',
      key: 'enrichment.prompt',
      value: 'Hello {body} world',
    });
  });

  it('should parse "config reset key"', () => {
    expect(parseCommand('config reset batcher.maxItems')).toEqual({
      type: 'config',
      action: 'reset',
      key: 'batcher.maxItems',
    });
  });

  it('should parse "smoketest"', () => {
    expect(parseCommand('smoketest')).toEqual({ type: 'smoketest' });
  });

  it('should return null for non-commands', () => {
    expect(parseCommand('hello world')).toBeNull();
    expect(parseCommand('configure something')).toBeNull();
  });
});

describe('handleConfigCommand', () => {
  let db: Database.Database;
  let config: UxConfig;

  beforeEach(() => {
    db = createTestDb();
    config = new UxConfig(db);
    config.seedDefaults();
  });

  it('should handle config list', () => {
    const result = handleConfigCommand({ type: 'config', action: 'list' }, config);
    expect(result).toContain('⚙️ UX Configuration');
    expect(result).toContain('batcher.maxItems');
  });

  it('should handle config set success', () => {
    const result = handleConfigCommand(
      { type: 'config', action: 'set', key: 'batcher.maxItems', value: '10' },
      config,
    );
    expect(result).toContain('✅');
    expect(result).toContain('10');
    expect(config.get('batcher.maxItems')).toBe('10');
  });

  it('should handle config set failure', () => {
    const result = handleConfigCommand(
      { type: 'config', action: 'set', key: 'batcher.maxItems', value: 'abc' },
      config,
    );
    expect(result).toContain('❌');
  });

  it('should handle config reset', () => {
    config.set('batcher.maxItems', '99');
    const result = handleConfigCommand(
      { type: 'config', action: 'reset', key: 'batcher.maxItems' },
      config,
    );
    expect(result).toContain('✅');
    expect(config.get('batcher.maxItems')).toBe('5');
  });

  it('should handle unknown key', () => {
    const result = handleConfigCommand(
      { type: 'config', action: 'set', key: 'unknown', value: '1' },
      config,
    );
    expect(result).toContain('❌');
  });

  afterEach(() => {
    db.close();
  });
});

describe('formatConfigList', () => {
  it('should show truncated values for long strings', () => {
    const items = [
      { key: 'enrichment.prompt', value: 'x'.repeat(200), defaultValue: 'x'.repeat(200), updatedAt: '2026-01-01' },
    ];
    const output = formatConfigList(items);
    expect(output).toContain('[200 chars]');
  });

  it('should show rule count for classifier.rules', () => {
    const rules = JSON.stringify([{ patterns: ['a'], category: 'email', urgency: 'info', batchable: false }]);
    const items = [
      { key: 'classifier.rules', value: rules, defaultValue: rules, updatedAt: '2026-01-01' },
    ];
    const output = formatConfigList(items);
    expect(output).toContain('[1 rule');
  });
});

describe('handleSmokeTest', () => {
  it('should run all checks and report results', async () => {
    const deps: SmokeTestDeps = {
      classifyAndFormat,
      gmailOpsRouter: {
        listRecentDrafts: async () => [],
        accounts: ['personal'],
      },
      archiveTracker: {
        getUnarchived: () => [],
      },
      draftWatcherRunning: true,
      uxConfig: {
        list: () => [
          { key: 'test', value: '1', defaultValue: '1', updatedAt: '' },
        ],
      },
      miniAppPort: 0,
    };

    const result = await handleSmokeTest(deps);
    expect(result).toContain('🔍 Smoke Test Results');
    expect(result).toContain('Classifier');
    expect(result).toContain('checks passed');
  });

  it('should report failed checks without stopping', async () => {
    const deps: SmokeTestDeps = {
      classifyAndFormat,
      gmailOpsRouter: {
        listRecentDrafts: async () => {
          throw new Error('TOKEN_EXPIRED');
        },
        accounts: ['personal'],
      },
      archiveTracker: {
        getUnarchived: () => [],
      },
      draftWatcherRunning: false,
      uxConfig: {
        list: () => [],
      },
      miniAppPort: 0,
    };

    const result = await handleSmokeTest(deps);
    expect(result).toContain('❌');
    expect(result).toContain('Classifier');
  });
});
