import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _closeDatabase, _initTestDatabase } from '../db.js';

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

import { pushAttentionItem } from '../triage/push-attention.js';

describe('pushAttentionItem', () => {
  beforeEach(() => {
    _initTestDatabase();
    mockSend.mockReset();
  });
  afterEach(() => _closeDatabase());

  it('sends a message with the full set of inline buttons', async () => {
    mockSend.mockResolvedValueOnce({ message_id: 101 });
    await pushAttentionItem({
      chatId: '-100456',
      itemId: 'x1',
      title: 'PR #42 review requested',
      reason: 'direct review ask',
      sender: 'alice@example.com',
    });

    expect(mockSend).toHaveBeenCalledTimes(1);
    const [, text, opts] = mockSend.mock.calls[0];
    expect(text).toContain('PR #42');
    expect(text).toContain('alice@example.com');
    expect(opts.reply_markup.inline_keyboard).toBeDefined();
    const flat = (
      opts.reply_markup.inline_keyboard as Array<
        Array<{ callback_data: string }>
      >
    )
      .flat()
      .map((b) => b.callback_data);
    expect(flat).toEqual(
      expect.arrayContaining([
        'triage:dismiss:x1',
        'triage:snooze:1h:x1',
        'triage:snooze:tomorrow:x1',
        'triage:archive:x1',
        'triage:override:archive:x1',
      ]),
    );
  });
});
