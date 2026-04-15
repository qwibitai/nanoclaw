import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../config.js', () => ({
  TIMEZONE: 'America/Los_Angeles',
  DATA_DIR: '/tmp/nanoclaw-test',
  STORE_DIR: '/tmp/nanoclaw-test/store',
  ASSISTANT_NAME: 'Andy',
  CHAT_INTERFACE_CONFIG: {
    morningDashboardTime: '07:30',
    digestThreshold: 5,
    digestMinIntervalMs: 7200000,
    staleAfterDigestCycles: 2,
    pushRateLimit: 3,
    pushRateWindowMs: 1800000,
    vipList: [],
    urgencyKeywords: ['urgent', 'deadline', 'asap', 'blocking'],
    holdPushDuringMeetings: false,
    microBriefingDelayMs: 60000,
    quietHours: { enabled: false, start: '22:00', end: '07:00', weekendMode: false, escalateOverride: true },
  },
}));

import { _initTestDatabase, _closeDatabase } from '../db.js';
import { insertTrackedItem } from '../tracked-items.js';
import { generateMorningDashboard } from '../digest-engine.js';

describe('generateMorningDashboard', () => {
  beforeEach(() => _initTestDatabase());
  afterEach(() => _closeDatabase());

  it('returns clean slate message when no items', () => {
    const result = generateMorningDashboard('main');
    expect(result).toContain('MORNING DASHBOARD');
    expect(result).toContain('Nothing urgent');
  });

  it('shows action-required items', () => {
    insertTrackedItem({
      id: 'email:t1',
      source: 'gmail',
      source_id: 't1',
      group_name: 'main',
      state: 'pending',
      classification: 'push',
      superpilot_label: 'needs-attention',
      trust_tier: 'escalate',
      title: 'Budget approval from Sarah',
      summary: 'Need sign-off by EOD',
      thread_id: 't1',
      detected_at: Date.now() - 3600000,
      pushed_at: Date.now() - 3600000,
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: { superpilot: 'needs-attention', trust: 'escalate', final: 'push' },
      metadata: null,
    });

    const result = generateMorningDashboard('main');
    expect(result).toContain('ACTION REQUIRED');
    expect(result).toContain('Budget approval from Sarah');
  });

  it('shows resolved items in overnight summary', () => {
    insertTrackedItem({
      id: 'email:t2',
      source: 'gmail',
      source_id: 't2',
      group_name: 'main',
      state: 'resolved',
      classification: 'push',
      superpilot_label: 'needs-attention',
      trust_tier: 'auto',
      title: 'Server alert',
      summary: 'Resolved automatically',
      thread_id: 't2',
      detected_at: Date.now() - 7200000,
      pushed_at: Date.now() - 7200000,
      resolved_at: Date.now() - 3600000,
      resolution_method: 'auto:gmail_reply',
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: { final: 'push' },
      metadata: null,
    });

    const result = generateMorningDashboard('main');
    expect(result).toContain('OVERNIGHT SUMMARY');
  });

  it('shows items grouped by thread when thread exists', () => {
    insertTrackedItem({
      id: 'email:t3a',
      source: 'gmail',
      source_id: 't3a',
      group_name: 'main',
      state: 'pending',
      classification: 'push',
      superpilot_label: 'needs-attention',
      trust_tier: 'escalate',
      title: 'Acme deal — email',
      summary: null,
      thread_id: 'acme_thread',
      detected_at: Date.now() - 3600000,
      pushed_at: Date.now() - 3600000,
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: { final: 'push' },
      metadata: null,
    });
    insertTrackedItem({
      id: 'cal:t3b',
      source: 'calendar',
      source_id: 't3b',
      group_name: 'main',
      state: 'pending',
      classification: 'push',
      superpilot_label: null,
      trust_tier: null,
      title: 'Acme deal — meeting',
      summary: null,
      thread_id: 'acme_thread',
      detected_at: Date.now() - 3600000,
      pushed_at: Date.now() - 3600000,
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: { final: 'push' },
      metadata: null,
    });

    const result = generateMorningDashboard('main');
    expect(result).toContain('ACTION REQUIRED');
  });
});
