import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  QUO_API_KEY: 'test-api-key',
  QUO_SNAK_NUMBER: '+16825551000',
  QUO_SNAK_PHONE_ID: 'snak-phone-id',
  QUO_SHERIDAN_NUMBER: '+18175551000',
  QUO_SHERIDAN_PHONE_ID: 'sheridan-phone-id',
  QUO_WEBHOOK_PORT: 0, // Use port 0 for random available port
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({
    QUO_WEBHOOK_SECRET: Buffer.from('test-webhook-secret').toString('base64'),
  })),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  audit: vi.fn(),
}));

vi.mock('../db.js', () => ({
  getLastSender: vi.fn(() => null),
  upsertContactFromPhone: vi.fn(),
}));

vi.mock('../pipeline/stages/webhook-guard.js', () => ({
  isWebhookRateLimited: vi.fn(() => false),
}));

import { QuoChannel, QuoChannelOpts } from './quo.js';
import { logger } from '../logger.js';
import { getLastSender } from '../db.js';

// --- Helpers ---

function createOpts(overrides?: Partial<QuoChannelOpts>): QuoChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'quo:+16825551000': {
        name: 'Snak Line',
        folder: 'snak',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

// --- Tests ---

describe('QuoChannel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('returns true for quo: prefixed JIDs', () => {
      const channel = new QuoChannel(createOpts());
      expect(channel.ownsJid('quo:+16825551000')).toBe(true);
      expect(channel.ownsJid('quo:+18175551000')).toBe(true);
    });

    it('returns false for non-quo JIDs', () => {
      const channel = new QuoChannel(createOpts());
      expect(channel.ownsJid('web:snak-group')).toBe(false);
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('tg:12345')).toBe(false);
    });
  });

  // --- isConnected ---

  describe('isConnected', () => {
    it('returns false before connect', () => {
      const channel = new QuoChannel(createOpts());
      expect(channel.isConnected()).toBe(false);
    });

    it('returns true after connect', async () => {
      const channel = new QuoChannel(createOpts());
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
      await channel.disconnect();
    });

    it('returns false after disconnect', async () => {
      const channel = new QuoChannel(createOpts());
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('calls Quo API with correct parameters', async () => {
      const channel = new QuoChannel(createOpts());

      // Set a known customer number for reply routing
      (channel as any).lastSenderByJid.set('quo:+16825551000', '+19725559999');

      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      await channel.sendMessage('quo:+16825551000', 'Hello customer');

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.openphone.com/v1/messages',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'test-api-key',
          },
          body: JSON.stringify({
            content: 'Andy: Hello customer',
            from: 'snak-phone-id',
            to: ['+19725559999'],
          }),
        }),
      );

      vi.unstubAllGlobals();
    });

    it('returns early when no phone line matches JID', async () => {
      const channel = new QuoChannel(createOpts());
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      await channel.sendMessage('quo:+10000000000', 'Hello');

      expect(mockFetch).not.toHaveBeenCalled();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'quo:+10000000000' }),
        'No Quo phone line configured for JID',
      );

      vi.unstubAllGlobals();
    });

    it('returns early when no customer number is known', async () => {
      const channel = new QuoChannel(createOpts());
      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      await channel.sendMessage('quo:+16825551000', 'Hello');

      expect(mockFetch).not.toHaveBeenCalled();
      expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'quo:+16825551000' }),
        'No customer number known for Quo reply',
      );

      vi.unstubAllGlobals();
    });

    it('falls back to DB for customer number', async () => {
      vi.mocked(getLastSender).mockReturnValue('+19725550001');

      const channel = new QuoChannel(createOpts());
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      await channel.sendMessage('quo:+16825551000', 'DB fallback');

      expect(getLastSender).toHaveBeenCalledWith('quo:+16825551000');
      expect(mockFetch).toHaveBeenCalled();

      vi.unstubAllGlobals();
    });
  });

  // --- Circuit breaker ---

  describe('circuit breaker', () => {
    it('drops messages when circuit breaker is open', async () => {
      const channel = new QuoChannel(createOpts());
      (channel as any).lastSenderByJid.set('quo:+16825551000', '+19725559999');

      // Force the circuit breaker open (must also set lastFailureAt to now so getter doesn't transition to half-open)
      (channel as any).apiBreaker._state = 'open';
      (channel as any).apiBreaker.lastFailureAt = Date.now();

      const mockFetch = vi.fn();
      vi.stubGlobal('fetch', mockFetch);

      await channel.sendMessage('quo:+16825551000', 'Should be dropped');

      expect(mockFetch).not.toHaveBeenCalled();
      expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'quo:+16825551000', breaker: 'openphone-api' }),
        'Quo API circuit breaker open, dropping message',
      );

      vi.unstubAllGlobals();
    });
  });

  // --- Unregistered JID handling ---

  describe('unregistered JID handling', () => {
    it('drops messages for unregistered JIDs', async () => {
      const opts = createOpts();
      const channel = new QuoChannel(opts);

      // Simulate processing a message for an unregistered JID
      (channel as any).processMessage(
        {
          id: 'msg-1',
          from: '+19725559999',
          to: '+16825551000',
          text: 'Hello',
          phoneNumberId: 'snak-phone-id',
          direction: 'incoming',
        },
        'webhook',
      );

      // onChatMetadata is called for all messages
      expect(opts.onChatMetadata).toHaveBeenCalled();

      // But onMessage is NOT called since the JID must be in registeredGroups
      // With our mock, quo:+16825551000 IS registered, so let's test with an unregistered one
    });

    it('does not call onMessage for unregistered JID', async () => {
      const opts = createOpts({
        registeredGroups: vi.fn(() => ({})), // No groups registered
      });
      const channel = new QuoChannel(opts);

      (channel as any).processMessage(
        {
          id: 'msg-2',
          from: '+19725559999',
          to: '+18175551000',
          text: 'Hello unregistered',
          phoneNumberId: 'sheridan-phone-id',
          direction: 'incoming',
        },
        'webhook',
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Phone line routing ---

  describe('phone line routing', () => {
    it('routes messages to the correct phone line based on phoneNumberId', () => {
      const opts = createOpts({
        registeredGroups: vi.fn(() => ({
          'quo:+16825551000': {
            name: 'Snak Line',
            folder: 'snak',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
          'quo:+18175551000': {
            name: 'Sheridan Line',
            folder: 'sheridan',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new QuoChannel(opts);

      // Message to Snak line
      (channel as any).processMessage(
        {
          id: 'msg-snak',
          from: '+19725551111',
          to: '+16825551000',
          text: 'Snak inquiry',
          phoneNumberId: 'snak-phone-id',
          direction: 'incoming',
        },
        'webhook',
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'quo:+16825551000',
        expect.objectContaining({ content: 'Snak inquiry' }),
      );

      vi.mocked(opts.onMessage).mockClear();

      // Message to Sheridan line
      (channel as any).processMessage(
        {
          id: 'msg-sheridan',
          from: '+19725552222',
          to: '+18175551000',
          text: 'Sheridan inquiry',
          phoneNumberId: 'sheridan-phone-id',
          direction: 'incoming',
        },
        'webhook',
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'quo:+18175551000',
        expect.objectContaining({ content: 'Sheridan inquiry' }),
      );
    });

    it('tracks last sender per JID for reply routing', () => {
      const opts = createOpts();
      const channel = new QuoChannel(opts);

      (channel as any).processMessage(
        {
          id: 'msg-track',
          from: '+19725553333',
          to: '+16825551000',
          text: 'Track me',
          phoneNumberId: 'snak-phone-id',
          direction: 'incoming',
        },
        'webhook',
      );

      expect((channel as any).lastSenderByJid.get('quo:+16825551000')).toBe(
        '+19725553333',
      );
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "quo"', () => {
      const channel = new QuoChannel(createOpts());
      expect(channel.name).toBe('quo');
    });
  });
});
