import { describe, it, expect } from 'vitest';

import {
  classifySeverity,
  parseSentryPayload,
  parseUptimeRobotPayload,
  parseGenericPayload,
  triageAlert,
  formatTriageMessage,
  type Alert,
  type AutoFix,
} from './sentry-agent.js';

describe('classifySeverity', () => {
  it('classifies crash as critical', () => {
    expect(classifySeverity('App crashed', '', 'sentry')).toBe('critical');
  });

  it('classifies 502 as critical', () => {
    expect(classifySeverity('502 Bad Gateway', '', 'generic')).toBe('critical');
  });

  it('classifies OOM as critical', () => {
    expect(classifySeverity('', 'Container killed: out of memory', 'generic')).toBe('critical');
  });

  it('classifies timeout as warning', () => {
    expect(classifySeverity('Request timeout', '', 'sentry')).toBe('warning');
  });

  it('classifies rate limit as warning', () => {
    expect(classifySeverity('429 rate limit exceeded', '', 'generic')).toBe('warning');
  });

  it('classifies high CPU as warning', () => {
    expect(classifySeverity('High CPU usage on api-server', '', 'generic')).toBe('warning');
  });

  it('classifies unknown as info', () => {
    expect(classifySeverity('Deploy complete', 'version 1.2.3', 'generic')).toBe('info');
  });
});

describe('parseSentryPayload', () => {
  it('extracts title and project from Sentry webhook', () => {
    const alert = parseSentryPayload({
      action: 'triggered',
      data: {
        event: {
          title: 'TypeError: cannot read property of null',
          project: 'api-server',
          message: 'handlers.js line 42',
        },
      },
    });

    expect(alert.source).toBe('sentry');
    expect(alert.title).toBe('TypeError: cannot read property of null');
    expect(alert.service).toBe('api-server');
    expect(alert.severity).toBe('info'); // TypeError doesn't match critical/warning
  });

  it('handles minimal Sentry payload', () => {
    const alert = parseSentryPayload({});
    expect(alert.source).toBe('sentry');
    expect(alert.title).toBe('Unknown');
  });
});

describe('parseUptimeRobotPayload', () => {
  it('parses down alert as critical', () => {
    const alert = parseUptimeRobotPayload({
      monitorFriendlyName: 'API Server',
      alertType: '1',
      alertTypeFriendlyName: 'Down',
    });

    expect(alert.source).toBe('uptimerobot');
    expect(alert.severity).toBe('critical');
    expect(alert.title).toContain('DOWN');
    expect(alert.service).toBe('API Server');
  });

  it('parses up alert as info', () => {
    const alert = parseUptimeRobotPayload({
      monitorFriendlyName: 'API Server',
      alertType: '2',
      alertTypeFriendlyName: 'Up',
    });

    expect(alert.severity).toBe('info');
    expect(alert.title).toContain('UP');
  });
});

describe('parseGenericPayload', () => {
  it('extracts title and message', () => {
    const alert = parseGenericPayload({
      title: 'Disk usage above 90%',
      message: '/dev/sda1 is 93% full',
      service: 'monitoring',
    });

    expect(alert.source).toBe('generic');
    expect(alert.title).toBe('Disk usage above 90%');
    expect(alert.service).toBe('monitoring');
  });

  it('respects explicit severity field', () => {
    const alert = parseGenericPayload({
      title: 'Test alert',
      severity: 'critical',
    });

    expect(alert.severity).toBe('critical');
  });

  it('normalizes severity strings', () => {
    expect(parseGenericPayload({ severity: 'fatal' }).severity).toBe('critical');
    expect(parseGenericPayload({ severity: 'warn' }).severity).toBe('warning');
    expect(parseGenericPayload({ severity: 'low' }).severity).toBe('info');
  });
});

describe('triageAlert', () => {
  const baseAlert: Alert = {
    id: 'test-1',
    source: 'sentry',
    title: 'App crashed',
    message: 'Segfault in worker',
    severity: 'critical',
    service: 'worker',
    timestamp: '2026-01-01T00:00:00Z',
    raw: {},
  };

  it('generates summary with severity emoji', () => {
    const result = triageAlert(baseAlert);
    expect(result.summary).toContain('🔴');
    expect(result.summary).toContain('CRITICAL');
    expect(result.summary).toContain('App crashed');
  });

  it('suggests investigating for critical alerts', () => {
    const result = triageAlert(baseAlert);
    expect(result.recommendedAction).toContain('Investigate');
  });

  it('suggests monitoring for warnings', () => {
    const result = triageAlert({ ...baseAlert, severity: 'warning' });
    expect(result.recommendedAction).toContain('Monitor');
  });

  it('matches auto-fix rules', () => {
    const fixes: AutoFix[] = [
      {
        id: 'restart-worker',
        pattern: 'crash.*worker',
        description: 'Restart the worker service',
        command: 'systemctl restart worker',
      },
    ];

    const result = triageAlert(baseAlert, fixes);
    expect(result.autoFixAvailable).toBe(true);
    expect(result.autoFixId).toBe('restart-worker');
    expect(result.recommendedAction).toContain('Restart the worker');
  });

  it('no auto-fix when no rules match', () => {
    const fixes: AutoFix[] = [
      {
        id: 'clear-cache',
        pattern: 'cache.*full',
        description: 'Clear the cache',
        command: 'redis-cli flushall',
      },
    ];

    const result = triageAlert(baseAlert, fixes);
    expect(result.autoFixAvailable).toBe(false);
  });
});

describe('formatTriageMessage', () => {
  it('includes summary and action', () => {
    const result = triageAlert({
      id: 'test-1',
      source: 'generic',
      title: 'High memory',
      message: '95% used',
      severity: 'warning',
      service: 'api',
      timestamp: '2026-01-01T00:00:00Z',
      raw: {},
    });

    const msg = formatTriageMessage(result);
    expect(msg).toContain('WARNING');
    expect(msg).toContain('High memory');
    expect(msg).toContain('Monitor');
  });

  it('shows auto-fix info when available', () => {
    const result = triageAlert(
      {
        id: 'test-2',
        source: 'generic',
        title: 'Cache full',
        message: 'Redis cache full',
        severity: 'warning',
        service: 'redis',
        timestamp: '2026-01-01T00:00:00Z',
        raw: {},
      },
      [{ id: 'clear-cache', pattern: 'cache.*full', description: 'Clear cache', command: 'redis-cli flushall' }],
    );

    const msg = formatTriageMessage(result);
    expect(msg).toContain('Auto-fix');
    expect(msg).toContain('clear-cache');
  });
});
