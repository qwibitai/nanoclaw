import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));
vi.mock('../config.js', () => ({
  DELEGATION_GUARDRAIL_COUNT: 10,
}));
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn() },
}));

import { _initTestDatabase, _closeDatabase } from '../db.js';
import {
  recordDelegation,
  getDelegationCount,
  shouldRequireApproval,
  resetDelegationCount,
} from '../delegation-tracker.js';

describe('delegation-tracker', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('starts with zero delegation count', () => {
    expect(getDelegationCount('main', 'comms.write')).toBe(0);
  });

  it('increments delegation count on record', () => {
    recordDelegation('main', 'comms.write');
    expect(getDelegationCount('main', 'comms.write')).toBe(1);
  });

  it('tracks counts per action class independently', () => {
    recordDelegation('main', 'comms.write');
    recordDelegation('main', 'comms.write');
    recordDelegation('main', 'services.write');

    expect(getDelegationCount('main', 'comms.write')).toBe(2);
    expect(getDelegationCount('main', 'services.write')).toBe(1);
  });

  it('requires approval when under guardrail count', () => {
    expect(shouldRequireApproval('main', 'comms.write')).toBe(true);
  });

  it('does not require approval after guardrail count reached', () => {
    for (let i = 0; i < 10; i++) {
      recordDelegation('main', 'comms.write');
    }
    expect(shouldRequireApproval('main', 'comms.write')).toBe(false);
  });

  it('resets delegation count', () => {
    recordDelegation('main', 'comms.write');
    recordDelegation('main', 'comms.write');
    resetDelegationCount('main', 'comms.write');
    expect(getDelegationCount('main', 'comms.write')).toBe(0);
  });
});
