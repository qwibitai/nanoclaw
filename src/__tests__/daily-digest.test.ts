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
  TIMEZONE: 'America/Los_Angeles',
}));

const { mockRenderArchiveDashboard } = vi.hoisted(() => ({
  mockRenderArchiveDashboard: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../triage/dashboards.js', () => ({
  renderArchiveDashboard: mockRenderArchiveDashboard,
  renderAttentionDashboard: vi.fn(),
}));

vi.mock('../triage/config.js', () => ({
  TRIAGE_DEFAULTS: {
    enabled: true,
    shadowMode: true,
    models: { tier1: 'haiku', tier2: 'sonnet', tier3: 'opus' },
    attentionThreshold: 0.7,
    archiveThreshold: 0.8,
    escalateLow: 0.3,
    escalateHigh: 0.75,
    skiplistPromotionHits: 5,
    attentionRemindHours: 4,
    negativeExamplesRetained: 10,
    positiveExamplesRetained: 20,
    dailyCostCapUsd: 2.0,
  },
}));

import { _initTestDatabase, _closeDatabase } from '../db.js';
import { logEvent } from '../event-log.js';
import {
  generateDigest,
  runDailyDigest,
  computeArchiveDashboardCounts,
} from '../daily-digest.js';
import { insertTrackedItem } from '../tracked-items.js';

describe('daily-digest', () => {
  beforeEach(() => {
    _initTestDatabase();
    mockRenderArchiveDashboard.mockClear();
  });

  afterEach(() => {
    _closeDatabase();
    delete process.env.TRIAGE_V1_ENABLED;
    delete process.env.EMAIL_INTEL_TG_CHAT_ID;
  });

  it('generates a quiet digest when no events exist', () => {
    const result = generateDigest('main@jid');
    expect(result).toContain('Daily Digest');
    expect(result).toContain('Quiet night');
  });

  it('includes event type counts', () => {
    const now = Date.now();
    logEvent({
      type: 'message.inbound',
      source: 'channel',
      timestamp: now - 1000,
      payload: {},
    });
    logEvent({
      type: 'message.inbound',
      source: 'channel',
      timestamp: now - 2000,
      payload: {},
    });
    logEvent({
      type: 'task.complete',
      source: 'executor',
      timestamp: now - 3000,
      payload: {},
    });

    const result = generateDigest('main@jid', now);
    expect(result).toContain('Daily Digest');
    expect(result).toContain('Messages received: 2');
    expect(result).toContain('Tasks completed: 1');
  });

  it('highlights errors', () => {
    const now = Date.now();
    logEvent({
      type: 'system.error',
      source: 'event-bus',
      timestamp: now - 1000,
      payload: { error: 'test', handler: 'h', originalEvent: 'e' },
    });

    const result = generateDigest('main@jid', now);
    expect(result).toContain('1 error(s)');
  });

  it('includes email counts', () => {
    const now = Date.now();
    logEvent({
      type: 'email.received',
      source: 'email-sse',
      timestamp: now - 1000,
      payload: { count: 5, emails: [], connection: 'default' },
    });
    logEvent({
      type: 'email.received',
      source: 'email-sse',
      timestamp: now - 2000,
      payload: { count: 3, emails: [], connection: 'default' },
    });

    const result = generateDigest('main@jid', now);
    expect(result).toContain('8 email(s)');
    expect(result).toContain('2 batch(es)');
  });

  it('runDailyDigest skips when no main group', async () => {
    const sendMessage = vi.fn();
    await runDailyDigest({
      sendMessage,
      getMainGroupJid: () => undefined,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('runDailyDigest sends digest to main group', async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await runDailyDigest({
      sendMessage,
      getMainGroupJid: () => 'main@jid',
    });
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(sendMessage.mock.calls[0][0]).toBe('main@jid');
    expect(sendMessage.mock.calls[0][1]).toContain('Daily Digest');
  });

  it('runDailyDigest renders archive dashboard with counts from digest-queued items', async () => {
    process.env.EMAIL_INTEL_TG_CHAT_ID = '-100123';

    const now = Date.now();
    const base = {
      group_name: 'main',
      state: 'queued' as const,
      classification: 'digest' as const,
      superpilot_label: null,
      trust_tier: null,
      summary: null,
      thread_id: null,
      pushed_at: null,
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: null,
      metadata: null,
      confidence: 0.9,
      model_tier: 1,
      facts_extracted: null,
      repo_candidates: null,
      reasons: null,
    };

    insertTrackedItem({
      ...base,
      id: 'a1',
      source: 'gmail',
      source_id: 'gmail:a1',
      title: 'Newsletter 1',
      detected_at: now,
      action_intent: 'newsletter',
    });
    insertTrackedItem({
      ...base,
      id: 'a2',
      source: 'gmail',
      source_id: 'gmail:a2',
      title: 'Newsletter 2',
      detected_at: now,
      action_intent: 'newsletter',
    });
    insertTrackedItem({
      ...base,
      id: 'a3',
      source: 'gmail',
      source_id: 'gmail:a3',
      title: 'Receipt',
      detected_at: now,
      action_intent: 'receipt',
    });
    insertTrackedItem({
      ...base,
      id: 'a4',
      source: 'gmail',
      source_id: 'gmail:a4',
      title: 'Misc',
      detected_at: now,
      action_intent: null,
    });

    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await runDailyDigest({
      sendMessage,
      getMainGroupJid: () => 'main@jid',
    });

    expect(mockRenderArchiveDashboard).toHaveBeenCalledOnce();
    const arg = mockRenderArchiveDashboard.mock.calls[0][0];
    expect(arg.chatId).toBe('-100123');
    expect(arg.total).toBe(4);
    expect(arg.counts).toEqual({
      newsletter: 2,
      receipt: 1,
      uncategorized: 1,
    });
    expect(typeof arg.nextDigestHuman).toBe('string');
    expect(arg.nextDigestHuman.length).toBeGreaterThan(0);
  });

  it('runDailyDigest skips archive dashboard when chat id is not set', async () => {
    delete process.env.EMAIL_INTEL_TG_CHAT_ID;
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    await runDailyDigest({
      sendMessage,
      getMainGroupJid: () => 'main@jid',
    });
    expect(mockRenderArchiveDashboard).not.toHaveBeenCalled();
  });

  it('computeArchiveDashboardCounts groups by action_intent with uncategorized fallback', () => {
    const now = Date.now();
    const base = {
      group_name: 'main',
      state: 'queued' as const,
      classification: 'digest' as const,
      superpilot_label: null,
      trust_tier: null,
      summary: null,
      thread_id: null,
      pushed_at: null,
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: null,
      metadata: null,
      confidence: 0.9,
      model_tier: 1,
      facts_extracted: null,
      repo_candidates: null,
      reasons: null,
    };
    insertTrackedItem({
      ...base,
      id: 'c1',
      source: 'gmail',
      source_id: 'gmail:c1',
      title: 't1',
      detected_at: now,
      action_intent: 'newsletter',
    });
    insertTrackedItem({
      ...base,
      id: 'c2',
      source: 'gmail',
      source_id: 'gmail:c2',
      title: 't2',
      detected_at: now,
      action_intent: '',
    });

    const { counts, total } = computeArchiveDashboardCounts();
    expect(total).toBe(2);
    expect(counts).toEqual({ newsletter: 1, uncategorized: 1 });
  });
});
