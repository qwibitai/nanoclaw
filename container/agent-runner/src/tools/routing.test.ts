// Integration-style tests for the full alerting routing pipeline.
// Tests combinations of severity classification, quiet hours, routing, and escalation.

import { describe, it, expect } from 'vitest';

import {
  classifySeverity,
  shouldSuppress,
  routeAlert,
  formatAlert,
  checkEscalations,
  markCriticalAlert,
  markEscalation,
  clearEscalation,
  initializeHealthState,
  DEFAULT_ROUTING_CONFIG,
  type RoutingConfig,
  type SeverityLevel,
} from './watcher.js';
import type { ActionLogEntry, RoutingMetadata } from './policy.js';

// ─── Full Routing Pipeline ──────────────────────────────

describe('full routing pipeline', () => {
  const config = DEFAULT_ROUTING_CONFIG;

  it('S9: critical alert routes to operator DM with formatting', () => {
    // DB container goes down
    const severity = classifySeverity('state-transition', { toState: 'down' }, config);
    expect(severity).toBe('critical');

    const channel = routeAlert(severity, config.channels);
    expect(channel).toBe('slack:D0AM0RZ7HB2');

    const message = formatAlert('DB is down (was healthy)', severity, config.formatting);
    expect(message).toContain('CRITICAL');
    expect(message).toContain('DB is down');

    // Should NOT be suppressed even during quiet hours
    const suppressed = shouldSuppress(severity, config.quietHours, new Date('2026-03-15T02:00:00Z'));
    expect(suppressed).toBe(false);
  });

  it('S10: recovery routes to group channel as info', () => {
    const severity = classifySeverity('recovery', {}, config);
    expect(severity).toBe('info');

    const channel = routeAlert(severity, config.channels);
    expect(channel).toBe('slack:C0AJ4J9H9L1');

    const message = formatAlert('DB is back (was down)', severity, config.formatting);
    expect(message).not.toContain('CRITICAL');
    expect(message).toContain('DB is back');
  });

  it('S11: warning suppressed during quiet hours', () => {
    const severity = classifySeverity('state-transition', { toState: 'degraded' }, config);
    expect(severity).toBe('warning');

    // At 02:30 UTC (which would be quiet hours if timezone were UTC)
    const quietConfig = { ...config.quietHours, timezone: 'UTC' };
    const suppressed = shouldSuppress(severity, quietConfig, new Date('2026-03-15T02:30:00Z'));
    expect(suppressed).toBe(true);

    // The channel it WOULD have gone to
    const channel = routeAlert(severity, config.channels);
    expect(channel).toBe('slack:D0AM0RZ7HB2');
  });

  it('S12: critical NOT suppressed during quiet hours', () => {
    const severity = classifySeverity('state-transition', { toState: 'down' }, config);
    expect(severity).toBe('critical');

    const quietConfig = { ...config.quietHours, timezone: 'UTC' };
    const suppressed = shouldSuppress(severity, quietConfig, new Date('2026-03-15T03:00:00Z'));
    expect(suppressed).toBe(false);
  });

  it('S13: escalation after no response', () => {
    const state = initializeHealthState();

    // Critical alert sent 20 minutes ago
    markCriticalAlert('db', state, '2026-03-15T03:00:00Z');
    state.db.state = 'down';

    const now = new Date('2026-03-15T03:20:00Z');
    const actions = checkEscalations(state, config, now);
    expect(actions).toHaveLength(1);
    expect(actions[0].bot).toBe('db');
    expect(actions[0].elapsedMinutes).toBe(20);

    // Apply escalation
    markEscalation('db', state, now.toISOString());
    expect(state.db.escalationCount).toBe(1);

    // Format escalated message
    const message = formatAlert(
      'DB has been down for 20 minutes with no response',
      'critical',
      config.formatting,
      true,
      config.escalation,
    );
    expect(message).toContain('STILL UNRESOLVED');
  });

  it('S14: escalation stops after max attempts', () => {
    const state = initializeHealthState();
    markCriticalAlert('db', state, '2026-03-15T03:00:00Z');
    state.db.state = 'down';

    // Simulate 3 escalations
    markEscalation('db', state, '2026-03-15T03:15:00Z');
    markEscalation('db', state, '2026-03-15T03:30:00Z');
    markEscalation('db', state, '2026-03-15T03:45:00Z');
    expect(state.db.escalationCount).toBe(3);

    const now = new Date('2026-03-15T04:00:00Z');
    const actions = checkEscalations(state, config, now);
    expect(actions).toHaveLength(0); // max reached
  });

  it('S15: recovery clears escalation state', () => {
    const state = initializeHealthState();
    markCriticalAlert('db', state, '2026-03-15T03:00:00Z');
    markEscalation('db', state, '2026-03-15T03:15:00Z');
    markEscalation('db', state, '2026-03-15T03:30:00Z');

    // Recovery
    clearEscalation('db', state);
    expect(state.db.lastCriticalAlertAt).toBeNull();
    expect(state.db.criticalAlertAcknowledged).toBe(true);
    expect(state.db.escalationCount).toBe(0);

    // Should not trigger escalation anymore
    const now = new Date('2026-03-15T04:00:00Z');
    const actions = checkEscalations(state, config, now);
    expect(actions).toHaveLength(0);
  });

  it('daily digest classified as info and routes to group', () => {
    const severity = classifySeverity('daily-digest', {}, config);
    expect(severity).toBe('info');
    const channel = routeAlert(severity, config.channels);
    expect(channel).toBe('slack:C0AJ4J9H9L1');
  });

  it('auto-fix-success routes to group as info', () => {
    const severity = classifySeverity('auto-fix-success', {}, config);
    expect(severity).toBe('info');
    const channel = routeAlert(severity, config.channels);
    expect(channel).toBe('slack:C0AJ4J9H9L1');
  });

  it('auto-fix-failed routes to DM as critical', () => {
    const severity = classifySeverity('auto-fix-failed', {}, config);
    expect(severity).toBe('critical');
    const channel = routeAlert(severity, config.channels);
    expect(channel).toBe('slack:D0AM0RZ7HB2');
  });

  it('proposal routes to DM as warning', () => {
    const severity = classifySeverity('proposal', {}, config);
    expect(severity).toBe('warning');
    const channel = routeAlert(severity, config.channels);
    expect(channel).toBe('slack:D0AM0RZ7HB2');
  });

  it('routing metadata structure is correct', () => {
    const routing: RoutingMetadata = {
      severity: 'warning',
      channel: 'slack:D0AM0RZ7HB2',
      suppressed: true,
      escalated: false,
    };
    expect(routing.severity).toBe('warning');
    expect(routing.channel).toBe('slack:D0AM0RZ7HB2');
    expect(routing.suppressed).toBe(true);
    expect(routing.escalated).toBe(false);
  });
});
