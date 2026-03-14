import { describe, it, expect } from 'vitest';
import { TierManager } from './tier-manager.js';
import type { TierEvaluationInput } from './tier-manager.js';

const DAY_MS = 86_400_000;

function makeInput(overrides: Partial<TierEvaluationInput> = {}): TierEvaluationInput {
  return {
    id: 'test-1',
    currentTier: 'working',
    accessCount: 0,
    compositeScore: 0.5,
    importance: 0.7,
    ageMs: 1 * DAY_MS,
    ...overrides,
  };
}

describe('TierManager', () => {
  const tm = new TierManager();

  // ── Promotion: peripheral → working ─────────────────────────────────

  describe('peripheral → working promotion', () => {
    it('promotes when access≥3 and composite≥0.4', () => {
      const t = tm.evaluate(makeInput({
        currentTier: 'peripheral',
        accessCount: 3,
        compositeScore: 0.4,
      }));
      expect(t).not.toBeNull();
      expect(t!.from).toBe('peripheral');
      expect(t!.to).toBe('working');
    });

    it('does not promote with only 2 accesses', () => {
      const t = tm.evaluate(makeInput({
        currentTier: 'peripheral',
        accessCount: 2,
        compositeScore: 0.5,
      }));
      expect(t).toBeNull();
    });

    it('does not promote with low composite score', () => {
      const t = tm.evaluate(makeInput({
        currentTier: 'peripheral',
        accessCount: 5,
        compositeScore: 0.3,
      }));
      expect(t).toBeNull();
    });
  });

  // ── Promotion: working → core ───────────────────────────────────────

  describe('working → core promotion', () => {
    it('promotes when access≥10, composite≥0.7, importance≥0.8', () => {
      const t = tm.evaluate(makeInput({
        currentTier: 'working',
        accessCount: 10,
        compositeScore: 0.7,
        importance: 0.8,
      }));
      expect(t).not.toBeNull();
      expect(t!.from).toBe('working');
      expect(t!.to).toBe('core');
    });

    it('does not promote with 9 accesses (just below threshold)', () => {
      const t = tm.evaluate(makeInput({
        currentTier: 'working',
        accessCount: 9,
        compositeScore: 0.8,
        importance: 0.9,
      }));
      expect(t).toBeNull();
    });

    it('does not promote with composite 0.69 (just below threshold)', () => {
      const t = tm.evaluate(makeInput({
        currentTier: 'working',
        accessCount: 15,
        compositeScore: 0.69,
        importance: 0.9,
      }));
      expect(t).toBeNull();
    });

    it('does not promote with importance 0.79 (just below threshold)', () => {
      const t = tm.evaluate(makeInput({
        currentTier: 'working',
        accessCount: 15,
        compositeScore: 0.8,
        importance: 0.79,
      }));
      expect(t).toBeNull();
    });

    it('requires ALL three conditions simultaneously', () => {
      // High access + high composite but low importance
      expect(tm.evaluate(makeInput({
        currentTier: 'working',
        accessCount: 50,
        compositeScore: 0.95,
        importance: 0.5,
      }))).toBeNull();

      // High access + high importance but low composite
      expect(tm.evaluate(makeInput({
        currentTier: 'working',
        accessCount: 50,
        compositeScore: 0.3,
        importance: 0.95,
      }))).toBeNull();

      // High composite + high importance but low access
      expect(tm.evaluate(makeInput({
        currentTier: 'working',
        accessCount: 2,
        compositeScore: 0.95,
        importance: 0.95,
      }))).toBeNull();
    });
  });

  // ── Core stays core ─────────────────────────────────────────────────

  describe('core tier stability', () => {
    it('core memory with healthy stats stays core', () => {
      const t = tm.evaluate(makeInput({
        currentTier: 'core',
        accessCount: 20,
        compositeScore: 0.9,
        importance: 0.95,
        ageMs: 60 * DAY_MS,
      }));
      expect(t).toBeNull();
    });

    it('core not demoted even after 89 days (just below 90-day threshold)', () => {
      const t = tm.evaluate(makeInput({
        currentTier: 'core',
        accessCount: 1,
        compositeScore: 0.1,
        ageMs: 89 * DAY_MS,
      }));
      expect(t).toBeNull();
    });
  });

  // ── Demotion: core → working ────────────────────────────────────────

  describe('core → working demotion', () => {
    it('demotes after 90+ days with low access and low score', () => {
      const t = tm.evaluate(makeInput({
        currentTier: 'core',
        accessCount: 1,
        compositeScore: 0.2,
        ageMs: 91 * DAY_MS,
      }));
      expect(t).not.toBeNull();
      expect(t!.from).toBe('core');
      expect(t!.to).toBe('working');
    });

    it('does not demote core with 3+ accesses even after 90 days', () => {
      const t = tm.evaluate(makeInput({
        currentTier: 'core',
        accessCount: 3,
        compositeScore: 0.2,
        ageMs: 100 * DAY_MS,
      }));
      expect(t).toBeNull();
    });
  });

  // ── Demotion: working → peripheral ──────────────────────────────────

  describe('working → peripheral demotion', () => {
    it('demotes after 30+ days with ≤1 access and low score', () => {
      const t = tm.evaluate(makeInput({
        currentTier: 'working',
        accessCount: 1,
        compositeScore: 0.15,
        ageMs: 31 * DAY_MS,
      }));
      expect(t).not.toBeNull();
      expect(t!.from).toBe('working');
      expect(t!.to).toBe('peripheral');
    });

    it('does not demote working before 30 days', () => {
      const t = tm.evaluate(makeInput({
        currentTier: 'working',
        accessCount: 0,
        compositeScore: 0.1,
        ageMs: 29 * DAY_MS,
      }));
      expect(t).toBeNull();
    });
  });

  // ── Full lifecycle simulation ───────────────────────────────────────

  describe('full lifecycle: peripheral → working → core', () => {
    it('simulates gradual promotion through usage', () => {
      const id = 'lifecycle-test';

      // Day 1: new memory starts as peripheral, low usage — no promotion
      let tier: 'peripheral' | 'working' | 'core' = 'peripheral';
      let t = tm.evaluate({ id, currentTier: tier, accessCount: 1, compositeScore: 0.3, importance: 0.7, ageMs: DAY_MS });
      expect(t).toBeNull();
      expect(tier).toBe('peripheral');

      // After some usage: 3 accesses, decent score — promotes to working
      t = tm.evaluate({ id, currentTier: tier, accessCount: 3, compositeScore: 0.5, importance: 0.7, ageMs: 5 * DAY_MS });
      expect(t).not.toBeNull();
      expect(t!.to).toBe('working');
      tier = 'working';

      // More usage but not enough for core: 8 accesses
      t = tm.evaluate({ id, currentTier: tier, accessCount: 8, compositeScore: 0.6, importance: 0.8, ageMs: 10 * DAY_MS });
      expect(t).toBeNull();
      expect(tier).toBe('working');

      // Heavy usage: 10+ accesses, high scores — promotes to core
      t = tm.evaluate({ id, currentTier: tier, accessCount: 12, compositeScore: 0.75, importance: 0.85, ageMs: 20 * DAY_MS });
      expect(t).not.toBeNull();
      expect(t!.to).toBe('core');
      tier = 'core';

      // Core memory stays core with continued usage
      t = tm.evaluate({ id, currentTier: tier, accessCount: 20, compositeScore: 0.8, importance: 0.9, ageMs: 60 * DAY_MS });
      expect(t).toBeNull();
      expect(tier).toBe('core');
    });
  });

  // ── Batch evaluation ────────────────────────────────────────────────

  describe('evaluateBatch', () => {
    it('returns only entries with transitions', () => {
      const transitions = tm.evaluateBatch([
        makeInput({ id: 'a', currentTier: 'peripheral', accessCount: 5, compositeScore: 0.5 }),  // promotes
        makeInput({ id: 'b', currentTier: 'working', accessCount: 1, compositeScore: 0.5 }),     // stays
        makeInput({ id: 'c', currentTier: 'working', accessCount: 0, compositeScore: 0.1, ageMs: 35 * DAY_MS }), // demotes
      ]);
      expect(transitions).toHaveLength(2);
      expect(transitions.map(t => t.id)).toEqual(['a', 'c']);
      expect(transitions[0].to).toBe('working');
      expect(transitions[1].to).toBe('peripheral');
    });
  });
});
