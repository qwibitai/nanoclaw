import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  sendSplitMessage,
  extractSenderUserId,
  isGroupChat,
} from './telegram-messaging.js';
import type { TelegramChannel } from './telegram.js';

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('telegram-messaging', () => {
  describe('sendSplitMessage', () => {
    it('sends ack to group and full message to private DM', async () => {
      const sendMessage = vi.fn().mockResolvedValue(undefined);
      const mockChannel = {
        sendMessage,
      } as unknown as TelegramChannel;

      await sendSplitMessage(mockChannel, {
        groupJid: 'tg:-100123456',
        senderUserId: '99001',
        groupAck: 'Got it, check your DMs ✓',
        privateMessage: 'Event created: Team Meeting on March 8th at 2pm',
      });

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage).toHaveBeenNthCalledWith(
        1,
        'tg:-100123456',
        'Got it, check your DMs ✓',
      );
      expect(sendMessage).toHaveBeenNthCalledWith(
        2,
        'tg:99001',
        'Event created: Team Meeting on March 8th at 2pm',
      );
    });

    it('sends fallback to group when private DM is blocked', async () => {
      const sendMessage = vi.fn();
      const mockChannel = {
        sendMessage,
      } as unknown as TelegramChannel;

      // First call (group ack) succeeds
      sendMessage.mockResolvedValueOnce(undefined);
      // Second call (private DM) fails with "bot was blocked"
      sendMessage.mockRejectedValueOnce(
        new Error('Forbidden: bot was blocked by the user'),
      );
      // Third call (fallback to group) succeeds
      sendMessage.mockResolvedValueOnce(undefined);

      await sendSplitMessage(mockChannel, {
        groupJid: 'tg:-100123456',
        senderUserId: '99001',
        groupAck: 'Got it, check your DMs ✓',
        privateMessage: 'Event created: Team Meeting',
      });

      expect(sendMessage).toHaveBeenCalledTimes(3);
      expect(sendMessage).toHaveBeenNthCalledWith(
        3,
        'tg:-100123456',
        expect.stringContaining("couldn't send you a private message"),
      );
      expect(sendMessage).toHaveBeenNthCalledWith(
        3,
        'tg:-100123456',
        expect.stringContaining('/start'),
      );
    });

    it('sends fallback when user has not initiated conversation', async () => {
      const sendMessage = vi.fn();
      const mockChannel = {
        sendMessage,
      } as unknown as TelegramChannel;

      sendMessage.mockResolvedValueOnce(undefined);
      sendMessage.mockRejectedValueOnce(
        new Error("Forbidden: bot can't initiate conversation with a user"),
      );
      sendMessage.mockResolvedValueOnce(undefined);

      await sendSplitMessage(mockChannel, {
        groupJid: 'tg:-100123456',
        senderUserId: '99002',
        groupAck: 'Processing your request ⏳',
        privateMessage: 'Here are the details...',
      });

      expect(sendMessage).toHaveBeenCalledTimes(3);
      const fallbackCall = sendMessage.mock.calls[2];
      expect(fallbackCall[1]).toContain('Processing your request ⏳');
      expect(fallbackCall[1]).toContain('/start');
    });

    it('sends error message for unexpected failures', async () => {
      const sendMessage = vi.fn();
      const mockChannel = {
        sendMessage,
      } as unknown as TelegramChannel;

      sendMessage.mockResolvedValueOnce(undefined);
      sendMessage.mockRejectedValueOnce(new Error('Network timeout'));
      sendMessage.mockResolvedValueOnce(undefined);

      await sendSplitMessage(mockChannel, {
        groupJid: 'tg:-100123456',
        senderUserId: '99003',
        groupAck: 'Scheduled ✓',
        privateMessage: 'Details...',
      });

      expect(sendMessage).toHaveBeenCalledTimes(3);
      const errorCall = sendMessage.mock.calls[2];
      expect(errorCall[1]).toContain('Scheduled ✓');
      expect(errorCall[1]).toContain('Error sending private message');
    });

    it('preserves group ack in all fallback scenarios', async () => {
      const sendMessage = vi.fn();
      const mockChannel = {
        sendMessage,
      } as unknown as TelegramChannel;

      sendMessage.mockResolvedValueOnce(undefined);
      sendMessage.mockRejectedValueOnce(
        new Error('bot was blocked by the user'),
      );
      sendMessage.mockResolvedValueOnce(undefined);

      const groupAck = 'Custom acknowledgment message ✓';
      await sendSplitMessage(mockChannel, {
        groupJid: 'tg:-100123456',
        senderUserId: '99004',
        groupAck,
        privateMessage: 'Details',
      });

      const fallbackMessage = sendMessage.mock.calls[2][1] as string;
      expect(fallbackMessage.startsWith(groupAck)).toBe(true);
    });
  });

  describe('extractSenderUserId', () => {
    it('extracts sender ID from message', () => {
      const message = {
        sender: '12345',
        chat_jid: 'tg:-100999',
      };

      expect(extractSenderUserId(message)).toBe('12345');
    });

    it('returns null when sender is missing', () => {
      const message = {
        sender: '',
        chat_jid: 'tg:-100999',
      };

      expect(extractSenderUserId(message)).toBeNull();
    });

    it('handles Telegram user IDs as strings', () => {
      const message = {
        sender: '987654321',
        chat_jid: 'tg:-100123456',
      };

      expect(extractSenderUserId(message)).toBe('987654321');
    });
  });

  describe('isGroupChat', () => {
    it('identifies group chat by type', () => {
      expect(isGroupChat('tg:-100123456', 'group')).toBe(true);
      expect(isGroupChat('tg:-100123456', 'supergroup')).toBe(true);
    });

    it('identifies private chat by type', () => {
      expect(isGroupChat('tg:12345', 'private')).toBe(false);
    });

    it('infers group from negative JID when type is missing', () => {
      expect(isGroupChat('tg:-100123456')).toBe(true);
      expect(isGroupChat('tg:-1001234567890')).toBe(true);
    });

    it('infers private from positive JID when type is missing', () => {
      expect(isGroupChat('tg:12345')).toBe(false);
      expect(isGroupChat('tg:987654321')).toBe(false);
    });

    it('prefers explicit chatType over JID inference', () => {
      // Even though JID is negative, explicit type overrides
      expect(isGroupChat('tg:-100123456', 'private')).toBe(false);
    });
  });
});
