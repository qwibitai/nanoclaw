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
  PROACTIVE_LOOKAHEAD_MS: 14400000,
  PROACTIVE_MIN_GAP_MS: 300000,
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

const mockGenerateShort = vi.fn();
vi.mock('../llm/utility.js', () => ({
  generateShort: (...args: unknown[]) => mockGenerateShort(...args),
}));

import { _initTestDatabase, _closeDatabase } from '../db.js';
import { storeCalendarEvents } from '../calendar-poller.js';
import { classifyFromSSE } from '../sse-classifier.js';
import { generateSuggestion } from '../proactive-suggestions.js';
import {
  correlateByAttendee,
  correlateBySubject,
  correlateBySemanticMatch,
  getItemThreadLinks,
} from '../thread-correlator.js';
import { upsertThread, getTrackedItemBySourceId } from '../tracked-items.js';
import { eventBus } from '../event-bus.js';

describe('email trigger end-to-end flow', () => {
  beforeEach(() => {
    _initTestDatabase();
    mockGenerateShort.mockReset();
  });
  afterEach(() => _closeDatabase());

  it('full pipeline: classify → correlate (attendee + subject + semantic) → suggest', async () => {
    const now = Date.now();

    // 1. Set up calendar: user is in a meeting with the email sender as attendee
    storeCalendarEvents([
      {
        id: 'standup-123',
        title: 'Daily Standup',
        start_time: now - 300000,
        end_time: now + 1500000,
        attendees: ['alice@company.com', 'bob@company.com'],
        location: null,
        source_account: null,
      },
      {
        id: 'review-456',
        title: 'Design Review',
        start_time: now + 3600000,
        end_time: now + 5400000,
        attendees: ['carol@company.com'],
        location: null,
        source_account: null,
      },
    ]);

    // 2. Set up existing threads (Discord, other channels)
    upsertThread({
      id: 'dc:api-redesign',
      group_name: 'main',
      title: 'API Redesign Discussion',
      source_hint: 'discord',
      created_at: now - 86400000,
      resolved_at: null,
      item_count: 5,
      state: 'active',
    });
    upsertThread({
      id: 'dc:quarterly-budget',
      group_name: 'main',
      title: 'Q2 Budget Review',
      source_hint: 'discord',
      created_at: now - 172800000,
      resolved_at: null,
      item_count: 3,
      state: 'active',
    });

    // 3. SSE email arrives — classify it
    const classified = classifyFromSSE([
      {
        thread_id: 'gmail-thread-001',
        account: 'dev@whoisxmlapi.com',
        subject: 'RE: API Redesign Discussion',
        sender: 'alice@company.com',
        superpilot_label: 'needs-attention',
      },
    ]);

    expect(classified).toHaveLength(1);
    expect(classified[0].decision).toBe('push');
    expect(classified[0].subject).toBe('RE: API Redesign Discussion');

    // Verify tracked item was persisted
    const tracked = getTrackedItemBySourceId('gmail', 'gmail:gmail-thread-001');
    expect(tracked).not.toBeNull();
    expect(tracked!.state).toBe('pending');

    // 4. Correlate by attendee — sender is in the meeting
    const attendeeLinks = correlateByAttendee(tracked!);
    expect(attendeeLinks).toHaveLength(1);
    expect(attendeeLinks[0].thread_id).toBe('cal:standup-123');
    expect(attendeeLinks[0].link_type).toBe('attendee_match');

    // 5. Correlate by subject — exact match after RE: strip
    const subjectLinks = correlateBySubject(tracked!, 'main');
    expect(subjectLinks).toHaveLength(1);
    expect(subjectLinks[0].thread_id).toBe('dc:api-redesign');
    expect(subjectLinks[0].link_type).toBe('subject_match');
    expect(subjectLinks[0].confidence).toBeCloseTo(0.9);

    // 6. Semantic match — should only consider threads NOT already linked
    mockGenerateShort.mockResolvedValue(
      JSON.stringify([
        {
          threadId: 'dc:quarterly-budget',
          confidence: 0.65,
          reasoning: 'API redesign has budget implications for Q2',
        },
      ]),
    );

    const semanticLinks = await correlateBySemanticMatch(tracked!, 'main');
    expect(semanticLinks).toHaveLength(1);
    expect(semanticLinks[0].thread_id).toBe('dc:quarterly-budget');
    expect(semanticLinks[0].link_type).toBe('semantic_match');

    // 7. Verify all 3 links are stored
    const allLinks = getItemThreadLinks(tracked!.id);
    expect(allLinks).toHaveLength(3);
    const linkTypes = allLinks.map((l) => l.link_type).sort();
    expect(linkTypes).toEqual([
      'attendee_match',
      'semantic_match',
      'subject_match',
    ]);

    // 8. Proactive suggestion — user is in a meeting with push items pending
    const suggestion = generateSuggestion('main', now);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.pendingCount).toBe(1);
    expect(suggestion!.nextGapAt).toBeGreaterThan(now);

    // 9. Verify events were emitted
    expect(eventBus.emit).toHaveBeenCalledWith(
      'item.classified',
      expect.objectContaining({ type: 'item.classified' }),
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      'thread.correlated',
      expect.objectContaining({
        payload: expect.objectContaining({ linkType: 'attendee_match' }),
      }),
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      'thread.correlated',
      expect.objectContaining({
        payload: expect.objectContaining({ linkType: 'subject_match' }),
      }),
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      'thread.correlated',
      expect.objectContaining({
        payload: expect.objectContaining({ linkType: 'semantic_match' }),
      }),
    );
  });

  it('digest emails are tracked but do not generate proactive suggestions', () => {
    const now = Date.now();

    storeCalendarEvents([
      {
        id: 'meeting-digest',
        title: 'Team Sync',
        start_time: now - 300000,
        end_time: now + 1800000,
        attendees: [],
        location: null,
        source_account: null,
      },
    ]);

    const classified = classifyFromSSE([
      {
        thread_id: 'newsletter-001',
        account: 'personal@test.com',
        subject: 'Weekly Tech Roundup',
        sender: 'news@techsite.com',
        superpilot_label: 'newsletter',
      },
    ]);

    expect(classified).toHaveLength(1);
    expect(classified[0].decision).toBe('digest');

    const suggestion = generateSuggestion('main', now);
    expect(suggestion).toBeNull();
  });

  it('duplicate emails are skipped on re-classification', () => {
    classifyFromSSE([
      {
        thread_id: 'dup-thread-001',
        account: 'dev@test.com',
        subject: 'Original message',
        sender: 'x@y.com',
      },
    ]);

    const secondRun = classifyFromSSE([
      {
        thread_id: 'dup-thread-001',
        account: 'dev@test.com',
        subject: 'Original message',
        sender: 'x@y.com',
      },
    ]);

    expect(secondRun).toHaveLength(0);
  });

  it('classifyFromSSE with custom group_name persists correctly', () => {
    const results = classifyFromSSE(
      [
        {
          thread_id: 'custom-group-thread',
          account: 'dev@test.com',
          subject: 'Team update',
          sender: 'lead@company.com',
          superpilot_label: 'needs-attention',
        },
      ],
      'dev-team',
    );

    expect(results).toHaveLength(1);
    const tracked = getTrackedItemBySourceId(
      'gmail',
      'gmail:custom-group-thread',
    );
    expect(tracked).not.toBeNull();
    expect(tracked!.group_name).toBe('dev-team');
  });
});
