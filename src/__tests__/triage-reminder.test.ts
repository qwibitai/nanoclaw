import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));
vi.mock('../channels/telegram.js', () => ({
  sendTelegramMessage: mockSend,
  editTelegramMessage: vi.fn(),
  pinTelegramMessage: vi.fn(),
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { _initTestDatabase, _closeDatabase } from '../db.js';
import { runAttentionReminderSweep } from '../triage/reminder.js';
import { insertTrackedItem } from '../tracked-items.js';

describe('runAttentionReminderSweep', () => {
  beforeEach(() => {
    _initTestDatabase();
    mockSend.mockReset();
    process.env.EMAIL_INTEL_TG_CHAT_ID = '-100999';
  });
  afterEach(() => _closeDatabase());

  it('sends reminder for overdue unreminded attention items', async () => {
    const oldMs = Date.now() - 5 * 60 * 60 * 1000;
    insertTrackedItem({
      id: 'r1',
      source: 'gmail',
      source_id: 'gmail:t',
      group_name: 'main',
      state: 'pushed',
      classification: 'push',
      superpilot_label: null,
      trust_tier: null,
      title: 'old one',
      summary: null,
      thread_id: 't',
      detected_at: oldMs,
      pushed_at: oldMs,
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: null,
      metadata: null,
      confidence: 0.9,
      model_tier: 1,
      action_intent: 'none',
      facts_extracted: null,
      repo_candidates: null,
      reasons: ['x', 'y'],
    });

    await runAttentionReminderSweep({ windowHours: 4 });
    expect(mockSend).toHaveBeenCalledTimes(1);

    // Running again: already reminded, should NOT send again
    mockSend.mockReset();
    await runAttentionReminderSweep({ windowHours: 4 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does NOT send for fresh items', async () => {
    insertTrackedItem({
      id: 'r2',
      source: 'gmail',
      source_id: 'gmail:t2',
      group_name: 'main',
      state: 'pushed',
      classification: 'push',
      superpilot_label: null,
      trust_tier: null,
      title: 'fresh',
      summary: null,
      thread_id: 't2',
      detected_at: Date.now(),
      pushed_at: Date.now(),
      resolved_at: null,
      resolution_method: null,
      digest_count: 0,
      telegram_message_id: null,
      classification_reason: null,
      metadata: null,
      confidence: 0.9,
      model_tier: 1,
      action_intent: 'none',
      facts_extracted: null,
      repo_candidates: null,
      reasons: ['x', 'y'],
    });

    await runAttentionReminderSweep({ windowHours: 4 });
    expect(mockSend).not.toHaveBeenCalled();
  });
});
