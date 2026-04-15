import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../config.js', () => ({
  DELEGATION_GUARDRAIL_COUNT: 10,
  CHAT_INTERFACE_CONFIG: {
    morningDashboardTime: '07:30',
    digestThreshold: 5,
    digestMinIntervalMs: 7200000,
    staleAfterDigestCycles: 2,
    pushRateLimit: 3,
    pushRateWindowMs: 1800000,
    vipList: [],
    urgencyKeywords: ['urgent', 'deadline', 'asap', 'blocking'],
    holdPushDuringMeetings: false,
    microBriefingDelayMs: 60000,
    quietHours: { enabled: false, start: '22:00', end: '07:00', weekendMode: false, escalateOverride: true },
  },
}));
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn() },
}));

import { _initTestDatabase, _closeDatabase } from '../db.js';
import { parseTrustCommand, executeTrustCommand } from '../trust-commands.js';
import { recordDelegation } from '../delegation-tracker.js';

describe('delegation status command', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('parses "delegation status" command', () => {
    const cmd = parseTrustCommand('delegation status');
    expect(cmd).not.toBeNull();
  });

  it('shows zero-state message initially', () => {
    const cmd = parseTrustCommand('delegation status');
    const result = executeTrustCommand(cmd!, 'main');
    expect(result).toContain('DELEGATION');
    expect(result).toContain('No delegations');
  });

  it('shows counts after delegations', () => {
    recordDelegation('main', 'comms.write');
    recordDelegation('main', 'comms.write');
    recordDelegation('main', 'comms.write');

    const cmd = parseTrustCommand('delegation status');
    const result = executeTrustCommand(cmd!, 'main');
    expect(result).toContain('comms.write');
    expect(result).toContain('3');
  });
});
