import { describe, it, expect, vi } from 'vitest';

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
  TIMEZONE: 'America/Los_Angeles',
  CHAT_INTERFACE_CONFIG: {
    pushRateLimit: 3,
    pushRateWindowMs: 1800000,
    holdPushDuringMeetings: true,
    microBriefingDelayMs: 60000,
    quietHours: {
      enabled: false,
      start: '22:00',
      end: '07:00',
      weekendMode: false,
      escalateOverride: true,
    },
  },
}));

import { formatPushMessage, type PushMessageInput } from '../push-manager.js';

describe('formatPushMessage', () => {
  it('formats an email push with all sections', () => {
    const input: PushMessageInput = {
      source: 'gmail',
      title: 'Q2 Budget Approval',
      sender: 'Sarah Chen',
      summary: 'Hi, the board needs sign-off by EOD Wednesday.',
      lastReply: 'Let me check with legal and get back to you.',
      lastReplyAge: '3 days ago',
    };
    const msg = formatPushMessage(input);
    expect(msg).toContain('ACTION');
    expect(msg).toContain('Sarah Chen');
    expect(msg).toContain('Q2 Budget Approval');
    expect(msg).toContain('board needs sign-off');
    expect(msg).toContain('Your last reply');
    expect(msg).toContain('check with legal');
  });

  it('formats without last reply when none exists', () => {
    const input: PushMessageInput = {
      source: 'gmail',
      title: 'New email',
      sender: 'Someone',
      summary: 'Content here',
    };
    const msg = formatPushMessage(input);
    expect(msg).not.toContain('Your last reply');
  });

  it('formats calendar conflict', () => {
    const input: PushMessageInput = {
      source: 'calendar',
      title: 'Design Review conflicts with Standup at 2pm',
      sender: '',
      summary: null,
    };
    const msg = formatPushMessage(input);
    expect(msg).toContain('Design Review');
  });
});

describe('getPushActions', () => {
  it('returns standard action set', async () => {
    const { getPushActions } = await import('../push-manager.js');
    const actions = getPushActions('email:t1');
    expect(actions).toHaveLength(4);
    expect(actions.map((a) => a.callbackData)).toEqual([
      'approve:email:t1',
      'dismiss:email:t1',
      'snooze:email:t1',
      'handle:email:t1',
    ]);
  });
});

import { PushRateLimiter } from '../push-manager.js';

describe('PushRateLimiter', () => {
  it('allows pushes under limit', () => {
    const limiter = new PushRateLimiter(3, 1800000);
    expect(limiter.canPush()).toBe(true);
    limiter.record();
    limiter.record();
    expect(limiter.canPush()).toBe(true);
    limiter.record();
    expect(limiter.canPush()).toBe(false);
  });

  it('resets after window expires', () => {
    const limiter = new PushRateLimiter(1, 100);
    limiter.record();
    expect(limiter.canPush()).toBe(false);
  });
});
