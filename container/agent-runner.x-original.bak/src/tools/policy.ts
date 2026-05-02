// Policy Engine — rule-based decision layer for watcher alerts.
// Classifies health alerts into auto-fix, propose, or alert-only responses.
// Supports fleet (correlated) alerts from the cross-bot coordination engine.

import fs from 'fs';
import path from 'path';

import { BOTS } from './config.js';
import type { HealthState, BotHealthRecord, HealthStateFile } from './watcher.js';
import { isBotHealthRecord, getBotRecords } from './watcher.js';

// ─── Types ──────────────────────────────────────────────

export type ResponseLevel = 'auto-fix' | 'propose' | 'alert-only';

export interface PolicyCondition {
  state: HealthState | HealthState[];
  bot: string; // bot key, "*" for all, or "fleet" for correlated
  context?: {
    crashLooping?: boolean;
    consecutiveFailures?: number;
    previousState?: HealthState;
    correlated?: boolean;  // true for fleet alerts from correlation engine
  };
}

export interface PolicyRule {
  id: string;
  description: string;
  condition: PolicyCondition;
  response: ResponseLevel;
  playbook: string | null;
}

export interface PolicyDecision {
  ruleId: string | null;
  response: ResponseLevel;
  playbook: string | null;
  message: string;
  escalated: boolean;
}

export type PlaybookStep =
  | { tool: string; params: Record<string, unknown>; verify?: string }
  | { wait: number };

export interface RoutingMetadata {
  severity: string;
  channel: string;
  suppressed: boolean;
  escalated: boolean;
}

export interface ActionLogEntry {
  timestamp: string;
  bot: string;
  trigger: {
    from: HealthState;
    to: HealthState;
    consecutiveFailures: number;
    crashLooping: boolean;
  };
  matchedRule: string | null;
  response: ResponseLevel;
  action: string | null;
  outcome: 'auto-fixed' | 'proposed' | 'alert-sent' | 'escalated' | 'failed' | 'suppressed';
  details: string;
  routing?: RoutingMetadata;
  // Cross-bot coordination fields
  correlated?: boolean;
  affectedBots?: string[];
  dependency?: string | null;
}

export interface PolicyConfig {
  maxAutoFixAttempts: number;
  autoFixWindowMs: number;
  proposalTimeoutMs: number;
}

// ─── Defaults ───────────────────────────────────────────

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  maxAutoFixAttempts: 2,
  autoFixWindowMs: 3600000, // 1 hour
  proposalTimeoutMs: 3600000,
};

export const DEFAULT_POLICIES: PolicyRule[] = [
  {
    id: 'crash-loop-alert',
    description: 'Crash-looping bot — alert only, do not restart',
    condition: { state: ['degraded'], bot: '*', context: { crashLooping: true } },
    response: 'alert-only',
    playbook: null,
  },
  {
    id: 'container-down-propose',
    description: 'Container down — propose restart',
    condition: { state: ['down'], bot: '*' },
    response: 'propose',
    playbook: 'restart-container',
  },
  {
    id: 'unreachable-alert',
    description: 'Host unreachable — alert only',
    condition: { state: ['unreachable'], bot: '*' },
    response: 'alert-only',
    playbook: null,
  },
  {
    id: 'degraded-propose',
    description: 'Bot degraded (not crash-looping) — propose restart',
    condition: { state: ['degraded'], bot: '*' },
    response: 'propose',
    playbook: 'restart-container',
  },
  {
    id: 'fleet-unreachable-alert',
    description: 'Multiple bots unreachable — likely shared infrastructure issue',
    condition: { state: ['unreachable'], bot: '*', context: { correlated: true } },
    response: 'alert-only',
    playbook: null,
  },
];

export const PLAYBOOKS: Record<string, PlaybookStep[]> = {
  'restart-container': [
    { tool: 'docker_command', params: { action: 'restart' } },
    { wait: 30000 },
    { tool: 'bot_status', params: { format: 'json' }, verify: 'healthy' },
  ],
  'check-logs-and-alert': [
    { tool: 'search_logs', params: { pattern: 'error|fatal|panic' } },
  ],
};

const CRASH_LOOP_THRESHOLD = 3;
const ACTION_LOG_MAX_ENTRIES = 1000;

// ─── Policy File I/O ────────────────────────────────────

/**
 * Read policy rules from a JSON file. Returns defaults if missing or invalid.
 */
export function readPolicies(filePath: string): PolicyRule[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [...DEFAULT_POLICIES];
    }
    // Validate each rule has required fields
    for (const rule of parsed) {
      if (!rule.id || !rule.condition || !rule.response) {
        return [...DEFAULT_POLICIES];
      }
      if (!['auto-fix', 'propose', 'alert-only'].includes(rule.response)) {
        return [...DEFAULT_POLICIES];
      }
    }
    return parsed as PolicyRule[];
  } catch {
    // Auto-create with defaults if missing
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(DEFAULT_POLICIES, null, 2));
    } catch { /* best-effort */ }
    return [...DEFAULT_POLICIES];
  }
}

// ─── Action Log I/O ─────────────────────────────────────

/**
 * Read the action log. Returns empty array if missing or corrupt.
 */
export function readActionLog(filePath: string): ActionLogEntry[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as ActionLogEntry[];
  } catch {
    return [];
  }
}

/**
 * Append an entry to the action log (atomic write).
 * Rotates if over max entries.
 * Accepts optional routing metadata.
 */
export function appendActionLog(
  filePath: string,
  entry: ActionLogEntry,
): void {
  const log = readActionLog(filePath);
  log.push(entry);

  if (log.length > ACTION_LOG_MAX_ENTRIES) {
    rotateActionLog(filePath, log);
  } else {
    writeJsonAtomic(filePath, log);
  }
}

/**
 * Rotate the action log: archive old entries, keep recent ones.
 */
export function rotateActionLog(filePath: string, log?: ActionLogEntry[]): void {
  const entries = log ?? readActionLog(filePath);
  if (entries.length <= ACTION_LOG_MAX_ENTRIES) return;

  // Archive the full log
  const archivePath = filePath.replace('.json', `.${Date.now()}.json`);
  writeJsonAtomic(archivePath, entries);

  // Keep the most recent 100 entries
  const keep = entries.slice(-100);
  writeJsonAtomic(filePath, keep);
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

// ─── Policy Evaluation ──────────────────────────────────

/**
 * Check if a condition matches the given alert context.
 * Supports correlated flag for fleet alerts.
 */
function conditionMatches(
  condition: PolicyCondition,
  bot: string,
  toState: HealthState,
  context: { crashLooping: boolean; consecutiveFailures: number; previousState: HealthState; correlated?: boolean },
): boolean {
  // Check bot — for fleet alerts, bot is "fleet"; match if condition.bot is "*" or "fleet"
  if (condition.bot !== '*' && condition.bot !== bot) {
    // Special case: allow "fleet" bot to match wildcard
    if (bot !== 'fleet' || condition.bot !== 'fleet') {
      // Don't match a correlated rule (context.correlated: true) against individual alerts
      if (condition.context?.correlated && !context.correlated) return false;
      if (condition.bot !== '*' && condition.bot !== bot) return false;
    }
  }

  // Check state
  const states = Array.isArray(condition.state) ? condition.state : [condition.state];
  if (!states.includes(toState)) return false;

  // Check context conditions
  if (condition.context) {
    if (condition.context.crashLooping !== undefined &&
        condition.context.crashLooping !== context.crashLooping) {
      return false;
    }
    if (condition.context.consecutiveFailures !== undefined &&
        context.consecutiveFailures < condition.context.consecutiveFailures) {
      return false;
    }
    if (condition.context.previousState !== undefined &&
        condition.context.previousState !== context.previousState) {
      return false;
    }
    // Check correlated flag
    if (condition.context.correlated !== undefined) {
      if (condition.context.correlated !== (context.correlated ?? false)) {
        return false;
      }
    }
  }

  // If the rule does NOT have context.correlated but the alert IS correlated,
  // the non-correlated rule should NOT match fleet alerts
  if (context.correlated && !condition.context?.correlated) {
    return false;
  }

  return true;
}

/**
 * Evaluate policy rules against a watcher alert.
 * Returns the decision: which rule matched, response level, playbook, and whether escalated.
 * Supports correlated flag for fleet alerts.
 */
export function evaluatePolicy(
  bot: string,
  fromState: HealthState,
  toState: HealthState,
  healthRecord: BotHealthRecord,
  policies: PolicyRule[],
  policyConfig: PolicyConfig = DEFAULT_POLICY_CONFIG,
  now: Date = new Date(),
  options?: { correlated?: boolean; affectedBots?: string[]; dependency?: string },
): PolicyDecision {
  const crashLooping = (healthRecord.crashLoopCount ?? 0) >= CRASH_LOOP_THRESHOLD;
  const context = {
    crashLooping,
    consecutiveFailures: healthRecord.consecutiveFailures,
    previousState: fromState,
    correlated: options?.correlated,
  };

  const botName = bot === 'fleet'
    ? `Fleet (${options?.affectedBots?.map(b => BOTS[b]?.name ?? b).join(', ') ?? 'all bots'})`
    : (BOTS[bot]?.name ?? bot);

  // Find first matching rule
  for (const rule of policies) {
    if (!conditionMatches(rule.condition, bot, toState, context)) continue;

    let response = rule.response;
    let escalated = false;

    // Check escalation for auto-fix (not applicable to fleet alerts)
    if (response === 'auto-fix' && !options?.correlated) {
      const attempts = healthRecord.autoFixAttempts ?? 0;
      const windowStart = healthRecord.autoFixWindowStart
        ? new Date(healthRecord.autoFixWindowStart).getTime()
        : 0;
      const inWindow = windowStart > 0 &&
        (now.getTime() - windowStart) < policyConfig.autoFixWindowMs;

      if (inWindow && attempts >= policyConfig.maxAutoFixAttempts) {
        response = 'propose';
        escalated = true;
      }
    }

    let message: string;
    if (options?.correlated) {
      message = `${botName}: all bots unreachable — likely shared infrastructure issue (${options.dependency ?? 'unknown dependency'}).`;
    } else if (escalated) {
      message = `${botName} is ${toState} (was ${fromState}). Auto-fix failed after ${policyConfig.maxAutoFixAttempts} attempts. I can try restarting the container — tell me to go ahead.`;
    } else if (response === 'auto-fix') {
      message = `${botName} is ${toState} (was ${fromState}). Auto-fixing with ${rule.playbook}.`;
    } else if (response === 'propose') {
      const playbookDesc = rule.playbook === 'restart-container'
        ? 'restart the container' : `run ${rule.playbook}`;
      message = `${botName} is ${toState} (was ${fromState}). I can ${playbookDesc}. Tell me to go ahead.`;
    } else {
      message = `${botName} is ${toState} (was ${fromState}).`;
      if (crashLooping) {
        message += ' Container appears to be crash-looping. Manual investigation needed.';
      }
    }

    return {
      ruleId: rule.id,
      response,
      playbook: rule.playbook,
      message,
      escalated,
    };
  }

  // No rule matched — default to alert-only
  let defaultMessage: string;
  if (options?.correlated) {
    defaultMessage = `${botName}: all bots unreachable — likely shared infrastructure issue. No policy rule matched.`;
  } else {
    defaultMessage = `${botName} is ${toState} (was ${fromState}). No policy rule matched.`;
  }

  return {
    ruleId: null,
    response: 'alert-only',
    playbook: null,
    message: defaultMessage,
    escalated: false,
  };
}
