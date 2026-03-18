import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  readHealthState,
  writeHealthState,
  initializeHealthState,
  classifyHealth,
  computeAlerts,
  readWatcherConfig,
  readRoutingConfig,
  DEFAULT_ROUTING_CONFIG,
  classifySeverity,
  isQuietHours,
  shouldSuppress,
  routeAlert,
  formatAlert,
  checkEscalations,
  markCriticalAlert,
  markEscalation,
  clearEscalation,
  type HealthStateFile,
  type BotHealthRecord,
  type WatcherConfig,
  type RoutingConfig,
  type QuietHoursConfig,
  type SeverityLevel,
} from './watcher.js';
import type { BotStatusJson } from './observe.js';

// ─── State File I/O ─────────────────────────────────────

describe('readHealthState', () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-test-'));
    statePath = path.join(tmpDir, 'health-state.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns default state for missing file', () => {
    const state = readHealthState(statePath);
    expect(state).toHaveProperty('db');
    expect(state).toHaveProperty('nook');
    expect(state.db.state).toBe('unknown');
    expect(state.nook.state).toBe('unknown');
  });

  it('returns default state for corrupt file', () => {
    fs.writeFileSync(statePath, 'not json at all{{{');
    const state = readHealthState(statePath);
    expect(state.db.state).toBe('unknown');
  });

  it('reads valid state file', () => {
    const testState: HealthStateFile = {
      db: {
        state: 'healthy',
        previousState: 'unknown',
        lastStateChange: '2026-03-15T00:00:00Z',
        lastCheckAt: '2026-03-15T00:05:00Z',
        consecutiveFailures: 0,
        lastAlertAt: null,
        crashLoopCount: 0,
        autoFixAttempts: 0,
        autoFixWindowStart: null,
        lastCriticalAlertAt: null,
        criticalAlertAcknowledged: false,
        escalationCount: 0,
        lastEscalationAt: null,
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(testState));
    const state = readHealthState(statePath);
    expect(state.db.state).toBe('healthy');
  });

  it('backfills new fields on old state files', () => {
    // Simulate an old state file without the new fields
    const oldState = {
      db: {
        state: 'healthy',
        previousState: 'unknown',
        lastStateChange: '2026-03-15T00:00:00Z',
        lastCheckAt: '2026-03-15T00:05:00Z',
        consecutiveFailures: 0,
        lastAlertAt: null,
        // Missing: crashLoopCount, autoFixAttempts, autoFixWindowStart
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(oldState));
    const state = readHealthState(statePath);
    expect(state.db.crashLoopCount).toBe(0);
    expect(state.db.autoFixAttempts).toBe(0);
    expect(state.db.autoFixWindowStart).toBeNull();
  });

  it('backfills escalation tracking fields on old state files (T2)', () => {
    const oldState = {
      db: {
        state: 'down',
        previousState: 'healthy',
        lastStateChange: '2026-03-15T00:00:00Z',
        lastCheckAt: '2026-03-15T00:05:00Z',
        consecutiveFailures: 3,
        lastAlertAt: '2026-03-15T00:05:00Z',
        crashLoopCount: 0,
        autoFixAttempts: 0,
        autoFixWindowStart: null,
        // Missing: lastCriticalAlertAt, criticalAlertAcknowledged, escalationCount, lastEscalationAt
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(oldState));
    const state = readHealthState(statePath);
    expect(state.db.lastCriticalAlertAt).toBeNull();
    expect(state.db.criticalAlertAcknowledged).toBe(false);
    expect(state.db.escalationCount).toBe(0);
    expect(state.db.lastEscalationAt).toBeNull();
  });

  it('default initialization includes escalation fields (T2)', () => {
    const state = initializeHealthState();
    expect(state.db.lastCriticalAlertAt).toBeNull();
    expect(state.db.criticalAlertAcknowledged).toBe(false);
    expect(state.db.escalationCount).toBe(0);
    expect(state.db.lastEscalationAt).toBeNull();
  });

  it('persists escalation fields through write/read cycle (T2)', () => {
    const state = initializeHealthState();
    state.db.lastCriticalAlertAt = '2026-03-15T03:22:00Z';
    state.db.criticalAlertAcknowledged = false;
    state.db.escalationCount = 2;
    state.db.lastEscalationAt = '2026-03-15T03:37:00Z';
    writeHealthState(statePath, state);
    const read = readHealthState(statePath);
    expect(read.db.lastCriticalAlertAt).toBe('2026-03-15T03:22:00Z');
    expect(read.db.criticalAlertAcknowledged).toBe(false);
    expect(read.db.escalationCount).toBe(2);
    expect(read.db.lastEscalationAt).toBe('2026-03-15T03:37:00Z');
  });
});

describe('writeHealthState', () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-test-'));
    statePath = path.join(tmpDir, 'health-state.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes and reads back correctly', () => {
    const state = initializeHealthState();
    state.db.state = 'healthy';
    writeHealthState(statePath, state);
    const read = readHealthState(statePath);
    expect(read.db.state).toBe('healthy');
  });

  it('creates parent directories if needed', () => {
    const deepPath = path.join(tmpDir, 'a', 'b', 'state.json');
    const state = initializeHealthState();
    writeHealthState(deepPath, state);
    expect(fs.existsSync(deepPath)).toBe(true);
  });
});

// ─── Health Classification ──────────────────────────────

describe('classifyHealth', () => {
  it('classifies running container with high uptime as healthy', () => {
    const status: BotStatusJson = {
      bot: 'db', state: 'running', uptime_seconds: 3600,
      status_string: 'Up 1 hour', ssh_ok: true, checked_at: '2026-03-15T00:00:00Z',
    };
    expect(classifyHealth(status)).toBe('healthy');
  });

  it('classifies running container with low uptime as degraded', () => {
    const status: BotStatusJson = {
      bot: 'db', state: 'running', uptime_seconds: 30,
      status_string: 'Up 30 seconds', ssh_ok: true, checked_at: '2026-03-15T00:00:00Z',
    };
    expect(classifyHealth(status)).toBe('degraded');
  });

  it('classifies restarting container as degraded', () => {
    const status: BotStatusJson = {
      bot: 'db', state: 'restarting', uptime_seconds: null,
      status_string: 'Restarting', ssh_ok: true, checked_at: '2026-03-15T00:00:00Z',
    };
    expect(classifyHealth(status)).toBe('degraded');
  });

  it('classifies stopped container as down', () => {
    const status: BotStatusJson = {
      bot: 'db', state: 'stopped', uptime_seconds: null,
      status_string: 'Exited', ssh_ok: true, checked_at: '2026-03-15T00:00:00Z',
    };
    expect(classifyHealth(status)).toBe('down');
  });

  it('classifies not_found container as down', () => {
    const status: BotStatusJson = {
      bot: 'db', state: 'not_found', uptime_seconds: null,
      status_string: 'Not found', ssh_ok: true, checked_at: '2026-03-15T00:00:00Z',
    };
    expect(classifyHealth(status)).toBe('down');
  });

  it('classifies SSH failure as unreachable', () => {
    const status: BotStatusJson = {
      bot: 'db', state: 'unknown', uptime_seconds: null,
      status_string: 'SSH failed', ssh_ok: false, checked_at: '2026-03-15T00:00:00Z',
    };
    expect(classifyHealth(status)).toBe('unreachable');
  });
});

// ─── Alert Logic ────────────────────────────────────────

describe('computeAlerts', () => {
  const config: WatcherConfig = {
    checkIntervalMs: 300000,
    cooldownMs: 1800000,
    digestCron: '0 8 * * *',
    alertChannelJid: 'slack:test',
    consecutiveFailuresBeforeAlert: 2,
  };

  function makeState(overrides: Partial<BotHealthRecord> = {}): BotHealthRecord {
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

  it('alerts on healthy→down after consecutive failures threshold', () => {
    const prev: HealthStateFile = {
      db: makeState({ state: 'healthy', consecutiveFailures: 1 }),
    };
    const current = { db: 'down' as const };
    const { alerts } = computeAlerts(prev, current, config);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].from).toBe('healthy');
    expect(alerts[0].to).toBe('down');
  });

  it('does NOT alert on first failure (below threshold)', () => {
    const prev: HealthStateFile = {
      db: makeState({ state: 'healthy', consecutiveFailures: 0 }),
    };
    const current = { db: 'down' as const };
    const { alerts } = computeAlerts(prev, current, config);
    expect(alerts).toHaveLength(0);
  });

  it('sends recovery when down→healthy', () => {
    const prev: HealthStateFile = {
      db: makeState({ state: 'down', consecutiveFailures: 3 }),
    };
    const current = { db: 'healthy' as const };
    const { recoveries } = computeAlerts(prev, current, config);
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0].from).toBe('down');
    expect(recoveries[0].to).toBe('healthy');
  });

  it('respects cooldown period', () => {
    const now = new Date('2026-03-15T00:10:00Z');
    const prev: HealthStateFile = {
      db: makeState({
        state: 'healthy',
        consecutiveFailures: 1,
        lastAlertAt: '2026-03-15T00:05:00Z', // 5 min ago, cooldown is 30 min
      }),
    };
    const current = { db: 'down' as const };
    const { alerts } = computeAlerts(prev, current, config, now);
    expect(alerts).toHaveLength(0); // Cooldown not elapsed
  });

  it('alerts after cooldown has elapsed', () => {
    const now = new Date('2026-03-15T01:00:00Z');
    const prev: HealthStateFile = {
      db: makeState({
        state: 'healthy',
        consecutiveFailures: 1,
        lastAlertAt: '2026-03-15T00:05:00Z', // 55 min ago
      }),
    };
    const current = { db: 'down' as const };
    const { alerts } = computeAlerts(prev, current, config, now);
    expect(alerts).toHaveLength(1);
  });

  it('reports unchanged bots correctly', () => {
    const prev: HealthStateFile = {
      db: makeState({ state: 'healthy' }),
    };
    const current = { db: 'healthy' as const };
    const { alerts, recoveries } = computeAlerts(prev, current, config);
    expect(alerts).toHaveLength(0);
    expect(recoveries).toHaveLength(0);
  });

  // ─── Crash-Loop Tracking ────────────────────────────

  it('increments crashLoopCount when degraded', () => {
    const prev: HealthStateFile = {
      db: makeState({ state: 'degraded', crashLoopCount: 1 }),
    };
    const current = { db: 'degraded' as const };
    const { updatedState } = computeAlerts(prev, current, config);
    expect(updatedState.db.crashLoopCount).toBe(2);
  });

  it('resets crashLoopCount when not degraded', () => {
    const prev: HealthStateFile = {
      db: makeState({ state: 'degraded', crashLoopCount: 3 }),
    };
    const current = { db: 'healthy' as const };
    const { updatedState } = computeAlerts(prev, current, config);
    expect(updatedState.db.crashLoopCount).toBe(0);
  });

  it('resets autoFixAttempts on recovery to healthy', () => {
    const prev: HealthStateFile = {
      db: makeState({
        state: 'down',
        consecutiveFailures: 3,
        autoFixAttempts: 2,
        autoFixWindowStart: '2026-03-15T00:00:00Z',
      }),
    };
    const current = { db: 'healthy' as const };
    const { updatedState } = computeAlerts(prev, current, config);
    expect(updatedState.db.autoFixAttempts).toBe(0);
    expect(updatedState.db.autoFixWindowStart).toBeNull();
  });

  it('carries forward autoFixAttempts when not healthy', () => {
    const prev: HealthStateFile = {
      db: makeState({
        state: 'healthy',
        autoFixAttempts: 1,
        autoFixWindowStart: '2026-03-15T00:00:00Z',
      }),
    };
    const current = { db: 'down' as const };
    const { updatedState } = computeAlerts(prev, current, config);
    expect(updatedState.db.autoFixAttempts).toBe(1);
    expect(updatedState.db.autoFixWindowStart).toBe('2026-03-15T00:00:00Z');
  });
});

// ─── Routing Config I/O (T1) ────────────────────────────

describe('readRoutingConfig', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-test-'));
    configPath = path.join(tmpDir, 'routing.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns default config for missing file', () => {
    const config = readRoutingConfig(configPath);
    expect(config.version).toBe(1);
    expect(config.severity.mappings).toHaveLength(10);
    expect(config.channels.critical).toBe('slack:D0AM0RZ7HB2');
  });

  it('returns default config for malformed file', () => {
    fs.writeFileSync(configPath, 'not json!!!');
    const config = readRoutingConfig(configPath);
    expect(config.version).toBe(1);
    expect(config.severity.default).toBe('critical');
  });

  it('returns default config for invalid structure', () => {
    fs.writeFileSync(configPath, JSON.stringify({ version: 'not a number' }));
    const config = readRoutingConfig(configPath);
    expect(config.version).toBe(1);
  });

  it('reads valid routing config', () => {
    const custom: RoutingConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      channels: {
        critical: 'slack:custom-dm',
        warning: 'slack:custom-dm',
        info: 'slack:custom-group',
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(custom));
    const config = readRoutingConfig(configPath);
    expect(config.channels.critical).toBe('slack:custom-dm');
    expect(config.channels.info).toBe('slack:custom-group');
  });

  it('severity mapping lookup works correctly', () => {
    const config = readRoutingConfig(configPath); // defaults
    const mapping = config.severity.mappings.find(
      m => m.alertType === 'state-transition' && m.toState === 'down',
    );
    expect(mapping).toBeDefined();
    expect(mapping!.severity).toBe('critical');
  });
});

// ─── Severity Classification (T4) ──────────────────────

describe('classifySeverity', () => {
  const config = DEFAULT_ROUTING_CONFIG;

  it('maps state-transition to down as critical', () => {
    expect(classifySeverity('state-transition', { toState: 'down' }, config)).toBe('critical');
  });

  it('maps state-transition to unreachable as critical', () => {
    expect(classifySeverity('state-transition', { toState: 'unreachable' }, config)).toBe('critical');
  });

  it('maps escalation as critical', () => {
    expect(classifySeverity('escalation', {}, config)).toBe('critical');
  });

  it('maps auto-fix-failed as critical', () => {
    expect(classifySeverity('auto-fix-failed', {}, config)).toBe('critical');
  });

  it('maps state-transition to degraded as warning', () => {
    expect(classifySeverity('state-transition', { toState: 'degraded' }, config)).toBe('warning');
  });

  it('maps proposal as warning', () => {
    expect(classifySeverity('proposal', {}, config)).toBe('warning');
  });

  it('maps crash-loop as warning', () => {
    expect(classifySeverity('crash-loop', {}, config)).toBe('warning');
  });

  it('maps recovery as info', () => {
    expect(classifySeverity('recovery', {}, config)).toBe('info');
  });

  it('maps auto-fix-success as info', () => {
    expect(classifySeverity('auto-fix-success', {}, config)).toBe('info');
  });

  it('maps daily-digest as info', () => {
    expect(classifySeverity('daily-digest', {}, config)).toBe('info');
  });

  it('defaults to critical for unknown alert type', () => {
    expect(classifySeverity('unknown-type', {}, config)).toBe('critical');
  });

  it('context-aware matching — toState field filters correctly', () => {
    // state-transition without matching toState should not match toState-specific mappings
    expect(classifySeverity('state-transition', { toState: 'healthy' }, config)).toBe('critical');
  });
});

// ─── Quiet Hours (T5) ───────────────────────────────────

describe('isQuietHours', () => {
  const baseConfig: QuietHoursConfig = {
    enabled: true,
    start: '23:00',
    end: '07:00',
    timezone: 'UTC',
    suppressedSeverities: ['info', 'warning'],
  };

  it('returns true when inside quiet hours (overnight, after start)', () => {
    // 23:30 UTC is inside 23:00-07:00
    const now = new Date('2026-03-15T23:30:00Z');
    expect(isQuietHours(baseConfig, now)).toBe(true);
  });

  it('returns true when inside quiet hours (overnight, before end)', () => {
    // 02:30 UTC is inside 23:00-07:00
    const now = new Date('2026-03-15T02:30:00Z');
    expect(isQuietHours(baseConfig, now)).toBe(true);
  });

  it('returns false when outside quiet hours', () => {
    // 12:00 UTC is outside 23:00-07:00
    const now = new Date('2026-03-15T12:00:00Z');
    expect(isQuietHours(baseConfig, now)).toBe(false);
  });

  it('handles same-day window (start < end)', () => {
    const daytimeConfig: QuietHoursConfig = {
      ...baseConfig,
      start: '09:00',
      end: '17:00',
    };
    const insideNow = new Date('2026-03-15T12:00:00Z');
    const outsideNow = new Date('2026-03-15T20:00:00Z');
    expect(isQuietHours(daytimeConfig, insideNow)).toBe(true);
    expect(isQuietHours(daytimeConfig, outsideNow)).toBe(false);
  });

  it('returns false when disabled', () => {
    const disabled = { ...baseConfig, enabled: false };
    const now = new Date('2026-03-15T02:00:00Z');
    expect(isQuietHours(disabled, now)).toBe(false);
  });
});

describe('shouldSuppress', () => {
  const config: QuietHoursConfig = {
    enabled: true,
    start: '23:00',
    end: '07:00',
    timezone: 'UTC',
    suppressedSeverities: ['info', 'warning'],
  };

  it('suppresses info during quiet hours', () => {
    const now = new Date('2026-03-15T02:00:00Z');
    expect(shouldSuppress('info', config, now)).toBe(true);
  });

  it('suppresses warning during quiet hours', () => {
    const now = new Date('2026-03-15T02:00:00Z');
    expect(shouldSuppress('warning', config, now)).toBe(true);
  });

  it('never suppresses critical', () => {
    const now = new Date('2026-03-15T02:00:00Z');
    expect(shouldSuppress('critical', config, now)).toBe(false);
  });

  it('does not suppress outside quiet hours', () => {
    const now = new Date('2026-03-15T12:00:00Z');
    expect(shouldSuppress('info', config, now)).toBe(false);
    expect(shouldSuppress('warning', config, now)).toBe(false);
  });

  it('does not suppress when quiet hours disabled', () => {
    const disabled = { ...config, enabled: false };
    const now = new Date('2026-03-15T02:00:00Z');
    expect(shouldSuppress('info', disabled, now)).toBe(false);
  });
});

// ─── Channel Routing (T6) ──────────────────────────────

describe('routeAlert', () => {
  const channels = DEFAULT_ROUTING_CONFIG.channels;

  it('routes critical to operator DM', () => {
    expect(routeAlert('critical', channels)).toBe('slack:D0AM0RZ7HB2');
  });

  it('routes warning to operator DM', () => {
    expect(routeAlert('warning', channels)).toBe('slack:D0AM0RZ7HB2');
  });

  it('routes info to group channel', () => {
    expect(routeAlert('info', channels)).toBe('slack:C0AJ4J9H9L1');
  });
});

describe('formatAlert', () => {
  const formatting = DEFAULT_ROUTING_CONFIG.formatting;
  const escalation = DEFAULT_ROUTING_CONFIG.escalation;

  it('formats critical with emoji and prefix', () => {
    const result = formatAlert('DB is down', 'critical', formatting);
    expect(result).toContain('CRITICAL');
    expect(result).toContain('DB is down');
  });

  it('formats warning with emoji and prefix', () => {
    const result = formatAlert('Nook is degraded', 'warning', formatting);
    expect(result).toContain('WARNING');
    expect(result).toContain('Nook is degraded');
  });

  it('formats info with emoji but no prefix', () => {
    const result = formatAlert('DB is back', 'info', formatting);
    expect(result).not.toContain('CRITICAL');
    expect(result).not.toContain('WARNING');
    expect(result).toContain('DB is back');
  });

  it('formats escalated alert with escalation prefix', () => {
    const result = formatAlert('DB has been down for 20 minutes', 'critical', formatting, true, escalation);
    expect(result).toContain('STILL UNRESOLVED');
    expect(result).toContain('DB has been down for 20 minutes');
  });
});

// ─── Escalation Logic (T7, T8) ─────────────────────────

describe('checkEscalations', () => {
  function makeHealthState(overrides: Record<string, Partial<BotHealthRecord>> = {}): HealthStateFile {
    const state = initializeHealthState();
    for (const [bot, fields] of Object.entries(overrides)) {
      if (state[bot]) {
        Object.assign(state[bot], fields);
      }
    }
    return state;
  }

  it('triggers escalation after window expires', () => {
    const now = new Date('2026-03-15T03:40:00Z');
    const state = makeHealthState({
      db: {
        lastCriticalAlertAt: '2026-03-15T03:22:00Z', // 18 min ago
        criticalAlertAcknowledged: false,
        escalationCount: 0,
        lastEscalationAt: null,
      },
    });
    const actions = checkEscalations(state, DEFAULT_ROUTING_CONFIG, now);
    expect(actions).toHaveLength(1);
    expect(actions[0].bot).toBe('db');
    expect(actions[0].elapsedMinutes).toBe(18);
  });

  it('does NOT trigger escalation before window expires', () => {
    const now = new Date('2026-03-15T03:30:00Z');
    const state = makeHealthState({
      db: {
        lastCriticalAlertAt: '2026-03-15T03:22:00Z', // 8 min ago
        criticalAlertAcknowledged: false,
        escalationCount: 0,
        lastEscalationAt: null,
      },
    });
    const actions = checkEscalations(state, DEFAULT_ROUTING_CONFIG, now);
    expect(actions).toHaveLength(0);
  });

  it('does NOT trigger escalation if acknowledged', () => {
    const now = new Date('2026-03-15T03:40:00Z');
    const state = makeHealthState({
      db: {
        lastCriticalAlertAt: '2026-03-15T03:22:00Z',
        criticalAlertAcknowledged: true,
        escalationCount: 0,
        lastEscalationAt: null,
      },
    });
    const actions = checkEscalations(state, DEFAULT_ROUTING_CONFIG, now);
    expect(actions).toHaveLength(0);
  });

  it('stops at max escalations', () => {
    const now = new Date('2026-03-15T04:30:00Z');
    const state = makeHealthState({
      db: {
        lastCriticalAlertAt: '2026-03-15T03:22:00Z',
        criticalAlertAcknowledged: false,
        escalationCount: 3, // max is 3
        lastEscalationAt: '2026-03-15T04:00:00Z',
      },
    });
    const actions = checkEscalations(state, DEFAULT_ROUTING_CONFIG, now);
    expect(actions).toHaveLength(0);
  });

  it('does not trigger when escalation is disabled', () => {
    const now = new Date('2026-03-15T03:40:00Z');
    const state = makeHealthState({
      db: {
        lastCriticalAlertAt: '2026-03-15T03:22:00Z',
        criticalAlertAcknowledged: false,
        escalationCount: 0,
        lastEscalationAt: null,
      },
    });
    const disabledConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      escalation: { ...DEFAULT_ROUTING_CONFIG.escalation, enabled: false },
    };
    const actions = checkEscalations(state, disabledConfig, now);
    expect(actions).toHaveLength(0);
  });
});

describe('escalation state management (T8)', () => {
  it('markCriticalAlert sets fields and resets escalation', () => {
    const state = initializeHealthState();
    state.db.escalationCount = 2;
    state.db.lastEscalationAt = '2026-03-15T03:00:00Z';
    markCriticalAlert('db', state, '2026-03-15T04:00:00Z');
    expect(state.db.lastCriticalAlertAt).toBe('2026-03-15T04:00:00Z');
    expect(state.db.criticalAlertAcknowledged).toBe(false);
    expect(state.db.escalationCount).toBe(0);
    expect(state.db.lastEscalationAt).toBeNull();
  });

  it('markEscalation increments count and sets timestamp', () => {
    const state = initializeHealthState();
    state.db.lastCriticalAlertAt = '2026-03-15T03:00:00Z';
    state.db.escalationCount = 0;
    markEscalation('db', state, '2026-03-15T03:15:00Z');
    expect(state.db.escalationCount).toBe(1);
    expect(state.db.lastEscalationAt).toBe('2026-03-15T03:15:00Z');
    markEscalation('db', state, '2026-03-15T03:30:00Z');
    expect(state.db.escalationCount).toBe(2);
    expect(state.db.lastEscalationAt).toBe('2026-03-15T03:30:00Z');
  });

  it('clearEscalation resets all escalation fields', () => {
    const state = initializeHealthState();
    state.db.lastCriticalAlertAt = '2026-03-15T03:00:00Z';
    state.db.criticalAlertAcknowledged = false;
    state.db.escalationCount = 2;
    state.db.lastEscalationAt = '2026-03-15T03:30:00Z';
    clearEscalation('db', state);
    expect(state.db.lastCriticalAlertAt).toBeNull();
    expect(state.db.criticalAlertAcknowledged).toBe(true);
    expect(state.db.escalationCount).toBe(0);
    expect(state.db.lastEscalationAt).toBeNull();
  });

  it('multiple bots are independent', () => {
    const state = initializeHealthState();
    markCriticalAlert('db', state, '2026-03-15T03:00:00Z');
    markCriticalAlert('nook', state, '2026-03-15T03:05:00Z');
    markEscalation('db', state, '2026-03-15T03:15:00Z');
    expect(state.db.escalationCount).toBe(1);
    expect(state.nook.escalationCount).toBe(0);
    clearEscalation('db', state);
    expect(state.db.lastCriticalAlertAt).toBeNull();
    expect(state.nook.lastCriticalAlertAt).toBe('2026-03-15T03:05:00Z');
  });
});
