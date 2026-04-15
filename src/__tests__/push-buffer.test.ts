import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db.js';

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
  ONECLI_URL: 'http://localhost:10254',
  CALENDAR_POLL_INTERVAL: 300000,
  CALENDAR_LOOKAHEAD_MS: 86400000,
  CALENDAR_HOLD_BUFFER_MS: 300000,
}));

vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn() },
}));

import {
  PushBuffer,
  refreshMeetingHolds,
  type HoldCondition as _HoldCondition,
} from '../push-buffer.js';
import { storeCalendarEvents } from '../calendar-poller.js';

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

describe('refreshMeetingHolds', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('creates a meeting hold when currently in a meeting', () => {
    const now = Date.now();
    storeCalendarEvents([
      {
        id: 'e1',
        title: 'Active Meeting',
        start_time: now - 600000,
        end_time: now + 3600000,
        attendees: [],
        location: null,
        source_account: null,
      },
    ]);

    const buffer = new PushBuffer();
    refreshMeetingHolds(buffer, now);

    expect(buffer.shouldHold('routine')).toBe(true);
    const conditions = buffer.getActiveConditions();
    expect(conditions.some((c) => c.type === 'meeting')).toBe(true);
  });

  it('does not create hold when not in meeting', () => {
    const now = 1713210000000;
    storeCalendarEvents([
      {
        id: 'e1',
        title: 'Past Meeting',
        start_time: 1713200000000,
        end_time: 1713203600000,
        attendees: [],
        location: null,
        source_account: null,
      },
    ]);

    const buffer = new PushBuffer();
    refreshMeetingHolds(buffer, now);

    expect(buffer.shouldHold('routine')).toBe(false);
  });

  it('clears meeting hold when meeting ends', () => {
    const buffer = new PushBuffer();
    buffer.addCondition({
      type: 'meeting',
      label: 'Old meeting',
      expiresAt: Date.now() + 3600000,
    });

    refreshMeetingHolds(buffer, 1713210000000);

    const conditions = buffer.getActiveConditions();
    expect(conditions.some((c) => c.type === 'meeting')).toBe(false);
  });
});
