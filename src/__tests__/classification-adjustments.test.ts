import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../config.js', () => ({
  TIMEZONE: 'America/Los_Angeles',
  DATA_DIR: '/tmp/nanoclaw-test',
  STORE_DIR: '/tmp/nanoclaw-test/store',
  ASSISTANT_NAME: 'Andy',
}));

import { _initTestDatabase, _closeDatabase } from '../db.js';
import {
  recordBehavior,
  getAdjustment,
} from '../classification-adjustments.js';

describe('classification-adjustments', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('returns no adjustment with insufficient data', () => {
    recordBehavior('gmail', 'user@example.com', 'push', 'dismiss');
    const adj = getAdjustment('gmail', 'user@example.com');
    expect(adj).toBe('none');
  });

  it('demotes after 3+ dismissals', () => {
    for (let i = 0; i < 3; i++) {
      recordBehavior('gmail', 'newsletters@co.com', 'push', 'dismiss');
    }
    const adj = getAdjustment('gmail', 'newsletters@co.com');
    expect(adj).toBe('demote');
  });

  it('promotes after 3+ immediate actions on digest items', () => {
    for (let i = 0; i < 3; i++) {
      recordBehavior('gmail', 'vip@co.com', 'digest', 'immediate_action');
    }
    const adj = getAdjustment('gmail', 'vip@co.com');
    expect(adj).toBe('promote');
  });

  it('requires minimum data points before adjustment', () => {
    for (let i = 0; i < 9; i++) {
      recordBehavior('gmail', 'edge@co.com', 'push', 'dismiss');
    }
    const adj = getAdjustment('gmail', 'edge@co.com', { minDataPoints: 10 });
    expect(adj).toBe('none');
  });
});
