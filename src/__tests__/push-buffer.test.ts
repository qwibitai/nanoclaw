import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import {
  PushBuffer,
  type HoldCondition as _HoldCondition,
} from '../push-buffer.js';

describe('PushBuffer', () => {
  let buffer: PushBuffer;
  beforeEach(() => {
    buffer = new PushBuffer();
  });

  it('allows push when no hold conditions active', () => {
    expect(buffer.shouldHold('escalate')).toBe(false);
  });

  it('holds non-escalate during meeting', () => {
    buffer.addCondition({
      type: 'meeting',
      label: 'Product Sync',
      expiresAt: Date.now() + 3600000,
    });
    expect(buffer.shouldHold('propose')).toBe(true);
    expect(buffer.shouldHold('auto')).toBe(true);
  });

  it('allows escalate during meeting', () => {
    buffer.addCondition({
      type: 'meeting',
      label: 'Product Sync',
      expiresAt: Date.now() + 3600000,
    });
    expect(buffer.shouldHold('escalate')).toBe(false);
  });

  it('holds during quiet hours', () => {
    buffer.addCondition({
      type: 'quiet_hours',
      label: 'Quiet 22:00-07:00',
      expiresAt: Date.now() + 3600000,
    });
    expect(buffer.shouldHold('propose')).toBe(true);
  });

  it('allows escalate during quiet hours when escalateOverride', () => {
    buffer.addCondition({
      type: 'quiet_hours',
      label: 'Quiet',
      expiresAt: Date.now() + 3600000,
      escalateOverride: true,
    });
    expect(buffer.shouldHold('escalate')).toBe(false);
  });

  it('holds when rate limited', () => {
    buffer.addCondition({
      type: 'rate_limit',
      label: 'Rate limit',
      expiresAt: Date.now() + 60000,
    });
    expect(buffer.shouldHold('propose')).toBe(true);
    expect(buffer.shouldHold('escalate')).toBe(true);
  });

  it('expires conditions automatically', () => {
    buffer.addCondition({
      type: 'meeting',
      label: 'Standup',
      expiresAt: Date.now() - 1000,
    });
    expect(buffer.shouldHold('propose')).toBe(false);
  });

  it('returns active conditions for micro-briefing', () => {
    const meetingEnd = Date.now() + 3600000;
    buffer.addCondition({
      type: 'meeting',
      label: 'Product Sync',
      expiresAt: meetingEnd,
    });
    const conditions = buffer.getActiveConditions();
    expect(conditions).toHaveLength(1);
    expect(conditions[0].label).toBe('Product Sync');
  });

  it('clears a specific condition', () => {
    buffer.addCondition({
      type: 'meeting',
      label: 'Standup',
      expiresAt: Date.now() + 3600000,
    });
    buffer.clearCondition('meeting');
    expect(buffer.shouldHold('propose')).toBe(false);
  });

  it('holds during weekend mode', () => {
    buffer.addCondition({
      type: 'weekend',
      label: 'Weekend',
      expiresAt: Date.now() + 86400000,
      escalateOverride: true,
    });
    expect(buffer.shouldHold('propose')).toBe(true);
    expect(buffer.shouldHold('escalate')).toBe(false);
  });
});
