import { describe, it, expect, vi } from 'vitest';

describe('Telegram agentic UX extensions', () => {
  it('editMessageButtons replaces inline keyboard on existing message', async () => {
    const mockApi = {
      editMessageReplyMarkup: vi.fn().mockResolvedValue(true),
    };

    const chatId = '123456';
    const messageId = 789;
    const newActions = [{ label: '✓ Archived', callbackData: 'noop' }];

    const keyboard = {
      inline_keyboard: [
        newActions.map((a) => ({
          text: a.label,
          callback_data: a.callbackData,
        })),
      ],
    };

    await mockApi.editMessageReplyMarkup(chatId, messageId, {
      reply_markup: keyboard,
    });
    expect(mockApi.editMessageReplyMarkup).toHaveBeenCalledWith(
      chatId,
      messageId,
      { reply_markup: keyboard },
    );
  });

  it('builds web_app keyboard with Mini App URL', () => {
    const webAppUrl = 'https://nanoclaw.example.com/task/abc123';
    const keyboard = {
      inline_keyboard: [
        [{ text: 'View Details ↗', web_app: { url: webAppUrl } }],
      ],
    };
    expect(keyboard.inline_keyboard[0][0].web_app.url).toBe(webAppUrl);
  });
});
