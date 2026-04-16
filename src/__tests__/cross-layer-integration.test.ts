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
  TIMEZONE: 'America/Los_Angeles',
  DAILY_BUDGET_USD: 10.0,
  DATA_DIR: '/tmp/nanoclaw-cross-layer-test',
  STORE_DIR: '/tmp/nanoclaw-cross-layer-test/store',
  GROUPS_DIR: '/tmp/nanoclaw-cross-layer-test/groups',
  ONECLI_URL: 'http://localhost:10254',
  CALENDAR_POLL_INTERVAL: 300000,
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
  eventBus: { emit: vi.fn(), on: vi.fn(), removeAllListeners: vi.fn() },
}));

import { _initTestDatabase, _closeDatabase, getDb } from '../db.js';
import { storeCalendarEvents } from '../calendar-poller.js';
import { insertTrackedItem } from '../tracked-items.js';
import { generateSuggestion } from '../proactive-suggestions.js';
import { generateMorningDashboard } from '../digest-engine.js';
import { classifyTool, evaluateTrust } from '../trust-engine.js';
import {
  recordConfidenceOutcome,
  getCalibrationStats,
} from '../confidence-calibration.js';
import {
  parseStepFromNarration,
  buildProcedure,
} from '../../container/skills/teach-mode/teach-mode.js';

describe('cross-layer integration', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('proactive action flow: meeting + tracked items → suggestion + trust check', () => {
    const now = Date.now();

    // Layer 4: Set up calendar event (user is in meeting)
    storeCalendarEvents([
      {
        id: 'cross-meeting',
        title: 'Board Meeting',
        start_time: now - 600000,
        end_time: now + 3600000,
        attendees: ['ceo@company.com'],
        location: 'Room A',
        source_account: null,
      },
    ]);

    // Layer 4: Track a pending push item
    insertTrackedItem({
      id: 'cross:email-1',
      source: 'gmail',
      source_id: 'ce1',
      group_name: 'main',
      state: 'pending',
      classification: 'push',
      superpilot_label: 'needs-attention',
      trust_tier: 'escalate',
      title: 'URGENT: Contract expires today',
      summary: null,
      thread_id: null,
      detected_at: now - 7200000,
      pushed_at: now - 7200000,
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: { final: 'push' },
      metadata: { sender: 'legal@company.com' },
    });

    // Layer 4: Proactive suggestion should fire
    const suggestion = generateSuggestion('main', now);
    expect(suggestion).not.toBeNull();
    expect(suggestion!.pendingCount).toBe(1);
    expect(suggestion!.urgencyScore).toBeGreaterThanOrEqual(0.8);
    expect(suggestion!.message).toContain('action-required');

    // Layer 3: Trust engine classifies the action that would handle this
    const actionClass = classifyTool('handle_email_reply');
    expect(actionClass).toBe('comms.write');

    // Layer 3: Evaluate trust for the action
    const trustResult = evaluateTrust('handle_email_reply', 'main');
    expect(trustResult.decision).toBe('needs_approval');
  });

  it('daily digest includes cost + pending items + calendar context', () => {
    const now = Date.now();
    const db = getDb();

    // Layer 4: Add pending items
    insertTrackedItem({
      id: 'digest:email-1',
      source: 'gmail',
      source_id: 'de1',
      group_name: 'main',
      state: 'pending',
      classification: 'push',
      superpilot_label: null,
      trust_tier: 'escalate',
      title: 'Quarterly report due',
      summary: null,
      thread_id: null,
      detected_at: now - 3600000,
      pushed_at: now - 3600000,
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: { final: 'push' },
      metadata: null,
    });

    // Layer 6: Record cost data
    db.prepare(
      `INSERT INTO session_costs (session_type, group_folder, started_at, duration_ms, estimated_cost_usd)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('interactive', 'main', new Date().toISOString(), 5000, 0.12);

    // Generate dashboard — should include both items and cost
    const dashboard = generateMorningDashboard('main');
    expect(dashboard).toContain('MORNING DASHBOARD');
    expect(dashboard).toContain('ACTION REQUIRED');
    expect(dashboard).toContain('Quarterly report due');
    expect(dashboard).toContain('COST');
    expect(dashboard).toContain('$0.12');
  });

  it('confidence calibration records outcomes and computes accuracy', () => {
    // Layer 5: Record outcomes across different confidence levels
    recordConfidenceOutcome('action-1', 'verified', true);
    recordConfidenceOutcome('action-2', 'verified', true);
    recordConfidenceOutcome('action-3', 'verified', false);
    recordConfidenceOutcome('action-4', 'unverified', true);
    recordConfidenceOutcome('action-5', 'unknown', false);

    const stats = getCalibrationStats();
    expect(stats.verified.total).toBe(3);
    expect(stats.verified.correct).toBe(2);
    expect(stats.verified.accuracy).toBeCloseTo(0.667, 2);
    expect(stats.unverified.total).toBe(1);
    expect(stats.unverified.correct).toBe(1);
    expect(stats.unknown.total).toBe(1);
    expect(stats.unknown.correct).toBe(0);
  });

  it('teach mode: parse narration → build procedure → verify structure', () => {
    // Layer 6 (container skill): Parse steps from user narration
    const steps = [
      parseStepFromNarration('Go to alto.com'),
      parseStepFromNarration('Click on Medications'),
      parseStepFromNarration('Find Lisinopril'),
      parseStepFromNarration('Click Reorder'),
    ].filter((s): s is NonNullable<typeof s> => s !== null);

    expect(steps).toHaveLength(4);
    expect(steps[0].action).toBe('navigate');
    expect(steps[1].action).toBe('click');
    expect(steps[2].action).toBe('find');
    expect(steps[3].action).toBe('click');

    // Build procedure
    const proc = buildProcedure('reorder Alto refill', steps, 'main');
    expect(proc.name).toBe('reorder_alto_refill');
    expect(proc.acquisition).toBe('teach');
    expect(proc.steps).toHaveLength(4);
    expect(proc.trigger).toContain('reorder Alto refill');
  });
});
