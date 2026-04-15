import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _initTestDatabase, _closeDatabase } from '../db.js';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../config.js', () => ({
  ONECLI_URL: 'http://localhost:10254',
  CALENDAR_POLL_INTERVAL: 300000,
  CALENDAR_LOOKAHEAD_MS: 86400000,
  CALENDAR_HOLD_BUFFER_MS: 300000,
  TIMEZONE: 'America/Los_Angeles',
  CHAT_INTERFACE_CONFIG: {
    digestThreshold: 5,
    digestMinIntervalMs: 7200000,
    staleAfterDigestCycles: 2,
    urgencyKeywords: ['urgent'],
    vipList: [],
    quietHours: {
      enabled: false,
      start: '22:00',
      end: '07:00',
      weekendMode: false,
      escalateOverride: true,
    },
    holdPushDuringMeetings: true,
    pushRateLimit: 3,
    pushRateWindowMs: 1800000,
    morningDashboardTime: '07:30',
    microBriefingDelayMs: 60000,
  },
}));
vi.mock('../event-bus.js', () => ({
  eventBus: { emit: vi.fn(), on: vi.fn() },
}));

import { storeCalendarEvents } from '../calendar-poller.js';
import { correlateByAttendee } from '../thread-correlator.js';
import {
  isInMeeting,
  suggestDeliveryTime,
  scoreUrgency,
} from '../scheduling-advisor.js';
import { PushBuffer, refreshMeetingHolds } from '../push-buffer.js';
import { insertTrackedItem, type TrackedItem } from '../tracked-items.js';

beforeEach(() => _initTestDatabase());
afterEach(() => _closeDatabase());

function makeItem(overrides: Partial<TrackedItem>): TrackedItem {
  return {
    id: 'item_1',
    source: 'gmail',
    source_id: 'gmail:thread_abc',
    group_name: 'main',
    state: 'detected',
    classification: 'push',
    superpilot_label: 'needs-attention',
    trust_tier: 'propose',
    title: 'Meeting follow-up from Alice',
    summary: null,
    thread_id: 'gmail_thread_1',
    detected_at: Date.now(),
    pushed_at: null,
    resolved_at: null,
    resolution_method: null,
    digest_count: 0,
    telegram_message_id: null,
    classification_reason: null,
    metadata: { sender: 'alice@company.com' },
    ...overrides,
  };
}

describe('thread scheduling integration', () => {
  it('correlates email to calendar event by attendee and delays push during meeting', () => {
    const now = Date.now();

    // Store a calendar event that is currently active (started 10 min ago, ends 1 hour from now)
    storeCalendarEvents([
      {
        id: 'evt-active',
        title: 'Team Sync',
        start_time: now - 600000,
        end_time: now + 3600000,
        attendees: ['alice@company.com', 'bob@company.com'],
        location: null,
        source_account: null,
      },
    ]);

    // Insert a TrackedItem with sender matching one of the attendees
    const item = makeItem({ metadata: { sender: 'alice@company.com' } });
    insertTrackedItem(item);

    // Step 1: correlate by attendee — should find 1 link with attendee_match
    const links = correlateByAttendee(item);
    expect(links).toHaveLength(1);
    expect(links[0].link_type).toBe('attendee_match');
    expect(links[0].item_id).toBe('item_1');
    expect(links[0].thread_id).toBe('cal:evt-active');

    // Step 2: isInMeeting should return true because the event spans `now`
    expect(isInMeeting(now)).toBe(true);

    // Step 3: score urgency — 'propose' tier + 'push' classification
    const score = scoreUrgency({
      trustTier: 'propose',
      ageMs: 0,
      digestCount: 0,
      classification: 'push',
    });
    // propose (0.3) + push (0.3) + age 0 = 0.6
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.9); // not high enough to override meeting hold

    // Step 4: suggestDeliveryTime should return 'delay' since user is in a meeting
    const suggestion = suggestDeliveryTime(now, score);
    expect(suggestion.action).toBe('delay');
    expect(suggestion.deliverAt).toBeGreaterThan(now);

    // Step 5: PushBuffer should hold during meeting for routine/propose tier
    const buffer = new PushBuffer();
    refreshMeetingHolds(buffer, now);
    expect(buffer.shouldHold('routine')).toBe(true);
    expect(buffer.shouldHold('escalate')).toBe(false);
  });

  it('delivers immediately when not in meeting', () => {
    const now = Date.now();

    // Store a calendar event that ended well in the past
    storeCalendarEvents([
      {
        id: 'evt-past',
        title: 'Past Meeting',
        start_time: now - 10800000, // started 3 hours ago
        end_time: now - 7200000, // ended 2 hours ago
        attendees: ['alice@company.com'],
        location: null,
        source_account: null,
      },
    ]);

    // isInMeeting should be false
    expect(isInMeeting(now)).toBe(false);

    // Score urgency with propose tier
    const score = scoreUrgency({
      trustTier: 'propose',
      ageMs: 0,
      digestCount: 0,
      classification: 'push',
    });

    // suggestDeliveryTime should return 'deliver_now'
    const suggestion = suggestDeliveryTime(now, score);
    expect(suggestion.action).toBe('deliver_now');
  });
});
