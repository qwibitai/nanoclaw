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
  CALENDAR_HOLD_BUFFER_MS: 300000,
  CALENDAR_LOOKAHEAD_MS: 86400000,
  DELEGATION_GUARDRAIL_COUNT: 10,
  TIMEZONE: 'America/Los_Angeles',
  CHAT_INTERFACE_CONFIG: {
    morningDashboardTime: '07:30',
    digestThreshold: 5,
    digestMinIntervalMs: 7200000,
    staleAfterDigestCycles: 2,
    pushRateLimit: 3,
    pushRateWindowMs: 1800000,
    vipList: [],
    urgencyKeywords: ['urgent', 'deadline', 'asap', 'blocking'],
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
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));

import { _initTestDatabase, _closeDatabase } from '../db.js';
import { storeCalendarEvents } from '../calendar-poller.js';
import { classifyFromSSE } from '../sse-classifier.js';
import { generateSuggestion } from '../proactive-suggestions.js';
import {
  recordDelegation,
  shouldRequireApproval,
} from '../delegation-tracker.js';
import { classifyTool } from '../trust-engine.js';

describe('end-to-end: SSE classify → proactive suggestion → delegation', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('SSE-classified push items trigger proactive suggestion during meeting', () => {
    const now = Date.now();

    storeCalendarEvents([
      {
        id: 'e2e-meeting',
        title: 'Board Meeting',
        start_time: now - 600000,
        end_time: now + 3600000,
        attendees: ['cfo@company.com'],
        location: 'Room A',
        source_account: null,
      },
    ]);

    const results = classifyFromSSE([
      {
        thread_id: 'e2e-thread-1',
        account: 'dev@test.com',
        subject: 'Urgent: Budget approval',
        sender: 'cfo@company.com',
        superpilot_label: 'needs-attention',
      },
    ]);

    expect(results).toHaveLength(1);
    expect(results[0].decision).toBe('push');

    const suggestion = generateSuggestion('main', now);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.pendingCount).toBe(1);
    expect(suggestion!.message).toContain('pending');
  });

  it('delegation guardrail integrates with trust classification', () => {
    const actionClass = classifyTool('handle_email_reply');
    expect(actionClass).toBe('comms.write');

    expect(shouldRequireApproval('main', actionClass)).toBe(true);

    for (let i = 0; i < 10; i++) {
      recordDelegation('main', actionClass);
    }

    expect(shouldRequireApproval('main', actionClass)).toBe(false);
  });
});
