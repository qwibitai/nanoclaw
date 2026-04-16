import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
      expect(items.find((i) => i.key === 'batcher.maxWaitMs')?.value).toBe(
        '10000',
      );
      expect(
        items.find((i) => i.key === 'enrichment.maxBodyLength')?.value,
      ).toBe('200');
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
      expect(() =>
        config.set('enrichment.prompt', 'no body placeholder'),
      ).toThrow();
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
        {
          patterns: ['test'],
          category: 'email',
          urgency: 'info',
          batchable: false,
        },
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
          {
            patterns: ['changed'],
            category: 'email',
            urgency: 'info',
            batchable: false,
          },
        ]),
      );
      // Cache was invalidated by set(), so rules2 should be different
      const rules2 = config.getClassifierRules();
      expect(rules2).not.toBe(rules1);
      // But calling again without set() should return cached
      const rules3 = config.getClassifierRules();
      expect(rules3).toBe(rules2);
    });
  });

  describe('getNumber', () => {
    it('should return numeric value', () => {
      expect(config.getNumber('batcher.maxItems')).toBe(5);
    });
  });

  afterEach(() => {
    db.close();
  });
});
