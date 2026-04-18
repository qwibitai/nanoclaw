# Agentic UX Phase 4 — Live Tuning & Smoke Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add runtime-tunable config for classifier/batcher/enrichment, chat commands to view and change settings, and a production smoke test command.

**Architecture:** New `UxConfig` class wraps a `ux_config` SQLite table (key-value with defaults). A `chat-commands.ts` module parses `config list/set/reset` and `smoketest` text commands. Classifier accepts optional dynamic rules. All wired into `index.ts` `onMessage`.

**Tech Stack:** TypeScript, Vitest, SQLite (better-sqlite3), Express

---

### Task 1: UxConfig module — DB-backed config with defaults

Create the core config module that reads/writes tunable parameters from SQLite.

**Files:**
- Create: `src/ux-config.ts`
- Modify: `src/db.ts` (add table creation)
- Test: `src/__tests__/ux-config.test.ts`

- [ ] **Step 1: Add ux_config table to db.ts**

In `src/db.ts`, find the `ensureTables` function (or equivalent table-creation block) and add:

```sql
CREATE TABLE IF NOT EXISTS ux_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

- [ ] **Step 2: Write the test file**

Create `src/__tests__/ux-config.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { UxConfig } from '../ux-config.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS ux_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  return db;
}

describe('UxConfig', () => {
  let db: Database.Database;
  let config: UxConfig;

  beforeEach(() => {
    db = createTestDb();
    config = new UxConfig(db);
    config.seedDefaults();
  });

  describe('seedDefaults', () => {
    it('should seed all default keys', () => {
      const items = config.list();
      expect(items.length).toBeGreaterThanOrEqual(7);
      expect(items.find((i) => i.key === 'batcher.maxItems')?.value).toBe('5');
      expect(items.find((i) => i.key === 'batcher.maxWaitMs')?.value).toBe('10000');
      expect(items.find((i) => i.key === 'enrichment.maxBodyLength')?.value).toBe('200');
    });

    it('should not overwrite existing values on re-seed', () => {
      config.set('batcher.maxItems', '10');
      config.seedDefaults();
      expect(config.get('batcher.maxItems')).toBe('10');
    });
  });

  describe('get/set', () => {
    it('should get a default value', () => {
      expect(config.get('batcher.maxItems')).toBe('5');
    });

    it('should set and get a value', () => {
      config.set('batcher.maxItems', '15');
      expect(config.get('batcher.maxItems')).toBe('15');
    });

    it('should throw on invalid number value', () => {
      expect(() => config.set('batcher.maxItems', 'abc')).toThrow();
    });

    it('should throw on negative number', () => {
      expect(() => config.set('batcher.maxItems', '-5')).toThrow();
    });

    it('should throw on unknown key', () => {
      expect(() => config.set('unknown.key', 'value')).toThrow();
    });

    it('should validate enrichment.prompt requires {body}', () => {
      expect(() => config.set('enrichment.prompt', 'no body placeholder')).toThrow();
    });

    it('should accept valid enrichment.prompt', () => {
      config.set('enrichment.prompt', 'Improve this: {body}');
      expect(config.get('enrichment.prompt')).toBe('Improve this: {body}');
    });

    it('should validate classifier.rules as valid JSON', () => {
      expect(() => config.set('classifier.rules', 'not json')).toThrow();
    });

    it('should accept valid classifier.rules JSON', () => {
      const rules = JSON.stringify([
        { patterns: ['test'], category: 'email', urgency: 'info', batchable: false },
      ]);
      config.set('classifier.rules', rules);
      expect(config.get('classifier.rules')).toBe(rules);
    });
  });

  describe('reset', () => {
    it('should reset a value to default', () => {
      config.set('batcher.maxItems', '99');
      config.reset('batcher.maxItems');
      expect(config.get('batcher.maxItems')).toBe('5');
    });

    it('should throw on unknown key', () => {
      expect(() => config.reset('unknown.key')).toThrow();
    });
  });

  describe('list', () => {
    it('should return all keys with values and defaults', () => {
      const items = config.list();
      for (const item of items) {
        expect(item).toHaveProperty('key');
        expect(item).toHaveProperty('value');
        expect(item).toHaveProperty('defaultValue');
        expect(item).toHaveProperty('updatedAt');
      }
    });
  });

  describe('getClassifierRules', () => {
    it('should return parsed rules with RegExp patterns', () => {
      const rules = config.getClassifierRules();
      expect(Array.isArray(rules)).toBe(true);
      expect(rules.length).toBeGreaterThan(0);
      expect(rules[0].patterns[0]).toBeInstanceOf(RegExp);
    });

    it('should use cached rules within TTL', () => {
      const rules1 = config.getClassifierRules();
      config.set(
        'classifier.rules',
        JSON.stringify([
          { patterns: ['changed'], category: 'email', urgency: 'info', batchable: false },
        ]),
      );
      const rules2 = config.getClassifierRules();
      // Should still be cached (same reference)
      expect(rules2).toBe(rules1);
    });
  });

  afterEach(() => {
    db.close();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/__tests__/ux-config.test.ts`
Expected: FAIL — `UxConfig` not found

- [ ] **Step 4: Implement UxConfig**

Create `src/ux-config.ts`:

```typescript
import type Database from 'better-sqlite3';
import { logger } from './logger.js';

interface ConfigDefault {
  key: string;
  value: string;
  type: 'number' | 'string' | 'json';
  validate?: (value: string) => void;
}

interface ClassificationRule {
  patterns: RegExp[];
  category: string;
  urgency: string;
  batchable: boolean;
}

const DEFAULTS: ConfigDefault[] = [
  { key: 'batcher.maxItems', value: '5', type: 'number' },
  { key: 'batcher.maxWaitMs', value: '10000', type: 'number' },
  { key: 'enrichment.maxBodyLength', value: '200', type: 'number' },
  { key: 'enrichment.maxAgeMinutes', value: '30', type: 'number' },
  { key: 'enrichment.timeoutMs', value: '60000', type: 'number' },
  {
    key: 'enrichment.prompt',
    value: `You are improving an auto-generated email draft reply.

Subject: {subject}
Thread ID: {threadId}
Current draft body:
---
{body}
---

Instructions:
- Read the email thread for context (use the thread ID above)
- Improve tone, completeness, and professionalism
- Keep the same intent and meaning
- Match the sender's communication style
- Return ONLY the improved body text, nothing else
- If the draft is already adequate, return exactly: NO_CHANGE`,
    type: 'string',
    validate: (v) => {
      if (!v.includes('{body}')) {
        throw new Error('enrichment.prompt must contain {body} placeholder');
      }
    },
  },
  {
    key: 'classifier.rules',
    value: JSON.stringify([
      {
        patterns: [
          'incoming wire',
          'direct deposit',
          'wire transfer',
          'chase.*activity',
          'billing statement',
          'payment.*received',
          'were.*expected\\??',
          'all expected\\??',
        ],
        category: 'financial',
        urgency: 'action-required',
        batchable: false,
      },
      {
        patterns: [
          'spamhaus',
          'listed.*abuse',
          'compromis',
          'security.*alert',
          'vulnerability',
          'unauthorized.*access',
        ],
        category: 'security',
        urgency: 'urgent',
        batchable: false,
      },
      {
        patterns: [
          'AUTO[,.]?\\s*no action',
          '\\bAUTO\\b.*handled',
          'marketing email',
          'newsletter.*AUTO',
          'receipt\\s*—.*AUTO',
          'already processed',
          'promo.*AUTO',
        ],
        category: 'auto-handled',
        urgency: 'info',
        batchable: true,
      },
      {
        patterns: [
          'acknowledged.*request',
          'team is aligned',
          'no action needed(?!.*AUTO)',
          'FYI\\b',
        ],
        category: 'team',
        urgency: 'info',
        batchable: true,
      },
      {
        patterns: [
          'signup\\s*#?\\d',
          'verification.*link',
          'account.*activation',
          'proxy.*signup',
          'welcome.*email',
        ],
        category: 'account',
        urgency: 'info',
        batchable: false,
      },
      {
        patterns: ['enriched.*draft', 'SuperPilot.*draft', 'draft.*enriched'],
        category: 'email',
        urgency: 'attention',
        batchable: false,
      },
    ]),
    type: 'json',
    validate: (v) => {
      const arr = JSON.parse(v);
      if (!Array.isArray(arr)) throw new Error('classifier.rules must be an array');
      for (const rule of arr) {
        if (!Array.isArray(rule.patterns)) throw new Error('Each rule must have patterns array');
        if (!rule.category) throw new Error('Each rule must have category');
        if (!rule.urgency) throw new Error('Each rule must have urgency');
        if (typeof rule.batchable !== 'boolean') throw new Error('Each rule must have batchable boolean');
      }
    },
  },
];

export class UxConfig {
  private db: Database.Database;
  private defaultMap: Map<string, ConfigDefault>;
  private rulesCache: { rules: ClassificationRule[]; fetchedAt: number } | null = null;
  private CACHE_TTL_MS = 60_000;

  constructor(db: Database.Database) {
    this.db = db;
    this.defaultMap = new Map(DEFAULTS.map((d) => [d.key, d]));
  }

  seedDefaults(): void {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO ux_config (key, value) VALUES (?, ?)',
    );
    for (const d of DEFAULTS) {
      stmt.run(d.key, d.value);
    }
  }

  get(key: string): string {
    const row = this.db
      .prepare('SELECT value FROM ux_config WHERE key = ?')
      .get(key) as { value: string } | undefined;
    if (row) return row.value;
    const def = this.defaultMap.get(key);
    if (def) return def.value;
    throw new Error(`Unknown config key: ${key}`);
  }

  set(key: string, value: string): void {
    const def = this.defaultMap.get(key);
    if (!def) throw new Error(`Unknown config key: ${key}`);

    // Type validation
    if (def.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`${key}: must be a positive number`);
      }
    }
    if (def.type === 'json') {
      try {
        JSON.parse(value);
      } catch {
        throw new Error(`${key}: must be valid JSON`);
      }
    }

    // Custom validation
    if (def.validate) {
      def.validate(value);
    }

    this.db
      .prepare(
        `INSERT OR REPLACE INTO ux_config (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
      )
      .run(key, value);

    // Invalidate cache if classifier rules changed
    if (key === 'classifier.rules') {
      this.rulesCache = null;
    }

    logger.info({ key, value: value.length > 50 ? `${value.slice(0, 50)}...` : value }, 'UX config updated');
  }

  reset(key: string): void {
    const def = this.defaultMap.get(key);
    if (!def) throw new Error(`Unknown config key: ${key}`);

    this.db
      .prepare(
        `INSERT OR REPLACE INTO ux_config (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
      )
      .run(key, def.value);

    if (key === 'classifier.rules') {
      this.rulesCache = null;
    }
  }

  list(): Array<{ key: string; value: string; defaultValue: string; updatedAt: string }> {
    const rows = this.db
      .prepare('SELECT key, value, updated_at FROM ux_config ORDER BY key')
      .all() as Array<{ key: string; value: string; updated_at: string }>;

    return rows.map((row) => ({
      key: row.key,
      value: row.value,
      defaultValue: this.defaultMap.get(row.key)?.value ?? '',
      updatedAt: row.updated_at,
    }));
  }

  getClassifierRules(): ClassificationRule[] {
    if (
      this.rulesCache &&
      Date.now() - this.rulesCache.fetchedAt < this.CACHE_TTL_MS
    ) {
      return this.rulesCache.rules;
    }

    const raw = this.get('classifier.rules');
    const parsed = JSON.parse(raw) as Array<{
      patterns: string[];
      category: string;
      urgency: string;
      batchable: boolean;
    }>;

    const rules: ClassificationRule[] = parsed.map((r) => ({
      patterns: r.patterns.map((p) => new RegExp(p, 'i')),
      category: r.category,
      urgency: r.urgency,
      batchable: r.batchable,
    }));

    this.rulesCache = { rules, fetchedAt: Date.now() };
    return rules;
  }

  getNumber(key: string): number {
    return Number(this.get(key));
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/__tests__/ux-config.test.ts`
Expected: All PASS

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/ux-config.ts src/db.ts src/__tests__/ux-config.test.ts
git commit -m "feat(ux): add UxConfig module with DB-backed tunable parameters"
```

---

### Task 2: Chat commands module — config list/set/reset

Create the chat commands parser and formatter for `config` and `smoketest` commands.

**Files:**
- Create: `src/chat-commands.ts`
- Test: `src/__tests__/chat-commands.test.ts`

- [ ] **Step 1: Write the test file**

Create `src/__tests__/chat-commands.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { UxConfig } from '../ux-config.js';
import { parseCommand, handleConfigCommand, formatConfigList } from '../chat-commands.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/chat-commands.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement chat-commands.ts**

Create `src/chat-commands.ts`:

```typescript
import type { UxConfig } from './ux-config.js';

export interface ConfigListCommand {
  type: 'config';
  action: 'list';
}

export interface ConfigSetCommand {
  type: 'config';
  action: 'set';
  key: string;
  value: string;
}

export interface ConfigResetCommand {
  type: 'config';
  action: 'reset';
  key: string;
}

export interface SmokeTestCommand {
  type: 'smoketest';
}

export type ChatCommand =
  | ConfigListCommand
  | ConfigSetCommand
  | ConfigResetCommand
  | SmokeTestCommand;

export function parseCommand(text: string): ChatCommand | null {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  if (lower === 'smoketest') {
    return { type: 'smoketest' };
  }

  if (!lower.startsWith('config ') && lower !== 'config list') {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  const action = parts[1]?.toLowerCase();

  if (action === 'list' || (!action && lower === 'config list')) {
    return { type: 'config', action: 'list' };
  }

  if (action === 'set' && parts.length >= 4) {
    const key = parts[2];
    const value = parts.slice(3).join(' ');
    return { type: 'config', action: 'set', key, value };
  }

  if (action === 'reset' && parts.length >= 3) {
    const key = parts[2];
    return { type: 'config', action: 'reset', key };
  }

  return null;
}

export function handleConfigCommand(
  cmd: ChatCommand,
  config: UxConfig,
): string {
  if (cmd.type !== 'config') return '';

  switch (cmd.action) {
    case 'list':
      return formatConfigList(config.list());

    case 'set': {
      try {
        config.set(cmd.key, cmd.value);
        return `✅ Set ${cmd.key} = ${cmd.value.length > 50 ? `${cmd.value.slice(0, 50)}...` : cmd.value}`;
      } catch (err) {
        return `❌ Invalid value for ${cmd.key}: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    }

    case 'reset': {
      try {
        const items = config.list();
        const item = items.find((i) => i.key === cmd.key);
        config.reset(cmd.key);
        const defaultDisplay = item?.defaultValue ?? '(unknown)';
        return `✅ Reset ${cmd.key} to default (${defaultDisplay.length > 30 ? `${defaultDisplay.slice(0, 30)}...` : defaultDisplay})`;
      } catch (err) {
        return `❌ Failed to reset ${cmd.key}: ${err instanceof Error ? err.message : 'Unknown error'}`;
      }
    }
  }
}

export function formatConfigList(
  items: Array<{ key: string; value: string; defaultValue: string; updatedAt: string }>,
): string {
  const lines = items.map((item) => {
    let display: string;
    if (item.key === 'classifier.rules') {
      try {
        const arr = JSON.parse(item.value);
        display = `[${arr.length} rule${arr.length !== 1 ? 's' : ''}]`;
      } catch {
        display = '[invalid JSON]';
      }
    } else if (item.value.length > 50) {
      display = `[${item.value.length} chars]`;
    } else {
      display = item.value;
    }

    const isDefault = item.value === item.defaultValue;
    return `${item.key}: ${display}${isDefault ? ' (default)' : ' (modified)'}`;
  });

  return `⚙️ UX Configuration\n\n${lines.join('\n')}`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/__tests__/chat-commands.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/chat-commands.ts src/__tests__/chat-commands.test.ts
git commit -m "feat(ux): add chat commands module for config list/set/reset"
```

---

### Task 3: Smoke test command

Add the `smoketest` handler that checks each agentic UX component and reports results.

**Files:**
- Modify: `src/chat-commands.ts` (add `handleSmokeTest`)
- Test: `src/__tests__/chat-commands.test.ts` (extend)

- [ ] **Step 1: Add smoke test tests**

Add to `src/__tests__/chat-commands.test.ts`:

```typescript
import { handleSmokeTest } from '../chat-commands.js';
import type { SmokeTestDeps } from '../chat-commands.js';
import { classifyAndFormat } from '../router.js';

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
      miniAppPort: 0, // Skip mini app check when port is 0
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
    expect(result).toContain('Classifier'); // Should still run
  });
});
```

- [ ] **Step 2: Implement handleSmokeTest**

Add to `src/chat-commands.ts`:

```typescript
export interface SmokeTestDeps {
  classifyAndFormat: (text: string) => { text: string; meta: { category: string; actions: unknown[] } };
  gmailOpsRouter: {
    listRecentDrafts: (account: string) => Promise<unknown[]>;
    accounts: string[];
  };
  archiveTracker: {
    getUnarchived: () => unknown[];
  };
  draftWatcherRunning: boolean;
  uxConfig: {
    list: () => Array<{ key: string; value: string; defaultValue: string; updatedAt: string }>;
  };
  miniAppPort: number;
}

export async function handleSmokeTest(deps: SmokeTestDeps): Promise<string> {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];

  // 1. Classifier
  try {
    const { meta } = deps.classifyAndFormat('incoming wire transfer received');
    results.push({
      name: 'Classifier',
      ok: true,
      detail: `${meta.category}/${(meta as any).urgency ?? 'info'}`,
    });
  } catch (err) {
    results.push({
      name: 'Classifier',
      ok: false,
      detail: err instanceof Error ? err.message : 'unknown error',
    });
  }

  // 2. GmailOps
  const accountResults: string[] = [];
  let gmailOk = true;
  for (const account of deps.gmailOpsRouter.accounts) {
    try {
      await Promise.race([
        deps.gmailOpsRouter.listRecentDrafts(account),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 10_000),
        ),
      ]);
      accountResults.push(account);
    } catch (err) {
      gmailOk = false;
      results.push({
        name: `GmailOps:${account}`,
        ok: false,
        detail: err instanceof Error ? err.message : 'unknown error',
      });
    }
  }
  if (accountResults.length > 0) {
    results.push({
      name: 'GmailOps',
      ok: gmailOk,
      detail: `${accountResults.length} account(s) responding (${accountResults.join(', ')})`,
    });
  }

  // 3. Archive tracker
  try {
    const unarchived = deps.archiveTracker.getUnarchived();
    results.push({
      name: 'Archive tracker',
      ok: true,
      detail: `${unarchived.length} unarchived email(s)`,
    });
  } catch (err) {
    results.push({
      name: 'Archive tracker',
      ok: false,
      detail: err instanceof Error ? err.message : 'unknown error',
    });
  }

  // 4. Draft watcher
  results.push({
    name: 'Draft watcher',
    ok: deps.draftWatcherRunning,
    detail: deps.draftWatcherRunning ? 'running' : 'not running',
  });

  // 5. UX config
  try {
    const items = deps.uxConfig.list();
    results.push({
      name: 'UX config',
      ok: items.length > 0,
      detail: `${items.length} keys loaded`,
    });
  } catch (err) {
    results.push({
      name: 'UX config',
      ok: false,
      detail: err instanceof Error ? err.message : 'unknown error',
    });
  }

  // 6. Mini App
  if (deps.miniAppPort > 0) {
    try {
      const resp = await fetch(
        `http://localhost:${deps.miniAppPort}/task/nonexistent`,
      );
      results.push({
        name: 'Mini App',
        ok: true,
        detail: `responding on port ${deps.miniAppPort} (status ${resp.status})`,
      });
    } catch (err) {
      results.push({
        name: 'Mini App',
        ok: false,
        detail: err instanceof Error ? err.message : 'not reachable',
      });
    }
  }

  // Format output
  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  const lines = results.map(
    (r) => `${r.ok ? '✅' : '❌'} ${r.name}: ${r.detail}`,
  );

  return `🔍 Smoke Test Results\n\n${lines.join('\n')}\n\n${passed}/${total} checks passed`;
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/__tests__/chat-commands.test.ts`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/chat-commands.ts src/__tests__/chat-commands.test.ts
git commit -m "feat(ux): add smoketest command for runtime health check"
```

---

### Task 4: Update classifier to accept dynamic rules

Change `classifyMessage` to accept optional rules parameter, with the hardcoded rules as fallback.

**Files:**
- Modify: `src/message-classifier.ts`
- Modify: `src/__tests__/message-classifier.test.ts` (extend)

- [ ] **Step 1: Add test for dynamic rules**

Add to `src/__tests__/message-classifier.test.ts`:

```typescript
describe('classifyMessage with dynamic rules', () => {
  it('should use provided rules instead of defaults', () => {
    const customRules = [
      {
        patterns: [/test pattern/i],
        category: 'security' as const,
        urgency: 'urgent' as const,
        batchable: false,
      },
    ];

    const result = classifyMessage('this has test pattern in it', customRules);
    expect(result.category).toBe('security');
    expect(result.urgency).toBe('urgent');
  });

  it('should fall back to email/info for unmatched dynamic rules', () => {
    const customRules = [
      {
        patterns: [/specific_match/i],
        category: 'financial' as const,
        urgency: 'action-required' as const,
        batchable: false,
      },
    ];

    const result = classifyMessage('no match here', customRules);
    expect(result.category).toBe('email');
    expect(result.urgency).toBe('info');
  });
});
```

- [ ] **Step 2: Update classifyMessage signature**

In `src/message-classifier.ts`, change:

```typescript
// Before:
export function classifyMessage(text: string): MessageMeta {
  for (const rule of RULES) {

// After:
export function classifyMessage(
  text: string,
  dynamicRules?: ClassificationRule[],
): MessageMeta {
  const rules = dynamicRules ?? RULES;
  for (const rule of rules) {
```

Also export the `ClassificationRule` interface so `UxConfig` can reference it:

```typescript
export interface ClassificationRule {
  patterns: RegExp[];
  category: MessageCategory;
  urgency: MessageUrgency;
  batchable: boolean;
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/__tests__/message-classifier.test.ts`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
git add src/message-classifier.ts src/__tests__/message-classifier.test.ts
git commit -m "feat(ux): accept dynamic rules parameter in classifyMessage"
```

---

### Task 5: Wire everything into index.ts

Connect UxConfig, chat commands, dynamic classifier rules, and configurable enrichment prompt into the main application.

**Files:**
- Modify: `src/index.ts` (initialization + onMessage intercepts)
- Modify: `src/router.ts` (pass uxConfig to classifyAndFormat)

- [ ] **Step 1: Add ux_config table creation to db.ts**

In `src/db.ts`, add to the table creation section:

```typescript
db.exec(`CREATE TABLE IF NOT EXISTS ux_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
```

- [ ] **Step 2: Initialize UxConfig in index.ts main()**

Add after DB initialization:

```typescript
import { UxConfig } from './ux-config.js';
import { parseCommand, handleConfigCommand, handleSmokeTest } from './chat-commands.js';

// In main(), after getDb():
const uxConfig = new UxConfig(getDb());
uxConfig.seedDefaults();
```

- [ ] **Step 3: Add command intercepts in onMessage**

In `index.ts`, in the `onMessage` callback (where "archive all" is intercepted), add before the archive all check:

```typescript
// Chat commands: config, smoketest
const cmd = parseCommand(message.content);
if (cmd) {
  (async () => {
    try {
      let reply: string;
      if (cmd.type === 'config') {
        reply = handleConfigCommand(cmd, uxConfig);
      } else {
        reply = await handleSmokeTest({
          classifyAndFormat,
          gmailOpsRouter: {
            listRecentDrafts: (account) => gmailOpsRouter.listRecentDrafts(account),
            accounts: enrichmentAccounts,
          },
          archiveTracker: {
            getUnarchived: () => archiveTracker.getUnarchived(),
          },
          draftWatcherRunning: draftWatcher !== null,
          uxConfig: {
            list: () => uxConfig.list(),
          },
          miniAppPort: MINI_APP_PORT,
        });
      }
      const channel = findChannel(channels, message.chat_jid);
      if (channel) {
        await channel.sendMessage(message.chat_jid, reply);
      }
    } catch (err) {
      logger.error({ err }, 'Chat command failed');
    }
  })();
  return;
}
```

- [ ] **Step 4: Use configurable enrichment prompt**

In the `evaluateEnrichment` callback in `index.ts`, replace the hardcoded prompt string:

```typescript
// Before:
const enrichPrompt = `## Draft Enrichment Task\n\nYou are improving...`;

// After:
const promptTemplate = uxConfig.get('enrichment.prompt');
const enrichPrompt = `## Draft Enrichment Task\n\n${promptTemplate
  .replace('{subject}', draft.subject)
  .replace('{threadId}', draft.threadId)
  .replace('{body}', draft.body)
  .replace('{account}', draft.account ?? '')
  .replace('{draftId}', draft.draftId)}`;
```

Also update the enrichment guards to use configurable values:

```typescript
// Before:
if (draft.body.length > 200) return null;
const ageMs = Date.now() - new Date(draft.createdAt).getTime();
if (ageMs > 30 * 60 * 1000) return null;

// After:
if (draft.body.length > uxConfig.getNumber('enrichment.maxBodyLength')) return null;
const ageMs = Date.now() - new Date(draft.createdAt).getTime();
if (ageMs > uxConfig.getNumber('enrichment.maxAgeMinutes') * 60 * 1000) return null;
```

And the timeout:

```typescript
// Before:
const ENRICHMENT_TIMEOUT_MS = 60_000;

// After:
const ENRICHMENT_TIMEOUT_MS = uxConfig.getNumber('enrichment.timeoutMs');
```

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run`
Expected: All passing (minus pre-existing mcp-bridge failures)

- [ ] **Step 7: Commit**

```bash
git add src/index.ts src/db.ts src/router.ts
git commit -m "feat(ux): wire UxConfig, chat commands, and configurable enrichment into startup"
```

---

### Task 6: Integration test

End-to-end test verifying the full config + smoketest flow.

**Files:**
- Test: `src/__tests__/ux-tuning-integration.test.ts` (create)

- [ ] **Step 1: Write integration test**

Create `src/__tests__/ux-tuning-integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
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
    // Add a custom rule
    const newRules = JSON.stringify([
      { patterns: ['custom trigger'], category: 'security', urgency: 'urgent', batchable: false },
    ]);
    const setResult = handleConfigCommand(
      { type: 'config', action: 'set', key: 'classifier.rules', value: newRules },
      config,
    );
    expect(setResult).toContain('✅');

    // Use the dynamic rules
    const rules = config.getClassifierRules();
    const meta = classifyMessage('this is a custom trigger message', rules);
    expect(meta.category).toBe('security');
    expect(meta.urgency).toBe('urgent');
  });

  it('should reset and restore default rules', () => {
    // Modify rules
    config.set(
      'classifier.rules',
      JSON.stringify([
        { patterns: ['only match'], category: 'team', urgency: 'info', batchable: true },
      ]),
    );

    // Reset
    const resetResult = handleConfigCommand(
      { type: 'config', action: 'reset', key: 'classifier.rules' },
      config,
    );
    expect(resetResult).toContain('✅');

    // Verify default rules work
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

  afterEach(() => {
    db.close();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/__tests__/ux-tuning-integration.test.ts`
Expected: All PASS

- [ ] **Step 3: Run full suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: All passing

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/ux-tuning-integration.test.ts
git commit -m "test(ux): add integration tests for UX tuning and smoke test"
```
