// Tests for cross-bot coordination: dependency map, maintenance mode,
// alert correlation, fleet status, coordinated diagnostics, and policy integration.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  readDependencies,
  DEFAULT_DEPENDENCY_MAP,
  filterMaintenanceMode,
  correlateAlerts,
  computeFleetStatus,
  runCoordinatedDiagnostics,
  formatDiagnosticSummary,
  setMaintenanceMode,
  clearMaintenanceMode,
  getMaintenanceStatus,
  readHealthState,
  writeHealthState,
  initializeHealthState,
  getBotRecords,
  getFleetState,
  isBotHealthRecord,
  isFleetState,
  type HealthStateFile,
  type BotHealthRecord,
  type FleetState,
  type Alert,
  type DependencyMap,
  type DiagnosticConfig,
  type PingResult,
  type MaintenanceMode,
} from './watcher.js';

import {
  evaluatePolicy,
  DEFAULT_POLICIES,
  DEFAULT_POLICY_CONFIG,
  type PolicyRule,
  type ActionLogEntry,
} from './policy.js';

// ─── Helpers ────────────────────────────────────────────

function makeBotHealth(overrides: Partial<BotHealthRecord> = {}): BotHealthRecord {
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
    maintenance: null,
    ...overrides,
  };
}

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    bot: 'db',
    type: 'alert',
    from: 'healthy',
    to: 'unreachable',
    message: 'DB is unreachable (was healthy)',
    suggestedAction: 'Check SSH connectivity',
    ...overrides,
  };
}

function makeHealthState(bots: Record<string, Partial<BotHealthRecord>> = {}): HealthStateFile {
  const state = initializeHealthState();
  for (const [bot, fields] of Object.entries(bots)) {
    const record = state[bot];
    if (record && isBotHealthRecord(record)) {
      Object.assign(record, fields);
    }
  }
  return state;
}

// ─── T1: Dependency Map Types & Loading ─────────────────

describe('readDependencies', () => {
  let tmpDir: string;
  let depPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-test-'));
    depPath = path.join(tmpDir, 'dependencies.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty map for missing file', () => {
    const deps = readDependencies(depPath);
    expect(deps.dependencies).toEqual([]);
  });

  it('returns empty map for corrupt file', () => {
    fs.writeFileSync(depPath, 'not json!!!');
    const deps = readDependencies(depPath);
    expect(deps.dependencies).toEqual([]);
  });

  it('returns empty map for non-object JSON', () => {
    fs.writeFileSync(depPath, '"just a string"');
    const deps = readDependencies(depPath);
    expect(deps.dependencies).toEqual([]);
  });

  it('returns empty map if dependencies is not an array', () => {
    fs.writeFileSync(depPath, JSON.stringify({ dependencies: 'not array' }));
    const deps = readDependencies(depPath);
    expect(deps.dependencies).toEqual([]);
  });

  it('reads valid dependency map', () => {
    fs.writeFileSync(depPath, JSON.stringify(DEFAULT_DEPENDENCY_MAP));
    const deps = readDependencies(depPath);
    expect(deps.dependencies).toHaveLength(2);
    expect(deps.dependencies[0].id).toBe('xps-network');
    expect(deps.dependencies[0].bots).toEqual(['db', 'nook']);
    expect(deps.dependencies[1].id).toBe('home-wifi');
    expect(deps.dependencies[1].bots).toEqual(['nook']);
  });

  it('skips invalid entries and keeps valid ones', () => {
    const mixed = {
      dependencies: [
        DEFAULT_DEPENDENCY_MAP.dependencies[0],
        { id: 'bad', name: 'bad' }, // missing required fields
        DEFAULT_DEPENDENCY_MAP.dependencies[1],
      ],
    };
    fs.writeFileSync(depPath, JSON.stringify(mixed));
    const deps = readDependencies(depPath);
    expect(deps.dependencies).toHaveLength(2);
    expect(deps.dependencies[0].id).toBe('xps-network');
    expect(deps.dependencies[1].id).toBe('home-wifi');
  });

  it('rejects dependency with empty bots array', () => {
    const bad = {
      dependencies: [{
        id: 'empty',
        name: 'Empty',
        description: 'No bots',
        bots: [],
        diagnostics: {},
      }],
    };
    fs.writeFileSync(depPath, JSON.stringify(bad));
    const deps = readDependencies(depPath);
    expect(deps.dependencies).toEqual([]);
  });
});

// ─── T2: Health State Extensions ────────────────────────

describe('health state maintenance mode fields', () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-test-'));
    statePath = path.join(tmpDir, 'health-state.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('default initialization includes maintenance: null', () => {
    const state = initializeHealthState();
    const botRecords = getBotRecords(state);
    expect(botRecords.db.maintenance).toBeNull();
    expect(botRecords.nook.maintenance).toBeNull();
  });

  it('default initialization includes fleet state', () => {
    const state = initializeHealthState();
    const fleet = getFleetState(state);
    expect(fleet).not.toBeNull();
    expect(fleet!.status).toBe('all-healthy');
    expect(fleet!.lastCorrelatedEvent).toBeNull();
  });

  it('backfills maintenance field on old state files', () => {
    const oldState = {
      db: {
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
        // Missing: maintenance
      },
    };
    fs.writeFileSync(statePath, JSON.stringify(oldState));
    const state = readHealthState(statePath);
    const botRecords = getBotRecords(state);
    expect(botRecords.db.maintenance).toBeNull();
  });

  it('backfills fleet state on old state files', () => {
    const oldState = {
      db: makeBotHealth({ state: 'healthy' }),
    };
    // Remove maintenance to simulate truly old file
    delete (oldState.db as any).maintenance;
    fs.writeFileSync(statePath, JSON.stringify(oldState));
    const state = readHealthState(statePath);
    const fleet = getFleetState(state);
    expect(fleet).not.toBeNull();
    expect(fleet!.status).toBe('all-healthy');
  });

  it('persists maintenance mode through write/read cycle', () => {
    const state = initializeHealthState();
    const bots = getBotRecords(state);
    bots.db.maintenance = {
      enabled: true,
      reason: 'Testing',
      startedAt: '2026-03-15T14:00:00Z',
      expiresAt: '2026-03-15T15:00:00Z',
    };
    writeHealthState(statePath, state);
    const read = readHealthState(statePath);
    const readBots = getBotRecords(read);
    expect(readBots.db.maintenance).not.toBeNull();
    expect(readBots.db.maintenance!.reason).toBe('Testing');
    expect(readBots.db.maintenance!.expiresAt).toBe('2026-03-15T15:00:00Z');
  });

  it('persists fleet state through write/read cycle', () => {
    const state = initializeHealthState();
    const fleet = getFleetState(state)!;
    fleet.status = 'partial-degraded';
    fleet.lastCorrelatedEvent = '2026-03-15T03:15:00Z';
    writeHealthState(statePath, state);
    const read = readHealthState(statePath);
    const readFleet = getFleetState(read)!;
    expect(readFleet.status).toBe('partial-degraded');
    expect(readFleet.lastCorrelatedEvent).toBe('2026-03-15T03:15:00Z');
  });

  it('type guards work correctly', () => {
    const state = initializeHealthState();
    expect(isBotHealthRecord(state.db as any)).toBe(true);
    expect(isFleetState(state.db as any)).toBe(false);
    expect(isBotHealthRecord(state.fleet as any)).toBe(false);
    expect(isFleetState(state.fleet as any)).toBe(true);
  });
});

// ─── T3: Maintenance Mode Set/Clear/Status ──────────────

describe('maintenance mode operations', () => {
  it('set maintenance mode for a specific bot', () => {
    const state = makeHealthState();
    const now = new Date('2026-03-15T14:00:00Z');
    const result = setMaintenanceMode(state, 'db', 30, 'Restarting EC2', now);
    const bots = getBotRecords(state);
    expect(result).toContain('DB');
    expect(result).toContain('30 min');
    expect(bots.db.maintenance).not.toBeNull();
    expect(bots.db.maintenance!.enabled).toBe(true);
    expect(bots.db.maintenance!.reason).toBe('Restarting EC2');
    expect(bots.db.maintenance!.expiresAt).toBe('2026-03-15T14:30:00.000Z');
    expect(bots.nook.maintenance).toBeNull(); // Not affected
  });

  it('set fleet-wide maintenance mode', () => {
    const state = makeHealthState();
    const now = new Date('2026-03-15T14:00:00Z');
    const result = setMaintenanceMode(state, undefined, 60, 'Network maintenance', now);
    const bots = getBotRecords(state);
    expect(result).toContain('all bots');
    expect(bots.db.maintenance).not.toBeNull();
    expect(bots.nook.maintenance).not.toBeNull();
    expect(bots.db.maintenance!.expiresAt).toBe('2026-03-15T15:00:00.000Z');
  });

  it('default duration is 60 minutes', () => {
    const state = makeHealthState();
    const now = new Date('2026-03-15T14:00:00Z');
    setMaintenanceMode(state, 'db', undefined, '', now);
    const bots = getBotRecords(state);
    expect(bots.db.maintenance!.expiresAt).toBe('2026-03-15T15:00:00.000Z');
  });

  it('returns error for unknown bot', () => {
    const state = makeHealthState();
    const result = setMaintenanceMode(state, 'unknown_bot');
    expect(result).toContain('Error');
    expect(result).toContain('unknown_bot');
  });

  it('clear maintenance mode for a specific bot', () => {
    const state = makeHealthState({ db: { maintenance: { enabled: true, reason: 'test', startedAt: '2026-03-15T14:00:00Z', expiresAt: '2026-03-15T15:00:00Z' } } });
    const result = clearMaintenanceMode(state, 'db');
    const bots = getBotRecords(state);
    expect(result).toContain('DB');
    expect(result).toContain('cleared');
    expect(bots.db.maintenance).toBeNull();
  });

  it('clear fleet-wide maintenance mode', () => {
    const state = makeHealthState({
      db: { maintenance: { enabled: true, reason: 'test', startedAt: 'x', expiresAt: 'y' } },
      nook: { maintenance: { enabled: true, reason: 'test', startedAt: 'x', expiresAt: 'y' } },
    });
    clearMaintenanceMode(state, undefined);
    const bots = getBotRecords(state);
    expect(bots.db.maintenance).toBeNull();
    expect(bots.nook.maintenance).toBeNull();
  });

  it('get maintenance status with active maintenance', () => {
    const now = new Date('2026-03-15T14:30:00Z');
    const state = makeHealthState({
      db: { maintenance: { enabled: true, reason: 'Restart', startedAt: '2026-03-15T14:00:00Z', expiresAt: '2026-03-15T15:00:00Z' } },
    });
    const result = getMaintenanceStatus(state, now);
    expect(result).toContain('DB');
    expect(result).toContain('30 min remaining');
    expect(result).toContain('Restart');
    expect(result).toContain('Nook');
    expect(result).toContain('normal monitoring');
  });

  it('get maintenance status with no active maintenance', () => {
    const state = makeHealthState();
    const result = getMaintenanceStatus(state);
    expect(result).toContain('No active maintenance');
  });

  it('get maintenance status shows expired', () => {
    const now = new Date('2026-03-15T16:00:00Z');
    const state = makeHealthState({
      db: { maintenance: { enabled: true, reason: 'old', startedAt: '2026-03-15T14:00:00Z', expiresAt: '2026-03-15T15:00:00Z' } },
    });
    const result = getMaintenanceStatus(state, now);
    expect(result).toContain('EXPIRED');
  });
});

// ─── T4: Alert Correlation ──────────────────────────────

describe('correlateAlerts', () => {
  const deps = DEFAULT_DEPENDENCY_MAP;

  it('correlates when all bots on shared dependency are unreachable', () => {
    const alerts: Alert[] = [
      makeAlert({ bot: 'db', to: 'unreachable' }),
      makeAlert({ bot: 'nook', to: 'unreachable' }),
    ];
    const { individualAlerts, fleetAlerts } = correlateAlerts(alerts, deps);
    expect(fleetAlerts).toHaveLength(1);
    expect(fleetAlerts[0].type).toBe('correlated');
    expect(fleetAlerts[0].dependency).toBe('xps-network');
    expect(fleetAlerts[0].affectedBots).toEqual(['db', 'nook']);
    expect(individualAlerts).toHaveLength(0);
  });

  it('does NOT correlate when only one bot is unreachable', () => {
    const alerts: Alert[] = [
      makeAlert({ bot: 'nook', to: 'unreachable' }),
    ];
    const { individualAlerts, fleetAlerts } = correlateAlerts(alerts, deps);
    expect(fleetAlerts).toHaveLength(0);
    expect(individualAlerts).toHaveLength(1);
    expect(individualAlerts[0].bot).toBe('nook');
  });

  it('does NOT correlate non-unreachable states', () => {
    const alerts: Alert[] = [
      makeAlert({ bot: 'db', to: 'down' }),
      makeAlert({ bot: 'nook', to: 'down' }),
    ];
    const { individualAlerts, fleetAlerts } = correlateAlerts(alerts, deps);
    expect(fleetAlerts).toHaveLength(0);
    expect(individualAlerts).toHaveLength(2);
  });

  it('passes through all alerts with empty dependency map', () => {
    const alerts: Alert[] = [
      makeAlert({ bot: 'db', to: 'unreachable' }),
      makeAlert({ bot: 'nook', to: 'unreachable' }),
    ];
    const { individualAlerts, fleetAlerts } = correlateAlerts(alerts, { dependencies: [] });
    expect(fleetAlerts).toHaveLength(0);
    expect(individualAlerts).toHaveLength(2);
  });

  it('does not correlate single-bot dependencies', () => {
    const singleBotDeps: DependencyMap = {
      dependencies: [{
        id: 'single',
        name: 'Single Bot Dep',
        description: 'Only one bot',
        bots: ['nook'],
        diagnostics: { pingHosts: ['192.168.68.62'] },
      }],
    };
    const alerts: Alert[] = [
      makeAlert({ bot: 'nook', to: 'unreachable' }),
    ];
    const { individualAlerts, fleetAlerts } = correlateAlerts(alerts, singleBotDeps);
    expect(fleetAlerts).toHaveLength(0);
    expect(individualAlerts).toHaveLength(1);
  });

  it('fleet alert includes hypothesis message', () => {
    const alerts: Alert[] = [
      makeAlert({ bot: 'db', to: 'unreachable' }),
      makeAlert({ bot: 'nook', to: 'unreachable' }),
    ];
    const { fleetAlerts } = correlateAlerts(alerts, deps);
    expect(fleetAlerts[0].hypothesis).toContain('XPS network connectivity');
    expect(fleetAlerts[0].hypothesis).toContain('infrastructure issue');
  });
});

// ─── T5: Maintenance Mode Filter ────────────────────────

describe('filterMaintenanceMode', () => {
  it('suppresses alerts for bots in active maintenance', () => {
    const now = new Date('2026-03-15T14:15:00Z');
    const state = makeHealthState({
      db: { maintenance: { enabled: true, reason: 'test', startedAt: '2026-03-15T14:00:00Z', expiresAt: '2026-03-15T15:00:00Z' } },
    });
    const alerts: Alert[] = [
      makeAlert({ bot: 'db', to: 'unreachable' }),
      makeAlert({ bot: 'nook', to: 'down' }),
    ];
    const { filteredAlerts, notifications } = filterMaintenanceMode(alerts, state, now);
    expect(filteredAlerts).toHaveLength(1);
    expect(filteredAlerts[0].bot).toBe('nook');
    expect(notifications).toHaveLength(0);
  });

  it('auto-clears expired maintenance and sends notification', () => {
    const now = new Date('2026-03-15T15:05:00Z');
    const state = makeHealthState({
      db: { maintenance: { enabled: true, reason: 'test', startedAt: '2026-03-15T14:00:00Z', expiresAt: '2026-03-15T15:00:00Z' } },
    });
    const alerts: Alert[] = [
      makeAlert({ bot: 'db', to: 'unreachable' }),
    ];
    const { filteredAlerts, notifications } = filterMaintenanceMode(alerts, state, now);
    // After auto-clear, the alert should NOT be suppressed
    expect(filteredAlerts).toHaveLength(1);
    expect(filteredAlerts[0].bot).toBe('db');
    // Should have auto-clear notification
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('expired');
    expect(notifications[0].message).toContain('expired');
    expect(notifications[0].message).toContain('Resuming monitoring');
    // Maintenance should be cleared
    const bots = getBotRecords(state);
    expect(bots.db.maintenance).toBeNull();
  });

  it('sends reminder when within 5 minutes of expiry', () => {
    const now = new Date('2026-03-15T14:56:00Z'); // 4 min before expiry
    const state = makeHealthState({
      db: { maintenance: { enabled: true, reason: 'test', startedAt: '2026-03-15T14:00:00Z', expiresAt: '2026-03-15T15:00:00Z' } },
    });
    const alerts: Alert[] = [];
    const { notifications } = filterMaintenanceMode(alerts, state, now);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('expiring-soon');
    expect(notifications[0].message).toContain('expires in');
    // Maintenance should still be active
    const bots = getBotRecords(state);
    expect(bots.db.maintenance).not.toBeNull();
  });

  it('does not send reminder when more than 5 minutes from expiry', () => {
    const now = new Date('2026-03-15T14:30:00Z'); // 30 min before expiry
    const state = makeHealthState({
      db: { maintenance: { enabled: true, reason: 'test', startedAt: '2026-03-15T14:00:00Z', expiresAt: '2026-03-15T15:00:00Z' } },
    });
    const { notifications } = filterMaintenanceMode([], state, now);
    expect(notifications).toHaveLength(0);
  });

  it('passes through alerts for bots not in maintenance', () => {
    const state = makeHealthState();
    const alerts: Alert[] = [
      makeAlert({ bot: 'db', to: 'down' }),
      makeAlert({ bot: 'nook', to: 'unreachable' }),
    ];
    const { filteredAlerts } = filterMaintenanceMode(alerts, state);
    expect(filteredAlerts).toHaveLength(2);
  });
});

// ─── T6: Fleet Status Computation ──────────────────────

describe('computeFleetStatus', () => {
  it('returns all-healthy when all active bots are healthy', () => {
    const state = makeHealthState({ db: { state: 'healthy' }, nook: { state: 'healthy' } });
    expect(computeFleetStatus(state)).toBe('all-healthy');
  });

  it('returns partial-degraded when some bots are unhealthy', () => {
    const state = makeHealthState({ db: { state: 'healthy' }, nook: { state: 'down' } });
    expect(computeFleetStatus(state)).toBe('partial-degraded');
  });

  it('returns fleet-down when all active bots are down/unreachable', () => {
    const state = makeHealthState({ db: { state: 'down' }, nook: { state: 'unreachable' } });
    expect(computeFleetStatus(state)).toBe('fleet-down');
  });

  it('returns maintenance when all bots are in maintenance mode', () => {
    const maint: MaintenanceMode = { enabled: true, reason: 'test', startedAt: 'x', expiresAt: 'y' };
    const state = makeHealthState({
      db: { maintenance: maint },
      nook: { maintenance: maint },
    });
    expect(computeFleetStatus(state)).toBe('maintenance');
  });

  it('excludes bots in maintenance from computation', () => {
    const maint: MaintenanceMode = { enabled: true, reason: 'test', startedAt: 'x', expiresAt: 'y' };
    const state = makeHealthState({
      db: { state: 'down', maintenance: maint },
      nook: { state: 'healthy' },
    });
    // DB is in maintenance, so only Nook counts — Nook is healthy
    expect(computeFleetStatus(state)).toBe('all-healthy');
  });

  it('degraded state counts as unhealthy', () => {
    const state = makeHealthState({ db: { state: 'healthy' }, nook: { state: 'degraded' } });
    expect(computeFleetStatus(state)).toBe('partial-degraded');
  });
});

// ─── T7: Coordinated Diagnostics ───────────────────────

describe('runCoordinatedDiagnostics', () => {
  // Mock functions to avoid real network calls
  const okPing = (host: string, _timeout: number): PingResult => ({ host, ok: true });
  const failPing = (host: string, _timeout: number): PingResult => ({ host, ok: false });
  const okDns = (_hostname: string, _timeout: number) => true;
  const failDns = (_hostname: string, _timeout: number) => false;
  const okGateway = (_timeout: number) => true;
  const failGateway = (_timeout: number) => false;

  it('runs all diagnostic checks when configured', () => {
    const config: DiagnosticConfig = {
      pingHosts: ['1.2.3.4', '5.6.7.8'],
      dnsCheck: 'google.com',
      gatewayCheck: true,
    };
    const results = runCoordinatedDiagnostics(config, {
      pingFn: okPing,
      dnsFn: okDns,
      gatewayFn: okGateway,
    });
    expect(results.pingResults).toHaveLength(2);
    expect(results.pingResults[0].ok).toBe(true);
    expect(results.pingResults[1].ok).toBe(true);
    expect(results.dnsOk).toBe(true);
    expect(results.gatewayOk).toBe(true);
    expect(results.summary).toContain('XPS network OK');
  });

  it('reports all failures when network is down', () => {
    const config: DiagnosticConfig = {
      pingHosts: ['1.2.3.4', '5.6.7.8'],
      dnsCheck: 'google.com',
      gatewayCheck: true,
    };
    const results = runCoordinatedDiagnostics(config, {
      pingFn: failPing,
      dnsFn: failDns,
      gatewayFn: failGateway,
    });
    expect(results.pingResults.every(r => !r.ok)).toBe(true);
    expect(results.dnsOk).toBe(false);
    expect(results.gatewayOk).toBe(false);
    expect(results.summary).toContain('no internet connectivity');
  });

  it('handles partial failures', () => {
    const config: DiagnosticConfig = {
      pingHosts: ['1.2.3.4', '5.6.7.8'],
      dnsCheck: 'google.com',
    };
    const mixedPing = (host: string, _timeout: number): PingResult =>
      host === '1.2.3.4' ? { host, ok: true } : { host, ok: false };
    const results = runCoordinatedDiagnostics(config, {
      pingFn: mixedPing,
      dnsFn: okDns,
    });
    expect(results.summary).toContain('host-specific');
  });

  it('returns null for unchecked diagnostics', () => {
    const config: DiagnosticConfig = {
      pingHosts: ['1.2.3.4'],
      // No dnsCheck, no gatewayCheck
    };
    const results = runCoordinatedDiagnostics(config, { pingFn: okPing });
    expect(results.dnsOk).toBeNull();
    expect(results.gatewayOk).toBeNull();
  });

  it('handles empty diagnostics config', () => {
    const config: DiagnosticConfig = {};
    const results = runCoordinatedDiagnostics(config);
    expect(results.pingResults).toHaveLength(0);
    expect(results.dnsOk).toBeNull();
    expect(results.gatewayOk).toBeNull();
  });
});

describe('formatDiagnosticSummary', () => {
  it('formats all failed diagnostics', () => {
    const summary = formatDiagnosticSummary(
      [{ host: '1.2.3.4', ok: false }, { host: '5.6.7.8', ok: false }],
      false,
      false,
    );
    expect(summary).toContain('Ping to 1.2.3.4: failed');
    expect(summary).toContain('Ping to 5.6.7.8: failed');
    expect(summary).toContain('DNS: failed');
    expect(summary).toContain('Gateway: failed');
    expect(summary).toContain('no internet connectivity');
  });

  it('formats all OK diagnostics', () => {
    const summary = formatDiagnosticSummary(
      [{ host: '1.2.3.4', ok: true }],
      true,
      true,
    );
    expect(summary).toContain('Ping to 1.2.3.4: ok');
    expect(summary).toContain('DNS: ok');
    expect(summary).toContain('Gateway: ok');
    expect(summary).toContain('XPS network OK');
  });
});

// ─── T8: Diagnostics in Fleet Alert Format ──────────────

describe('fleet alert with diagnostics', () => {
  it('fleet alert message includes diagnostic summary', () => {
    const alerts: Alert[] = [
      makeAlert({ bot: 'db', to: 'unreachable' }),
      makeAlert({ bot: 'nook', to: 'unreachable' }),
    ];
    const deps = DEFAULT_DEPENDENCY_MAP;
    const { fleetAlerts } = correlateAlerts(alerts, deps);
    expect(fleetAlerts).toHaveLength(1);

    // Simulate adding diagnostics (as watcherCheck would)
    const fa = fleetAlerts[0];
    const diagResults = runCoordinatedDiagnostics(deps.dependencies[0].diagnostics, {
      pingFn: (h, _t) => ({ host: h, ok: false }),
      dnsFn: () => false,
      gatewayFn: () => false,
    });
    fa.diagnosticResults = diagResults;
    fa.message += ` Network self-check: ${diagResults.summary}`;

    expect(fa.diagnosticResults.pingResults).toHaveLength(2);
    expect(fa.message).toContain('Network self-check');
    expect(fa.message).toContain('no internet connectivity');
  });
});

// ─── T11: Policy Evaluation for Fleet Alerts ────────────

describe('policy evaluation for fleet alerts', () => {
  it('matches fleet-unreachable-alert rule for correlated events', () => {
    const record = makeBotHealth({ state: 'unreachable', consecutiveFailures: 0 });
    const decision = evaluatePolicy(
      'fleet', 'healthy', 'unreachable', record, DEFAULT_POLICIES,
      DEFAULT_POLICY_CONFIG, new Date(),
      { correlated: true, affectedBots: ['db', 'nook'], dependency: 'xps-network' },
    );
    expect(decision.ruleId).toBe('fleet-unreachable-alert');
    expect(decision.response).toBe('alert-only');
    expect(decision.message).toContain('Fleet');
    expect(decision.message).toContain('infrastructure issue');
  });

  it('non-correlated unreachable does NOT match fleet rule', () => {
    const record = makeBotHealth({ state: 'unreachable', consecutiveFailures: 2 });
    const decision = evaluatePolicy(
      'db', 'healthy', 'unreachable', record, DEFAULT_POLICIES,
    );
    expect(decision.ruleId).toBe('unreachable-alert');
    // Should match the regular unreachable-alert, not fleet-unreachable-alert
    expect(decision.response).toBe('alert-only');
  });

  it('correlated event does not match non-correlated rules', () => {
    // Only fleet-unreachable-alert has context.correlated=true
    const record = makeBotHealth({ state: 'unreachable' });
    const decision = evaluatePolicy(
      'fleet', 'healthy', 'unreachable', record, DEFAULT_POLICIES,
      DEFAULT_POLICY_CONFIG, new Date(),
      { correlated: true, affectedBots: ['db', 'nook'] },
    );
    // It should match fleet-unreachable-alert, NOT the regular unreachable-alert
    expect(decision.ruleId).toBe('fleet-unreachable-alert');
  });

  it('no rule matched for fleet alert returns alert-only with fleet message', () => {
    const record = makeBotHealth({ state: 'down' });
    const decision = evaluatePolicy(
      'fleet', 'healthy', 'down', record, [],
      DEFAULT_POLICY_CONFIG, new Date(),
      { correlated: true, affectedBots: ['db', 'nook'], dependency: 'xps-network' },
    );
    expect(decision.ruleId).toBeNull();
    expect(decision.response).toBe('alert-only');
    expect(decision.message).toContain('Fleet');
    expect(decision.message).toContain('No policy rule matched');
  });
});

// ─── S15: Maintenance mode prevents false correlation ───

describe('S15: maintenance mode prevents false correlation', () => {
  it('bot in maintenance is filtered before correlation', () => {
    const now = new Date('2026-03-15T14:15:00Z');
    const maint: MaintenanceMode = {
      enabled: true, reason: 'EC2 restart',
      startedAt: '2026-03-15T14:00:00Z', expiresAt: '2026-03-15T15:00:00Z',
    };
    const state = makeHealthState({
      db: { state: 'unreachable', maintenance: maint },
      nook: { state: 'unreachable' },
    });

    // Both bots alert
    const alerts: Alert[] = [
      makeAlert({ bot: 'db', to: 'unreachable' }),
      makeAlert({ bot: 'nook', to: 'unreachable' }),
    ];

    // Step 1: Filter maintenance
    const { filteredAlerts } = filterMaintenanceMode(alerts, state, now);
    expect(filteredAlerts).toHaveLength(1);
    expect(filteredAlerts[0].bot).toBe('nook');

    // Step 2: Correlate — only nook's alert remains, no correlation possible
    const { individualAlerts, fleetAlerts } = correlateAlerts(filteredAlerts, DEFAULT_DEPENDENCY_MAP);
    expect(fleetAlerts).toHaveLength(0);
    expect(individualAlerts).toHaveLength(1);
    expect(individualAlerts[0].bot).toBe('nook');
  });
});
