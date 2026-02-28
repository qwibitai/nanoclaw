import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import fs from 'node:fs';
import {
  evaluateCondition,
  defaultRules,
  routeAfterConversation,
  loadRoutingConfig,
  RoutingConfigSchema,
  type RoutingCondition,
  type RoutingContext,
  type RoutingConfig,
} from './workflow-router.js';
import { detectFrustration } from './hindsight.js';
import { observeConversation } from './observer.js';
import { reflectOnMemory } from './reflector.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('./observer.js', () => ({
  observeConversation: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./quality-tracker.js', () => ({
  trackConversationQuality: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./auto-learner.js', () => ({
  processLearning: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./hindsight.js', () => ({
  processHindsight: vi.fn().mockResolvedValue(undefined),
  detectFrustration: vi
    .fn()
    .mockReturnValue({ detected: false, signals: [], correctionCount: 0 }),
}));
vi.mock('./reflector.js', () => ({
  reflectOnMemory: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi
    .fn()
    .mockImplementation((f: string) => `/tmp/test-groups/${f}`),
}));
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('node:fs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides?: Partial<RoutingContext>): RoutingContext {
  return {
    groupFolder: 'main',
    userMessages: [
      {
        sender_name: 'user',
        content: 'Hello there',
        timestamp: new Date().toISOString(),
      },
    ],
    botResponses: ['Hi! How can I help?'],
    ...overrides,
  };
}

function manyMessages(count: number): RoutingContext['userMessages'] {
  return Array.from({ length: count }, (_, i) => ({
    sender_name: 'user',
    content: `Message ${i + 1}`,
    timestamp: new Date().toISOString(),
  }));
}

function correctionMessages(): RoutingContext['userMessages'] {
  return [
    {
      sender_name: 'user',
      content: "No, it's 3pm not 2pm",
      timestamp: new Date().toISOString(),
    },
    {
      sender_name: 'user',
      content: 'Actually, the blue one',
      timestamp: new Date().toISOString(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('workflow-router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (detectFrustration as Mock).mockReturnValue({
      detected: false,
      signals: [],
      correctionCount: 0,
    });
    (fs.existsSync as Mock).mockReturnValue(false);
    (fs.readFileSync as Mock).mockReturnValue('');
  });

  // -------------------------------------------------------------------------
  // evaluateCondition
  // -------------------------------------------------------------------------
  describe('evaluateCondition', () => {
    it('always matches', () => {
      const result = evaluateCondition({ type: 'always' }, makeContext());
      expect(result.matched).toBe(true);
      expect(result.reason).toBe('always');
    });

    it('minMessages matches when enough messages', () => {
      const ctx = makeContext({ userMessages: manyMessages(5) });
      const result = evaluateCondition({ type: 'minMessages', min: 5 }, ctx);
      expect(result.matched).toBe(true);
    });

    it('minMessages fails when too few messages', () => {
      const ctx = makeContext({ userMessages: manyMessages(3) });
      const result = evaluateCondition({ type: 'minMessages', min: 5 }, ctx);
      expect(result.matched).toBe(false);
    });

    it('correctionDetected matches on correction patterns', () => {
      const ctx = makeContext({ userMessages: correctionMessages() });
      const result = evaluateCondition({ type: 'correctionDetected' }, ctx);
      expect(result.matched).toBe(true);
    });

    it('correctionDetected fails on normal messages', () => {
      const ctx = makeContext();
      const result = evaluateCondition({ type: 'correctionDetected' }, ctx);
      expect(result.matched).toBe(false);
    });

    it('frustrationDetected uses provided frustration result', () => {
      const ctx = makeContext();
      const result = evaluateCondition({ type: 'frustrationDetected' }, ctx, {
        detected: true,
      });
      expect(result.matched).toBe(true);
    });

    it('frustrationDetected defaults to false without result', () => {
      const ctx = makeContext();
      const result = evaluateCondition({ type: 'frustrationDetected' }, ctx);
      expect(result.matched).toBe(false);
    });

    it('all requires every sub-condition', () => {
      const ctx = makeContext({ userMessages: manyMessages(5) });
      const condition: RoutingCondition = {
        type: 'all',
        conditions: [{ type: 'always' }, { type: 'minMessages', min: 5 }],
      };
      expect(evaluateCondition(condition, ctx).matched).toBe(true);
    });

    it('all fails if any sub-condition fails', () => {
      const ctx = makeContext({ userMessages: manyMessages(3) });
      const condition: RoutingCondition = {
        type: 'all',
        conditions: [{ type: 'always' }, { type: 'minMessages', min: 5 }],
      };
      expect(evaluateCondition(condition, ctx).matched).toBe(false);
    });

    it('any matches if any sub-condition matches', () => {
      const ctx = makeContext({ userMessages: manyMessages(3) });
      const condition: RoutingCondition = {
        type: 'any',
        conditions: [{ type: 'minMessages', min: 10 }, { type: 'always' }],
      };
      expect(evaluateCondition(condition, ctx).matched).toBe(true);
    });

    it('any fails if no sub-condition matches', () => {
      const ctx = makeContext();
      const condition: RoutingCondition = {
        type: 'any',
        conditions: [
          { type: 'minMessages', min: 10 },
          { type: 'correctionDetected' },
        ],
      };
      expect(evaluateCondition(condition, ctx).matched).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // defaultRules
  // -------------------------------------------------------------------------
  describe('defaultRules', () => {
    it('returns 4 rules', () => {
      const rules = defaultRules(5);
      expect(rules).toHaveLength(4);
    });

    it('includes observer, qualityTracker, autoLearner, hindsight', () => {
      const rules = defaultRules(5);
      const actionTypes = rules.map((r) => r.action.type);
      expect(actionTypes).toContain('observer');
      expect(actionTypes).toContain('qualityTracker');
      expect(actionTypes).toContain('autoLearner');
      expect(actionTypes).toContain('hindsight');
    });

    it('uses provided minObserverMessages for observer rule', () => {
      const rules = defaultRules(10);
      const observer = rules.find((r) => r.id === 'observer')!;
      expect(observer.condition).toEqual({ type: 'minMessages', min: 10 });
    });

    it('all rules are enabled by default', () => {
      const rules = defaultRules(5);
      expect(rules.every((r) => r.enabled)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // RoutingConfigSchema validation
  // -------------------------------------------------------------------------
  describe('RoutingConfigSchema', () => {
    it('validates a correct config', () => {
      const config = {
        rules: [
          {
            id: 'test',
            name: 'Test rule',
            enabled: true,
            condition: { type: 'always' },
            action: { type: 'observer' },
          },
        ],
      };
      expect(RoutingConfigSchema.safeParse(config).success).toBe(true);
    });

    it('rejects empty rules array', () => {
      const config = { rules: [] };
      expect(RoutingConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects unknown condition type', () => {
      const config = {
        rules: [
          {
            id: 'test',
            name: 'Test',
            enabled: true,
            condition: { type: 'unknown' },
            action: { type: 'observer' },
          },
        ],
      };
      expect(RoutingConfigSchema.safeParse(config).success).toBe(false);
    });

    it('rejects unknown action type', () => {
      const config = {
        rules: [
          {
            id: 'test',
            name: 'Test',
            enabled: true,
            condition: { type: 'always' },
            action: { type: 'unknown' },
          },
        ],
      };
      expect(RoutingConfigSchema.safeParse(config).success).toBe(false);
    });

    it('validates nested all/any conditions', () => {
      const config = {
        rules: [
          {
            id: 'test',
            name: 'Test',
            enabled: true,
            condition: {
              type: 'all',
              conditions: [
                { type: 'minMessages', min: 3 },
                {
                  type: 'any',
                  conditions: [
                    { type: 'correctionDetected' },
                    { type: 'always' },
                  ],
                },
              ],
            },
            action: { type: 'autoLearner' },
          },
        ],
      };
      expect(RoutingConfigSchema.safeParse(config).success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // routeAfterConversation — integration
  // -------------------------------------------------------------------------
  describe('routeAfterConversation', () => {
    it('triggers matching actions and returns traces', async () => {
      const ctx = makeContext({ userMessages: manyMessages(5) });
      const config: RoutingConfig = {
        rules: defaultRules(5),
      };

      const result = await routeAfterConversation(ctx, config);

      // Observer: 5 messages >= 5 min → matched
      // Quality tracker: always → matched
      // Auto-learner: no corrections → not matched
      // Hindsight: no frustration → not matched
      expect(result.actionsTriggered).toContain('observer');
      expect(result.actionsTriggered).toContain('qualityTracker');
      expect(result.actionsTriggered).not.toContain('autoLearner');
      expect(result.actionsTriggered).not.toContain('hindsight');
      expect(result.traces).toHaveLength(4);
    });

    it('skips disabled rules', async () => {
      const ctx = makeContext({ userMessages: manyMessages(5) });
      const rules = defaultRules(5);
      rules[0].enabled = false; // disable observer
      const config: RoutingConfig = { rules };

      const result = await routeAfterConversation(ctx, config);

      expect(result.actionsTriggered).not.toContain('observer');
      const observerTrace = result.traces.find((t) => t.ruleId === 'observer');
      expect(observerTrace?.reason).toBe('disabled');
    });

    it('triggers autoLearner on correction messages', async () => {
      const ctx = makeContext({ userMessages: correctionMessages() });
      const config: RoutingConfig = {
        rules: [
          {
            id: 'auto-learner',
            name: 'Auto-Learner',
            enabled: true,
            condition: { type: 'correctionDetected' },
            action: { type: 'autoLearner' },
          },
        ],
      };

      const result = await routeAfterConversation(ctx, config);
      expect(result.actionsTriggered).toContain('autoLearner');
    });

    it('triggers hindsight when frustration detected', async () => {
      (detectFrustration as Mock).mockReturnValue({
        detected: true,
        signals: ['frustration: "test"', 'abandonment: "test"'],
        correctionCount: 0,
      });

      const ctx = makeContext();
      const config: RoutingConfig = {
        rules: [
          {
            id: 'hindsight',
            name: 'Hindsight',
            enabled: true,
            condition: { type: 'frustrationDetected' },
            action: { type: 'hindsight' },
          },
        ],
      };

      const result = await routeAfterConversation(ctx, config);
      expect(result.actionsTriggered).toContain('hindsight');
    });

    it('handles action execution failure gracefully', async () => {
      (observeConversation as Mock).mockRejectedValueOnce(new Error('boom'));

      const ctx = makeContext({ userMessages: manyMessages(5) });
      const config: RoutingConfig = {
        rules: [
          {
            id: 'observer',
            name: 'Observer',
            enabled: true,
            condition: { type: 'minMessages', min: 5 },
            action: { type: 'observer' },
          },
        ],
      };

      // Should not throw
      const result = await routeAfterConversation(ctx, config);
      expect(result.actionsTriggered).toContain('observer');

      // Wait for fire-and-forget to settle
      await new Promise((r) => setTimeout(r, 50));
    });

    it('evaluates all rules even if some fail', async () => {
      const ctx = makeContext({ userMessages: manyMessages(10) });
      const config: RoutingConfig = {
        rules: [
          {
            id: 'r1',
            name: 'Rule 1',
            enabled: true,
            condition: { type: 'minMessages', min: 5 },
            action: { type: 'observer' },
          },
          {
            id: 'r2',
            name: 'Rule 2',
            enabled: true,
            condition: { type: 'always' },
            action: { type: 'qualityTracker' },
          },
        ],
      };

      const result = await routeAfterConversation(ctx, config);
      expect(result.traces).toHaveLength(2);
      expect(result.actionsTriggered).toHaveLength(2);
    });

    it('returns empty results for no rules matching', async () => {
      const ctx = makeContext();
      const config: RoutingConfig = {
        rules: [
          {
            id: 'test',
            name: 'Test',
            enabled: true,
            condition: { type: 'minMessages', min: 100 },
            action: { type: 'observer' },
          },
        ],
      };

      const result = await routeAfterConversation(ctx, config);
      expect(result.actionsTriggered).toHaveLength(0);
      expect(result.traces[0].matched).toBe(false);
    });

    it('triggers reflector action', async () => {
      const ctx = makeContext();
      const config: RoutingConfig = {
        rules: [
          {
            id: 'reflector',
            name: 'Reflector',
            enabled: true,
            condition: { type: 'always' },
            action: { type: 'reflector' },
          },
        ],
      };

      const result = await routeAfterConversation(ctx, config);
      expect(result.actionsTriggered).toContain('reflector');

      // Wait for fire-and-forget to settle
      await new Promise((r) => setTimeout(r, 50));

      expect(reflectOnMemory).toHaveBeenCalledWith('main');
    });

    it('pre-computes frustration only when needed', async () => {
      const ctx = makeContext();
      // Config with NO frustration condition
      const config: RoutingConfig = {
        rules: [
          {
            id: 'test',
            name: 'Test',
            enabled: true,
            condition: { type: 'always' },
            action: { type: 'qualityTracker' },
          },
        ],
      };

      await routeAfterConversation(ctx, config);
      expect(detectFrustration).not.toHaveBeenCalled();
    });

    it('traces include all rule evaluations', async () => {
      const ctx = makeContext({ userMessages: manyMessages(3) });
      const config: RoutingConfig = { rules: defaultRules(5) };

      const result = await routeAfterConversation(ctx, config);

      expect(result.traces).toHaveLength(4);
      expect(result.traces.map((t) => t.ruleId)).toEqual([
        'observer',
        'quality-tracker',
        'auto-learner',
        'hindsight',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // loadRoutingConfig
  // -------------------------------------------------------------------------
  describe('loadRoutingConfig', () => {
    const mockResolver = (f: string) => `/tmp/test-groups/${f}`;

    it('returns default rules when no config file exists', () => {
      (fs.existsSync as Mock).mockReturnValue(false);

      const config = loadRoutingConfig('main', 5, mockResolver);
      expect(config.rules).toHaveLength(4);
      expect(config.rules[0].id).toBe('observer');
    });

    it('returns default rules on invalid JSON', () => {
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock).mockReturnValue('not json');

      const config = loadRoutingConfig('main', 5, mockResolver);
      expect(config.rules).toHaveLength(4);
    });

    it('returns default rules on schema-invalid config', () => {
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock).mockReturnValue(JSON.stringify({ rules: [] }));

      const config = loadRoutingConfig('main', 5, mockResolver);
      expect(config.rules).toHaveLength(4);
    });

    it('loads valid custom config', () => {
      const customConfig = {
        rules: [
          {
            id: 'custom',
            name: 'Custom rule',
            enabled: true,
            condition: { type: 'always' },
            action: { type: 'observer' },
          },
        ],
      };
      (fs.existsSync as Mock).mockReturnValue(true);
      (fs.readFileSync as Mock).mockReturnValue(JSON.stringify(customConfig));

      const config = loadRoutingConfig('main', 5, mockResolver);
      expect(config.rules).toHaveLength(1);
      expect(config.rules[0].id).toBe('custom');
    });
  });
});
