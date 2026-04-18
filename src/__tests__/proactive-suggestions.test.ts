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
  eventBus: { emit: vi.fn() },
}));

import { _initTestDatabase, _closeDatabase } from '../db.js';
import { storeCalendarEvents } from '../calendar-poller.js';
import { insertTrackedItem } from '../tracked-items.js';
import { generateSuggestion } from '../proactive-suggestions.js';

function makeTrackedItem(overrides: {
  id: string;
  source_id: string;
  title: string;
  trust_tier?: string | null;
  detected_at: number;
}) {
  return {
    id: overrides.id,
    source: 'gmail',
    source_id: overrides.source_id,
    group_name: 'main',
    state: 'pending' as const,
    classification: 'push' as const,
    superpilot_label: null,
    trust_tier: overrides.trust_tier ?? null,
    title: overrides.title,
    summary: null,
    thread_id: null,
    detected_at: overrides.detected_at,
    pushed_at: overrides.detected_at,
    resolved_at: null,
    resolution_method: null,
    digest_count: 0,
    telegram_message_id: null,
    classification_reason: { final: 'push' as const },
    metadata: null,
  };
}

describe('proactive-suggestions', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('returns null when no pending items', () => {
    const result = generateSuggestion('main', Date.now());
    expect(result).toBeNull();
  });

  it('returns null when not in a meeting', () => {
    const now = Date.now();
    insertTrackedItem(
      makeTrackedItem({
        id: 'ps:1',
        source_id: 'ps1',
        title: 'Urgent email',
        trust_tier: 'escalate',
        detected_at: now - 3600000,
      }),
    );
    const result = generateSuggestion('main', now);
    expect(result).toBeNull();
  });

  it('suggests gap delivery when in meeting with pending items', () => {
    const now = Date.now();
    storeCalendarEvents([
      {
        id: 'meeting1',
        title: 'Team Standup',
        start_time: now - 600000,
        end_time: now + 1800000,
        attendees: [],
        location: null,
        source_account: null,
      },
    ]);
    storeCalendarEvents([
      {
        id: 'meeting2',
        title: 'Design Review',
        start_time: now + 3600000,
        end_time: now + 5400000,
        attendees: [],
        location: null,
        source_account: null,
      },
    ]);
    insertTrackedItem(
      makeTrackedItem({
        id: 'ps:2',
        source_id: 'ps2',
        title: 'Budget review needed',
        detected_at: now - 3600000,
      }),
    );
    const result = generateSuggestion('main', now);
    expect(result).not.toBeNull();
    expect(result!.pendingCount).toBe(1);
    expect(result!.message).toContain('pending');
  });

  it('mentions gap time in suggestion', () => {
    const now = Date.now();
    storeCalendarEvents([
      {
        id: 'meeting3',
        title: 'Sprint Planning',
        start_time: now - 300000,
        end_time: now + 1800000,
        attendees: [],
        location: null,
        source_account: null,
      },
    ]);
    insertTrackedItem(
      makeTrackedItem({
        id: 'ps:3a',
        source_id: 'ps3a',
        title: 'PR review request',
        detected_at: now - 7200000,
      }),
    );
    insertTrackedItem(
      makeTrackedItem({
        id: 'ps:3b',
        source_id: 'ps3b',
        title: 'Contract sign-off',
        detected_at: now - 1800000,
      }),
    );
    const result = generateSuggestion('main', now);
    expect(result).not.toBeNull();
    expect(result!.pendingCount).toBe(2);
    expect(result!.nextGapAt).toBeGreaterThan(now);
  });

  it('returns high urgency score when escalate items are waiting', () => {
    const now = Date.now();
    storeCalendarEvents([
      {
        id: 'meeting4',
        title: 'All Hands',
        start_time: now - 600000,
        end_time: now + 3600000,
        attendees: [],
        location: null,
        source_account: null,
      },
    ]);
    insertTrackedItem(
      makeTrackedItem({
        id: 'ps:4',
        source_id: 'ps4',
        title: 'URGENT: Production is down',
        trust_tier: 'escalate',
        detected_at: now - 7200000,
      }),
    );
    const result = generateSuggestion('main', now);
    expect(result).not.toBeNull();
    expect(result!.urgencyScore).toBeGreaterThanOrEqual(0.8);
  });
});
