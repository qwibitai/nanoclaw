import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _closeDatabase, _initTestDatabase, getDb } from '../db.js';

const { mockSend, mockEdit, mockPin } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockEdit: vi.fn(),
  mockPin: vi.fn(),
}));
vi.mock('../channels/telegram.js', () => ({
  sendTelegramMessage: mockSend,
  editTelegramMessage: mockEdit,
  pinTelegramMessage: mockPin,
}));
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { renderAttentionDashboard } from '../triage/dashboards.js';

describe('renderAttentionDashboard', () => {
  beforeEach(() => {
    _initTestDatabase();
    mockSend.mockReset();
    mockEdit.mockReset();
    mockPin.mockReset();
  });
  afterEach(() => _closeDatabase());

  it('posts + pins a new message when none exists', async () => {
    mockSend.mockResolvedValueOnce({ message_id: 42 });
    mockPin.mockResolvedValueOnce({ ok: true });

    await renderAttentionDashboard({
      chatId: '-100123',
      items: [
        {
          id: 'a',
          title: 'PR review requested',
          reason: 'github',
          ageMins: 10,
        },
      ],
    });

    expect(mockSend).toHaveBeenCalled();
    expect(mockPin).toHaveBeenCalledWith('-100123', 42);

    const row = getDb()
      .prepare(
        `SELECT pinned_msg_id FROM triage_dashboards WHERE topic = 'attention'`,
      )
      .get() as { pinned_msg_id: number };
    expect(row.pinned_msg_id).toBe(42);
  });

  it('edits the existing pinned message on subsequent calls', async () => {
    getDb()
      .prepare(
        `INSERT INTO triage_dashboards (topic, telegram_chat_id, pinned_msg_id, last_rendered_at)
         VALUES ('attention', '-100123', 99, ?)`,
      )
      .run(Date.now());

    mockEdit.mockResolvedValueOnce({ message_id: 99 });

    await renderAttentionDashboard({
      chatId: '-100123',
      items: [],
    });
    expect(mockEdit).toHaveBeenCalledWith(
      '-100123',
      99,
      expect.stringContaining('Attention'),
    );
    expect(mockSend).not.toHaveBeenCalled();
  });
});
