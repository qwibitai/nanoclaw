import type Database from 'better-sqlite3';
import { logger } from './logger.js';

interface ConfigDefault {
  key: string;
  value: string;
  type: 'number' | 'string' | 'json';
  validate?: (value: string) => void;
}

export interface ClassificationRuleDef {
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
      if (!Array.isArray(arr))
        throw new Error('classifier.rules must be an array');
      for (const rule of arr) {
        if (!Array.isArray(rule.patterns))
          throw new Error('Each rule must have patterns array');
        if (!rule.category) throw new Error('Each rule must have category');
        if (!rule.urgency) throw new Error('Each rule must have urgency');
        if (typeof rule.batchable !== 'boolean')
          throw new Error('Each rule must have batchable boolean');
      }
    },
  },
];

export class UxConfig {
  private db: Database.Database;
  private defaultMap: Map<string, ConfigDefault>;
  private rulesCache: {
    rules: ClassificationRuleDef[];
    fetchedAt: number;
  } | null = null;
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

    if (def.validate) {
      def.validate(value);
    }

    this.db
      .prepare(
        `INSERT OR REPLACE INTO ux_config (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
      )
      .run(key, value);

    if (key === 'classifier.rules') {
      this.rulesCache = null;
    }

    logger.info(
      { key, value: value.length > 50 ? `${value.slice(0, 50)}...` : value },
      'UX config updated',
    );
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

  list(): Array<{
    key: string;
    value: string;
    defaultValue: string;
    updatedAt: string;
  }> {
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

  getClassifierRules(): ClassificationRuleDef[] {
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

    const rules: ClassificationRuleDef[] = parsed.map((r) => ({
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
