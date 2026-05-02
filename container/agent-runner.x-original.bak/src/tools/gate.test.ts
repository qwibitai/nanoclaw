import { describe, it, expect } from 'vitest';
import {
  computeGateDecision,
  type Alert,
  type FleetAlert,
  type MaintenanceNotification,
  type HealthStateFile,
  type RoutingConfig,
  DEFAULT_ROUTING_CONFIG,
  initializeHealthState,
} from './watcher.js';

function emptyResult() {
  return {
    alerts: [] as Alert[],
    recoveries: [] as Alert[],
    fleetAlerts: [] as FleetAlert[],
    maintenanceNotifications: [] as MaintenanceNotification[],
  };
}

function healthyState(): HealthStateFile {
  const state = initializeHealthState();
  // Mark both bots as healthy
  state.db.state = 'healthy';
  state.db.previousState = 'healthy';
  state.nook.state = 'healthy';
  state.nook.previousState = 'healthy';
  return state;
}

describe('computeGateDecision', () => {
  // S26: All healthy, no transitions → skip
  it('returns skip when all healthy with no events', () => {
    const result = emptyResult();
    const state = healthyState();
    expect(computeGateDecision(result, state, null)).toBe('skip');
  });

  // S27: State transition → invoke
  it('returns invoke when alerts present', () => {
    const result = emptyResult();
    result.alerts.push({
      bot: 'db',
      from: 'healthy',
      to: 'down',
      message: 'DB is down',
      timestamp: new Date().toISOString(),
      consecutiveFailures: 2,
      crashLooping: false,
    } as Alert);
    const state = healthyState();
    expect(computeGateDecision(result, state, null)).toBe('invoke');
  });

  // Recovery → invoke
  it('returns invoke when recoveries present', () => {
    const result = emptyResult();
    result.recoveries.push({
      bot: 'db',
      from: 'down',
      to: 'healthy',
      message: 'DB recovered',
      timestamp: new Date().toISOString(),
      consecutiveFailures: 0,
      crashLooping: false,
    } as Alert);
    const state = healthyState();
    expect(computeGateDecision(result, state, null)).toBe('invoke');
  });

  // Fleet alert → invoke
  it('returns invoke when fleet alerts present', () => {
    const result = emptyResult();
    result.fleetAlerts.push({
      dependency: 'xps-network',
      affectedBots: ['db', 'nook'],
      message: 'Both bots unreachable',
    } as FleetAlert);
    const state = healthyState();
    expect(computeGateDecision(result, state, null)).toBe('invoke');
  });

  // Maintenance notification → invoke (S31)
  it('returns invoke when maintenance notifications present', () => {
    const result = emptyResult();
    result.maintenanceNotifications.push({
      bot: 'nook',
      type: 'expiring-soon',
      message: 'Nook maintenance expires in 3 min',
    });
    const state = healthyState();
    expect(computeGateDecision(result, state, null)).toBe('invoke');
  });

  // Pending escalation → invoke
  it('returns invoke when escalation is pending', () => {
    const result = emptyResult();
    const state = healthyState();
    // Simulate a pending critical alert for DB (unacknowledged, sent 20 min ago)
    state.db.state = 'down';
    state.db.lastCriticalAlertAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    state.db.criticalAlertAcknowledged = false;
    state.db.escalationCount = 0;
    state.db.lastEscalationAt = null;

    const routing: RoutingConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      escalation: {
        enabled: true,
        windowMinutes: 15,
        maxEscalations: 3,
        escalatedFormatting: { emoji: '🚨', prefix: 'STILL UNRESOLVED' },
      },
    };
    expect(computeGateDecision(result, state, routing)).toBe('invoke');
  });

  // Escalation disabled + no events → skip
  it('returns skip when escalation disabled and no events', () => {
    const result = emptyResult();
    const state = healthyState();
    const routing: RoutingConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      escalation: { ...DEFAULT_ROUTING_CONFIG.escalation, enabled: false },
    };
    expect(computeGateDecision(result, state, routing)).toBe('skip');
  });

  // No routing config (null) → skip if no events
  it('returns skip with null routing config and no events', () => {
    const result = emptyResult();
    const state = healthyState();
    expect(computeGateDecision(result, state, null)).toBe('skip');
  });
});
