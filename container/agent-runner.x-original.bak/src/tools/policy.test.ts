import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  readPolicies,
  evaluatePolicy,
  readActionLog,
  appendActionLog,
  rotateActionLog,
  DEFAULT_POLICIES,
  DEFAULT_POLICY_CONFIG,
  type PolicyRule,
  type ActionLogEntry,
  type PolicyConfig,
  type RoutingMetadata,
} from './policy.js';
import type { BotHealthRecord } from './watcher.js';

// ─── Helper ─────────────────────────────────────────────

function makeRecord(overrides: Partial<BotHealthRecord> = {}): BotHealthRecord {
  return {
    state: 'healthy',
    previousState: 'unknown',
    lastStateChange: '2026-03-15T00:00:00Z',
    lastCheckAt: '2026-03-15T00:00:00Z',
    consecutiveFailures: 0,
    lastAlertAt: null,
    crashLoopCount: 0,
    autoFixAttempts: 0,
    autoFixWindowStart: null,
    lastCriticalAlertAt: null,
    criticalAlertAcknowledged: false,
    escalationCount: 0,
    lastEscalationAt: null,
    ...overrides,
  };
}

function makeLogEntry(overrides: Partial<ActionLogEntry> = {}): ActionLogEntry {
  return {
    timestamp: new Date().toISOString(),
    bot: 'db',
    trigger: { from: 'healthy', to: 'down', consecutiveFailures: 2, crashLooping: false },
    matchedRule: 'container-down-propose',
    response: 'propose',
    action: 'restart-container',
    outcome: 'proposed',
    details: '',
    ...overrides,
  };
}

// ─── Policy File I/O ────────────────────────────────────

describe('readPolicies', () => {
  let tmpDir: string;
  let policyPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-'));
    policyPath = path.join(tmpDir, 'policies.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults for missing file and creates it', () => {
    const policies = readPolicies(policyPath);
    expect(policies).toHaveLength(DEFAULT_POLICIES.length);
    expect(policies[0].id).toBe('crash-loop-alert');
    // Should have created the file
    expect(fs.existsSync(policyPath)).toBe(true);
  });

  it('returns defaults for corrupt file', () => {
    fs.writeFileSync(policyPath, 'not json!!!');
    const policies = readPolicies(policyPath);
    expect(policies).toHaveLength(DEFAULT_POLICIES.length);
  });

  it('returns defaults for non-array JSON', () => {
    fs.writeFileSync(policyPath, '{"not": "an array"}');
    const policies = readPolicies(policyPath);
    expect(policies).toHaveLength(DEFAULT_POLICIES.length);
  });

  it('returns defaults for rules with missing required fields', () => {
    fs.writeFileSync(policyPath, JSON.stringify([{ id: 'bad' }]));
    const policies = readPolicies(policyPath);
    expect(policies).toHaveLength(DEFAULT_POLICIES.length);
  });

  it('returns defaults for rules with invalid response level', () => {
    fs.writeFileSync(policyPath, JSON.stringify([
      { id: 'test', condition: { state: 'down', bot: '*' }, response: 'invalid', playbook: null, description: 'test' },
    ]));
    const policies = readPolicies(policyPath);
    expect(policies).toHaveLength(DEFAULT_POLICIES.length);
  });

  it('reads valid policy file', () => {
    const custom: PolicyRule[] = [
      {
        id: 'custom-auto-fix',
        description: 'Auto-fix container down',
        condition: { state: ['down'], bot: '*' },
        response: 'auto-fix',
        playbook: 'restart-container',
      },
    ];
    fs.writeFileSync(policyPath, JSON.stringify(custom));
    const policies = readPolicies(policyPath);
    expect(policies).toHaveLength(1);
    expect(policies[0].id).toBe('custom-auto-fix');
    expect(policies[0].response).toBe('auto-fix');
  });
});

// ─── Action Log I/O ─────────────────────────────────────

describe('readActionLog', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-'));
    logPath = path.join(tmpDir, 'action-log.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array for missing file', () => {
    expect(readActionLog(logPath)).toEqual([]);
  });

  it('returns empty array for corrupt file', () => {
    fs.writeFileSync(logPath, 'broken');
    expect(readActionLog(logPath)).toEqual([]);
  });

  it('reads valid log file', () => {
    const entries = [makeLogEntry()];
    fs.writeFileSync(logPath, JSON.stringify(entries));
    const result = readActionLog(logPath);
    expect(result).toHaveLength(1);
    expect(result[0].bot).toBe('db');
  });

  it('reads old entries without routing field (backward compat, T3)', () => {
    const oldEntry = {
      timestamp: '2026-03-15T00:00:00Z',
      bot: 'db',
      trigger: { from: 'healthy', to: 'down', consecutiveFailures: 2, crashLooping: false },
      matchedRule: 'container-down-propose',
      response: 'propose',
      action: 'restart-container',
      outcome: 'proposed',
      details: '',
      // No routing field
    };
    fs.writeFileSync(logPath, JSON.stringify([oldEntry]));
    const result = readActionLog(logPath);
    expect(result).toHaveLength(1);
    expect(result[0].routing).toBeUndefined();
  });
});

describe('appendActionLog', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-'));
    logPath = path.join(tmpDir, 'action-log.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates file and appends first entry', () => {
    appendActionLog(logPath, makeLogEntry());
    const log = readActionLog(logPath);
    expect(log).toHaveLength(1);
  });

  it('appends to existing entries', () => {
    appendActionLog(logPath, makeLogEntry({ bot: 'db' }));
    appendActionLog(logPath, makeLogEntry({ bot: 'nook' }));
    const log = readActionLog(logPath);
    expect(log).toHaveLength(2);
    expect(log[0].bot).toBe('db');
    expect(log[1].bot).toBe('nook');
  });

  it('persists routing metadata in new entries (T3)', () => {
    const routing: RoutingMetadata = {
      severity: 'critical',
      channel: 'slack:D0AM0RZ7HB2',
      suppressed: false,
      escalated: false,
    };
    appendActionLog(logPath, makeLogEntry({ routing }));
    const log = readActionLog(logPath);
    expect(log).toHaveLength(1);
    expect(log[0].routing).toBeDefined();
    expect(log[0].routing!.severity).toBe('critical');
    expect(log[0].routing!.channel).toBe('slack:D0AM0RZ7HB2');
    expect(log[0].routing!.suppressed).toBe(false);
    expect(log[0].routing!.escalated).toBe(false);
  });

  it('persists suppressed routing metadata (T3)', () => {
    const routing: RoutingMetadata = {
      severity: 'warning',
      channel: 'slack:D0AM0RZ7HB2',
      suppressed: true,
      escalated: false,
    };
    appendActionLog(logPath, makeLogEntry({ outcome: 'suppressed', routing }));
    const log = readActionLog(logPath);
    expect(log[0].outcome).toBe('suppressed');
    expect(log[0].routing!.suppressed).toBe(true);
  });
});

describe('rotateActionLog', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-test-'));
    logPath = path.join(tmpDir, 'action-log.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does nothing when under threshold', () => {
    const entries = Array.from({ length: 50 }, () => makeLogEntry());
    fs.writeFileSync(logPath, JSON.stringify(entries));
    rotateActionLog(logPath);
    const result = readActionLog(logPath);
    expect(result).toHaveLength(50);
  });

  it('rotates when over threshold', () => {
    const entries = Array.from({ length: 1001 }, (_, i) =>
      makeLogEntry({ details: `entry-${i}` }),
    );
    rotateActionLog(logPath, entries);
    const result = readActionLog(logPath);
    expect(result).toHaveLength(100); // Kept recent 100
    expect(result[0].details).toBe('entry-901');
    // Archive should exist
    const files = fs.readdirSync(tmpDir);
    const archiveFiles = files.filter(f => f.startsWith('action-log.') && f !== 'action-log.json');
    expect(archiveFiles.length).toBeGreaterThan(0);
  });
});

// ─── Policy Evaluation ──────────────────────────────────

describe('evaluatePolicy', () => {
  it('matches first rule (first-match semantics)', () => {
    const policies: PolicyRule[] = [
      {
        id: 'first',
        description: 'First rule',
        condition: { state: ['down'], bot: '*' },
        response: 'alert-only',
        playbook: null,
      },
      {
        id: 'second',
        description: 'Second rule',
        condition: { state: ['down'], bot: '*' },
        response: 'auto-fix',
        playbook: 'restart-container',
      },
    ];
    const record = makeRecord({ state: 'down', consecutiveFailures: 2 });
    const decision = evaluatePolicy('db', 'healthy', 'down', record, policies);
    expect(decision.ruleId).toBe('first');
    expect(decision.response).toBe('alert-only');
  });

  it('matches wildcard bot', () => {
    const decision = evaluatePolicy(
      'nook', 'healthy', 'down',
      makeRecord({ state: 'down', consecutiveFailures: 2 }),
      DEFAULT_POLICIES,
    );
    expect(decision.ruleId).toBe('container-down-propose');
    expect(decision.response).toBe('propose');
  });

  it('matches specific bot over wildcard when listed first', () => {
    const policies: PolicyRule[] = [
      {
        id: 'db-specific',
        description: 'DB-specific auto-fix',
        condition: { state: ['down'], bot: 'db' },
        response: 'auto-fix',
        playbook: 'restart-container',
      },
      {
        id: 'wildcard',
        description: 'All bots propose',
        condition: { state: ['down'], bot: '*' },
        response: 'propose',
        playbook: 'restart-container',
      },
    ];
    const dbDecision = evaluatePolicy('db', 'healthy', 'down', makeRecord({ state: 'down' }), policies);
    expect(dbDecision.ruleId).toBe('db-specific');
    expect(dbDecision.response).toBe('auto-fix');

    const nookDecision = evaluatePolicy('nook', 'healthy', 'down', makeRecord({ state: 'down' }), policies);
    expect(nookDecision.ruleId).toBe('wildcard');
    expect(nookDecision.response).toBe('propose');
  });

  it('detects crash-looping from crashLoopCount', () => {
    const record = makeRecord({ state: 'degraded', crashLoopCount: 3 });
    const decision = evaluatePolicy('db', 'healthy', 'degraded', record, DEFAULT_POLICIES);
    expect(decision.ruleId).toBe('crash-loop-alert');
    expect(decision.response).toBe('alert-only');
    expect(decision.message).toContain('crash-looping');
  });

  it('does not flag crash-loop below threshold', () => {
    const record = makeRecord({ state: 'degraded', crashLoopCount: 2 });
    const decision = evaluatePolicy('db', 'healthy', 'degraded', record, DEFAULT_POLICIES);
    expect(decision.ruleId).toBe('degraded-propose');
    expect(decision.response).toBe('propose');
  });

  it('escalates auto-fix after max attempts', () => {
    const policies: PolicyRule[] = [
      {
        id: 'auto-fix-down',
        description: 'Auto-fix down',
        condition: { state: ['down'], bot: '*' },
        response: 'auto-fix',
        playbook: 'restart-container',
      },
    ];
    const now = new Date('2026-03-15T01:00:00Z');
    const record = makeRecord({
      state: 'down',
      autoFixAttempts: 2,
      autoFixWindowStart: '2026-03-15T00:30:00Z', // 30 min ago, within 1h window
    });
    const decision = evaluatePolicy('db', 'healthy', 'down', record, policies, DEFAULT_POLICY_CONFIG, now);
    expect(decision.response).toBe('propose');
    expect(decision.escalated).toBe(true);
    expect(decision.message).toContain('Auto-fix failed');
  });

  it('does NOT escalate when outside time window', () => {
    const policies: PolicyRule[] = [
      {
        id: 'auto-fix-down',
        description: 'Auto-fix down',
        condition: { state: ['down'], bot: '*' },
        response: 'auto-fix',
        playbook: 'restart-container',
      },
    ];
    const now = new Date('2026-03-15T03:00:00Z');
    const record = makeRecord({
      state: 'down',
      autoFixAttempts: 2,
      autoFixWindowStart: '2026-03-15T00:30:00Z', // 2.5h ago, outside 1h window
    });
    const decision = evaluatePolicy('db', 'healthy', 'down', record, policies, DEFAULT_POLICY_CONFIG, now);
    expect(decision.response).toBe('auto-fix');
    expect(decision.escalated).toBe(false);
  });

  it('defaults to alert-only when no rule matches', () => {
    const decision = evaluatePolicy(
      'db', 'healthy', 'unknown',
      makeRecord({ state: 'unknown' }),
      DEFAULT_POLICIES,
    );
    expect(decision.ruleId).toBeNull();
    expect(decision.response).toBe('alert-only');
    expect(decision.message).toContain('No policy rule matched');
  });

  it('handles unreachable state correctly', () => {
    const decision = evaluatePolicy(
      'db', 'healthy', 'unreachable',
      makeRecord({ state: 'unreachable', consecutiveFailures: 2 }),
      DEFAULT_POLICIES,
    );
    expect(decision.ruleId).toBe('unreachable-alert');
    expect(decision.response).toBe('alert-only');
  });

  it('handles context.consecutiveFailures condition', () => {
    const policies: PolicyRule[] = [
      {
        id: 'many-failures',
        description: 'Alert when many failures',
        condition: { state: ['down'], bot: '*', context: { consecutiveFailures: 5 } },
        response: 'alert-only',
        playbook: null,
      },
      {
        id: 'few-failures',
        description: 'Propose when few failures',
        condition: { state: ['down'], bot: '*' },
        response: 'propose',
        playbook: 'restart-container',
      },
    ];

    // Below threshold — skips first rule, matches second
    const fewResult = evaluatePolicy('db', 'healthy', 'down',
      makeRecord({ state: 'down', consecutiveFailures: 3 }), policies);
    expect(fewResult.ruleId).toBe('few-failures');

    // At threshold — matches first rule
    const manyResult = evaluatePolicy('db', 'healthy', 'down',
      makeRecord({ state: 'down', consecutiveFailures: 5 }), policies);
    expect(manyResult.ruleId).toBe('many-failures');
  });
});
