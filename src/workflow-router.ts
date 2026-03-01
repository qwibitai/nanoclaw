/**
 * Workflow Router — deterministic, config-driven routing between agent steps.
 *
 * Replaces hardcoded fire-and-forget blocks in index.ts with a rule engine.
 * Every routing decision is trace-logged with input → rule matched → action taken.
 *
 * Rules are evaluated in order. Each rule has a condition (evaluated from
 * conversation context) and an action (which module to fire).
 *
 * Host-side module. No LLM calls — all decisions are code-based.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { resolveGroupFolderPath as resolveGroupFolderPathSync } from './group-folder.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Schemas — Zod-validated rule config
// ---------------------------------------------------------------------------

const RoutingConditionSchema: z.ZodType<RoutingCondition> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('always') }),
    z.object({
      type: z.literal('minMessages'),
      min: z.number().int().positive(),
    }),
    z.object({ type: z.literal('frustrationDetected') }),
    z.object({ type: z.literal('correctionDetected') }),
    z.object({
      type: z.literal('all'),
      conditions: z.array(RoutingConditionSchema).min(1),
    }),
    z.object({
      type: z.literal('any'),
      conditions: z.array(RoutingConditionSchema).min(1),
    }),
  ]),
);

const RoutingActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('observer') }),
  z.object({ type: z.literal('qualityTracker') }),
  z.object({ type: z.literal('autoLearner') }),
  z.object({ type: z.literal('hindsight') }),
  z.object({ type: z.literal('reflector') }),
  z.object({ type: z.literal('memoryImprover') }),
  z.object({ type: z.literal('proactiveAgent') }),
]);

const RoutingRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  condition: RoutingConditionSchema,
  action: RoutingActionSchema,
});

export const RoutingConfigSchema = z.object({
  rules: z.array(RoutingRuleSchema).min(1),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RoutingCondition =
  | { type: 'always' }
  | { type: 'minMessages'; min: number }
  | { type: 'frustrationDetected' }
  | { type: 'correctionDetected' }
  | { type: 'all'; conditions: RoutingCondition[] }
  | { type: 'any'; conditions: RoutingCondition[] };

export type RoutingAction =
  | { type: 'observer' }
  | { type: 'qualityTracker' }
  | { type: 'autoLearner' }
  | { type: 'hindsight' }
  | { type: 'reflector' }
  | { type: 'memoryImprover' }
  | { type: 'proactiveAgent' };

export interface RoutingRule {
  id: string;
  name: string;
  enabled: boolean;
  condition: RoutingCondition;
  action: RoutingAction;
}

export interface RoutingConfig {
  rules: RoutingRule[];
}

export interface RoutingContext {
  groupFolder: string;
  userMessages: Array<{
    sender_name: string;
    content: string;
    timestamp: string;
  }>;
  botResponses: string[];
}

export interface RouteTrace {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  action: string;
  reason: string;
}

export interface RoutingResult {
  traces: RouteTrace[];
  actionsTriggered: string[];
}

// ---------------------------------------------------------------------------
// Correction detection — lightweight pre-gate (not LLM)
// ---------------------------------------------------------------------------

const CORRECTION_PATTERNS = [
  /\bno[,.]?\s+(?:it'?s|that'?s|the|my|his|her)\b/i,
  /\bactually[,.]?\s/i,
  /\bthat'?s (?:not right|not correct|incorrect|wrong)\b/i,
  /\bi (?:meant|said|asked for)\b/i,
  /\bcorrection:/i,
  /\bto clarify[,:]\b/i,
];

function hasCorrectionSignal(messages: Array<{ content: string }>): boolean {
  return messages.some((m) =>
    CORRECTION_PATTERNS.some((p) => p.test(m.content)),
  );
}

// ---------------------------------------------------------------------------
// Condition evaluator
// ---------------------------------------------------------------------------

export function evaluateCondition(
  condition: RoutingCondition,
  ctx: RoutingContext,
  frustrationResult?: { detected: boolean },
): { matched: boolean; reason: string } {
  switch (condition.type) {
    case 'always':
      return { matched: true, reason: 'always' };

    case 'minMessages':
      return {
        matched: ctx.userMessages.length >= condition.min,
        reason: `messageCount=${ctx.userMessages.length} (min=${condition.min})`,
      };

    case 'frustrationDetected': {
      const detected = frustrationResult?.detected ?? false;
      return {
        matched: detected,
        reason: detected
          ? 'frustration signals detected'
          : 'no frustration signals',
      };
    }

    case 'correctionDetected': {
      const found = hasCorrectionSignal(ctx.userMessages);
      return {
        matched: found,
        reason: found ? 'correction patterns found' : 'no correction patterns',
      };
    }

    case 'all': {
      const results = condition.conditions.map((c) =>
        evaluateCondition(c, ctx, frustrationResult),
      );
      const allMatched = results.every((r) => r.matched);
      return {
        matched: allMatched,
        reason: `all(${results.map((r) => r.reason).join(', ')})`,
      };
    }

    case 'any': {
      const results = condition.conditions.map((c) =>
        evaluateCondition(c, ctx, frustrationResult),
      );
      const anyMatched = results.some((r) => r.matched);
      return {
        matched: anyMatched,
        reason: `any(${results.map((r) => r.reason).join(', ')})`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Default rules — match current hardcoded behavior
// ---------------------------------------------------------------------------

export function defaultRules(minObserverMessages: number): RoutingRule[] {
  return [
    {
      id: 'observer',
      name: 'Observer — compress conversations into observations',
      enabled: true,
      condition: { type: 'minMessages', min: minObserverMessages },
      action: { type: 'observer' },
    },
    {
      id: 'quality-tracker',
      name: 'Quality Tracker — log quality signals',
      enabled: true,
      condition: { type: 'always' },
      action: { type: 'qualityTracker' },
    },
    {
      id: 'auto-learner',
      name: 'Auto-Learner — extract corrections',
      enabled: true,
      condition: { type: 'correctionDetected' },
      action: { type: 'autoLearner' },
    },
    {
      id: 'hindsight',
      name: 'Hindsight — post-mortem on frustrated conversations',
      enabled: true,
      condition: { type: 'frustrationDetected' },
      action: { type: 'hindsight' },
    },
  ];
}

// ---------------------------------------------------------------------------
// Config loading — JSON override from group folder
// ---------------------------------------------------------------------------

export function loadRoutingConfig(
  groupFolder: string,
  fallbackMinObserverMessages: number,
  resolveGroupFolderPathFn?: (folder: string) => string,
): RoutingConfig {
  try {
    const resolve = resolveGroupFolderPathFn ?? resolveGroupFolderPathSync;
    const groupPath = resolve(groupFolder);
    const configPath = path.join(groupPath, 'router-rules.json');

    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const validated = RoutingConfigSchema.safeParse(parsed);

      if (validated.success) {
        logger.info(
          { groupFolder, ruleCount: validated.data.rules.length },
          'Loaded custom routing rules',
        );
        return validated.data;
      }

      logger.warn(
        { groupFolder, errors: validated.error.issues },
        'Invalid router-rules.json — falling back to defaults',
      );
    }
  } catch {
    // File doesn't exist or can't be read — use defaults
  }

  return { rules: defaultRules(fallbackMinObserverMessages) };
}

// ---------------------------------------------------------------------------
// Action executors — fire-and-forget, same pattern as current index.ts
// ---------------------------------------------------------------------------

async function executeAction(
  action: RoutingAction,
  ctx: RoutingContext,
): Promise<void> {
  const msgs = ctx.userMessages.map((m) => ({
    sender_name: m.sender_name,
    content: m.content,
    timestamp: m.timestamp,
  }));

  switch (action.type) {
    case 'observer': {
      const { observeConversation } = await import('./observer.js');
      await observeConversation(ctx.groupFolder, msgs, ctx.botResponses);
      break;
    }
    case 'qualityTracker': {
      const { trackConversationQuality } = await import('./quality-tracker.js');
      await trackConversationQuality(ctx.groupFolder, msgs, ctx.botResponses);
      break;
    }
    case 'autoLearner': {
      const { processLearning } = await import('./auto-learner.js');
      await processLearning(ctx.groupFolder, msgs, ctx.botResponses);
      break;
    }
    case 'hindsight': {
      const { processHindsight } = await import('./hindsight.js');
      await processHindsight(ctx.groupFolder, msgs, ctx.botResponses);
      break;
    }
    case 'reflector': {
      const { reflectOnMemory } = await import('./reflector.js');
      await reflectOnMemory(ctx.groupFolder);
      break;
    }
    case 'memoryImprover': {
      const { improveMemory } = await import('./memory-improver.js');
      await improveMemory(ctx.groupFolder);
      break;
    }
    case 'proactiveAgent': {
      const { detectProactiveOpportunities } = await import('./proactive-agent.js');
      await detectProactiveOpportunities(ctx.groupFolder);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Main export — single entry point for post-conversation routing
// ---------------------------------------------------------------------------

export async function routeAfterConversation(
  ctx: RoutingContext,
  config: RoutingConfig,
): Promise<RoutingResult> {
  const traces: RouteTrace[] = [];
  const actionsTriggered: string[] = [];

  // Pre-compute frustration detection once (shared across rules)
  let frustrationResult: { detected: boolean } | undefined;
  const needsFrustration = config.rules.some((r) =>
    conditionUsesFrustration(r.condition),
  );
  if (needsFrustration) {
    try {
      const { detectFrustration } = await import('./hindsight.js');
      frustrationResult = detectFrustration(ctx.userMessages);
    } catch {
      frustrationResult = { detected: false };
    }
  }

  for (const rule of config.rules) {
    if (!rule.enabled) {
      traces.push({
        ruleId: rule.id,
        ruleName: rule.name,
        matched: false,
        action: rule.action.type,
        reason: 'disabled',
      });
      continue;
    }

    const { matched, reason } = evaluateCondition(
      rule.condition,
      ctx,
      frustrationResult,
    );

    traces.push({
      ruleId: rule.id,
      ruleName: rule.name,
      matched,
      action: rule.action.type,
      reason,
    });

    if (matched) {
      actionsTriggered.push(rule.action.type);

      // Fire-and-forget — don't await, don't block routing
      executeAction(rule.action, ctx).catch((err) =>
        logger.warn(
          { err, ruleId: rule.id, action: rule.action.type },
          'Routing action failed (non-blocking)',
        ),
      );
    }
  }

  // Trace log all decisions
  logger.info(
    {
      groupFolder: ctx.groupFolder,
      messageCount: ctx.userMessages.length,
      rulesEvaluated: traces.length,
      actionsTriggered,
      traces,
    },
    'Workflow routing complete',
  );

  return { traces, actionsTriggered };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function conditionUsesFrustration(condition: RoutingCondition): boolean {
  if (condition.type === 'frustrationDetected') return true;
  if (condition.type === 'all' || condition.type === 'any') {
    return condition.conditions.some(conditionUsesFrustration);
  }
  return false;
}
