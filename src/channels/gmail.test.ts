import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy\r\nX-Injected: bad',
  GMAIL_POLL_INTERVAL: 60_000,
  IMAP_HOST: 'imap.gmail.com',
  IMAP_PORT: 993,
  IMAP_USER: 'bot@example.com',
  IMAP_PASS: 'secret',
  EMAIL_SNAK_ADDRESS: 'snak@example.com',
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock db
vi.mock('../db.js', () => ({
  getLastSender: vi.fn(() => null),
  messageExists: vi.fn(() => false),
}));

// Mock env
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Mock circuit-breaker — use a real-ish implementation so we can test state transitions
const mockBreakerCall = vi.fn();
const mockBreakerState = { value: 'closed' as string };
const mockBreakerBackoffMs = { value: 1000 };

vi.mock('../circuit-breaker.js', () => {
  return {
    CircuitBreaker: class MockCircuitBreaker {
      get state() { return mockBreakerState.value; }
      get backoffMs() { return mockBreakerBackoffMs.value; }
      call = mockBreakerCall;
    },
  };
});

// Track sendMail calls
const mockSendMail = vi.fn().mockResolvedValue(undefined);

// Mock nodemailer
vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: mockSendMail,
    })),
  },
}));

// Mock ImapFlow
const mockImapConnect = vi.fn().mockResolvedValue(undefined);
const mockImapLogout = vi.fn().mockResolvedValue(undefined);
const mockImapSearch = vi.fn().mockResolvedValue([]);
const mockImapFetchOne = vi.fn();
const mockImapFlagsAdd = vi.fn().mockResolvedValue(undefined);
const mockLockRelease = vi.fn();
const mockGetMailboxLock = vi.fn().mockResolvedValue({ release: mockLockRelease });

vi.mock('imapflow', () => {
  return {
    ImapFlow: class MockImapFlow {
      connect = mockImapConnect;
      logout = mockImapLogout;
      search = mockImapSearch;
      fetchOne = mockImapFetchOne;
      messageFlagsAdd = mockImapFlagsAdd;
      getMailboxLock = mockGetMailboxLock;
    },
  };
});

import { GmailChannel, GmailChannelOpts } from './gmail.js';
import { getLastSender, messageExists } from '../db.js';
import { logger } from '../logger.js';

// --- Helpers ---

function createTestOpts(overrides?: Partial<GmailChannelOpts>): GmailChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'email:snak@example.com:customer@test.com': {
        name: 'Customer Email',
        folder: 'customer-email',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function makeEmailSource(opts: {
  from?: string;
  fromName?: string;
  subject?: string;
  body?: string;
  headers?: Record<string, string>;
}): Buffer {
  const from = opts.fromName
    ? `${opts.fromName} <${opts.from || 'customer@test.com'}>`
    : opts.from || 'customer@test.com';
  let headerStr = `From: ${from}\r\nTo: snak@example.com\r\nSubject: ${opts.subject || 'Test'}\r\nContent-Type: text/plain\r\n`;
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      headerStr += `${k}: ${v}\r\n`;
    }
  }
  const body = opts.body || 'Hello there';
  return Buffer.from(`${headerStr}\r\n${body}`);
}

// --- Tests ---

describe('GmailChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBreakerState.value = 'closed';
    mockBreakerCall.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('returns true for email: prefixed JIDs', () => {
      const channel = new GmailChannel(createTestOpts());
      expect(channel.ownsJid('email:snak@example.com:customer@test.com')).toBe(true);
      expect(channel.ownsJid('email:bot@example.com')).toBe(true);
    });

    it('returns false for non-email JIDs', () => {
      const channel = new GmailChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('tg:12345')).toBe(false);
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- isConnected ---

  describe('isConnected', () => {
    it('returns false before connect()', () => {
      const channel = new GmailChannel(createTestOpts());
      expect(channel.isConnected()).toBe(false);
    });

    it('returns true after successful connect', async () => {
      const channel = new GmailChannel(createTestOpts());
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
      await channel.disconnect();
    });

    it('returns false after disconnect', async () => {
      const channel = new GmailChannel(createTestOpts());
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Email sanitization ---

  describe('email sanitization', () => {
    it('strips newlines from ASSISTANT_NAME in From header', async () => {
      const channel = new GmailChannel(createTestOpts());
      await channel.connect();

      // Set up a known customer via per-sender JID format
      const jid = 'email:snak@example.com:customer@test.com';
      await channel.sendMessage(jid, 'Hello!');

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: expect.not.stringContaining('\r'),
        }),
      );
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: expect.not.stringContaining('\n'),
        }),
      );
      // Verify the sanitized name is used
      const call = mockSendMail.mock.calls[0][0];
      expect(call.from).toBe('AndyX-Injected: bad - Snak Group <snak@example.com>');
    });

    it('rejects customer email with injection characters', async () => {
      const channel = new GmailChannel(createTestOpts());
      await channel.connect();

      // Email with newline injection
      await channel.sendMessage('email:snak@example.com:evil@test.com\r\nBcc:spy@evil.com', 'Hello');
      expect(mockSendMail).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ customerEmail: expect.any(String) }),
        expect.stringContaining('Invalid customer email'),
      );
    });

    it('rejects customer email with spaces', async () => {
      const channel = new GmailChannel(createTestOpts());
      await channel.connect();

      await channel.sendMessage('email:snak@example.com:evil @test.com', 'Hello');
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it('rejects customer email with semicolons', async () => {
      const channel = new GmailChannel(createTestOpts());
      await channel.connect();

      await channel.sendMessage('email:snak@example.com:a@test.com;b@test.com', 'Hello');
      expect(mockSendMail).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends text via SMTP transporter', async () => {
      const channel = new GmailChannel(createTestOpts());
      await channel.connect();

      await channel.sendMessage('email:snak@example.com:customer@test.com', 'Thanks for your email!');

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: 'customer@test.com',
          text: 'Thanks for your email!',
          subject: 'Re: Your inquiry',
        }),
      );
    });

    it('does nothing if no transporter configured', async () => {
      const channel = new GmailChannel(createTestOpts());
      // Don't call connect() — transporter is null
      await channel.sendMessage('email:snak@example.com:customer@test.com', 'Hello');
      expect(mockSendMail).not.toHaveBeenCalled();
    });

    it('falls back to db lookup for old-format JIDs', async () => {
      vi.mocked(getLastSender).mockReturnValue('fallback@test.com');
      const channel = new GmailChannel(createTestOpts());
      await channel.connect();

      await channel.sendMessage('email:snak@example.com', 'Hello');

      expect(getLastSender).toHaveBeenCalledWith('email:snak@example.com');
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'fallback@test.com' }),
      );
    });

    it('warns and skips if no customer email can be determined', async () => {
      vi.mocked(getLastSender).mockReturnValue(null);
      const channel = new GmailChannel(createTestOpts());
      await channel.connect();

      await channel.sendMessage('email:snak@example.com', 'Hello');
      expect(mockSendMail).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'email:snak@example.com' }),
        expect.stringContaining('No customer email'),
      );
    });

    it('logs error on SMTP failure but does not throw', async () => {
      mockSendMail.mockRejectedValueOnce(new Error('SMTP down'));
      const channel = new GmailChannel(createTestOpts());
      await channel.connect();

      await expect(
        channel.sendMessage('email:snak@example.com:customer@test.com', 'Hello'),
      ).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalled();
    });
  });

  // --- Self-send detection ---

  describe('self-send detection', () => {
    it('skips messages from own IMAP address', async () => {
      const opts = createTestOpts();
      const channel = new GmailChannel(opts);
      await channel.connect();

      // Set up poll to return a message from bot's own address
      mockImapSearch.mockResolvedValueOnce([1]);
      mockImapFetchOne.mockResolvedValueOnce({
        envelope: {
          from: [{ address: 'bot@example.com', name: 'Bot' }],
          subject: 'Test',
          messageId: 'self-1',
          date: new Date(),
        },
        source: makeEmailSource({ from: 'bot@example.com' }),
      });

      await (channel as any).pollInbox();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips messages from EMAIL_SNAK_ADDRESS', async () => {
      const opts = createTestOpts();
      const channel = new GmailChannel(opts);
      await channel.connect();

      mockImapSearch.mockResolvedValueOnce([1]);
      mockImapFetchOne.mockResolvedValueOnce({
        envelope: {
          from: [{ address: 'snak@example.com', name: 'Snak' }],
          subject: 'Test',
          messageId: 'self-2',
          date: new Date(),
        },
        source: makeEmailSource({ from: 'snak@example.com' }),
      });

      await (channel as any).pollInbox();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips messages where sender name contains assistant name', async () => {
      const opts = createTestOpts();
      const channel = new GmailChannel(opts);
      await channel.connect();

      mockImapSearch.mockResolvedValueOnce([1]);
      mockImapFetchOne.mockResolvedValueOnce({
        envelope: {
          from: [{ address: 'relay@other.com', name: 'Andy - Snak Group' }],
          subject: 'Test',
          messageId: 'self-3',
          date: new Date(),
        },
        source: makeEmailSource({ from: 'relay@other.com', fromName: 'Andy - Snak Group' }),
      });

      await (channel as any).pollInbox();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- shouldProcess filter ---

  describe('sender filter via shouldProcess', () => {
    it('rejects messages when shouldProcess returns false', async () => {
      const shouldProcess = vi.fn().mockReturnValue(false);
      const opts = createTestOpts({ shouldProcess });
      const channel = new GmailChannel(opts);
      await channel.connect();

      mockImapSearch.mockResolvedValueOnce([1]);
      mockImapFetchOne.mockResolvedValueOnce({
        envelope: {
          from: [{ address: 'noreply@service.com', name: 'Service' }],
          subject: 'Notification',
          messageId: 'filter-1',
          date: new Date(),
        },
        source: makeEmailSource({ from: 'noreply@service.com', subject: 'Notification' }),
      });

      await (channel as any).pollInbox();

      expect(shouldProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          sender: 'noreply@service.com',
          channel: 'gmail',
        }),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('passes rawHeaders and subject to shouldProcess', async () => {
      const shouldProcess = vi.fn().mockReturnValue(true);
      const opts = createTestOpts({ shouldProcess });
      const channel = new GmailChannel(opts);
      await channel.connect();

      mockImapSearch.mockResolvedValueOnce([1]);
      mockImapFetchOne.mockResolvedValueOnce({
        envelope: {
          from: [{ address: 'customer@test.com', name: 'Customer' }],
          subject: 'Hello',
          messageId: 'filter-2',
          date: new Date(),
        },
        source: makeEmailSource({
          from: 'customer@test.com',
          subject: 'Hello',
          headers: { 'Auto-Submitted': 'auto-replied' },
        }),
      });

      await (channel as any).pollInbox();

      expect(shouldProcess).toHaveBeenCalledWith(
        expect.objectContaining({
          rawHeaders: expect.stringContaining('Auto-Submitted: auto-replied'),
          subject: 'Hello',
        }),
      );
    });
  });

  // --- Circuit breaker ---

  describe('circuit breaker states', () => {
    it('skips connection when circuit breaker is open', async () => {
      mockBreakerState.value = 'open';
      const channel = new GmailChannel(createTestOpts());
      await channel.connect();

      expect(channel.isConnected()).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ breaker: 'gmail-imap' }),
        expect.stringContaining('circuit breaker open'),
      );
      await channel.disconnect();
    });

    it('sets connected=false when IMAP connection fails', async () => {
      mockBreakerCall.mockRejectedValueOnce(new Error('IMAP auth failed'));
      const channel = new GmailChannel(createTestOpts());
      await channel.connect();

      expect(channel.isConnected()).toBe(false);
      await channel.disconnect();
    });
  });

  // --- Message dedup ---

  describe('message dedup', () => {
    it('skips messages already in DB', async () => {
      vi.mocked(messageExists).mockReturnValue(true);
      const opts = createTestOpts();
      const channel = new GmailChannel(opts);
      await channel.connect();

      mockImapSearch.mockResolvedValueOnce([1]);
      mockImapFetchOne.mockResolvedValueOnce({
        envelope: {
          from: [{ address: 'customer@test.com', name: 'Customer' }],
          subject: 'Hello',
          messageId: 'dup-msg-1',
          date: new Date(),
        },
        source: makeEmailSource({ from: 'customer@test.com' }),
      });

      await (channel as any).pollInbox();

      expect(messageExists).toHaveBeenCalledWith('dup-msg-1');
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Full inbound flow ---

  describe('inbound message delivery', () => {
    it('delivers a valid email to onMessage', async () => {
      vi.mocked(messageExists).mockReturnValue(false);
      const opts = createTestOpts();
      const channel = new GmailChannel(opts);
      await channel.connect();

      const testDate = new Date('2024-06-15T12:00:00Z');
      mockImapSearch.mockResolvedValueOnce([42]);
      mockImapFetchOne.mockResolvedValueOnce({
        envelope: {
          from: [{ address: 'customer@test.com', name: 'Jane Doe' }],
          subject: 'Pricing question',
          messageId: 'valid-1',
          date: testDate,
        },
        source: makeEmailSource({
          from: 'customer@test.com',
          fromName: 'Jane Doe',
          subject: 'Pricing question',
          body: 'How much does it cost?',
        }),
      });

      await (channel as any).pollInbox();

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'email:snak@example.com:customer@test.com',
        testDate.toISOString(),
        'Email snak@example.com',
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'email:snak@example.com:customer@test.com',
        expect.objectContaining({
          id: 'valid-1',
          chat_jid: 'email:snak@example.com:customer@test.com',
          sender: 'customer@test.com',
          sender_name: 'Jane Doe',
          content: expect.stringContaining('Pricing question'),
          is_from_me: false,
        }),
      );
    });

    it('skips unregistered JIDs without registerDerivedGroup', async () => {
      vi.mocked(messageExists).mockReturnValue(false);
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({})), // no groups registered
      });
      const channel = new GmailChannel(opts);
      await channel.connect();

      mockImapSearch.mockResolvedValueOnce([1]);
      mockImapFetchOne.mockResolvedValueOnce({
        envelope: {
          from: [{ address: 'unknown@test.com', name: 'Unknown' }],
          subject: 'Hi',
          messageId: 'unreg-1',
          date: new Date(),
        },
        source: makeEmailSource({ from: 'unknown@test.com' }),
      });

      await (channel as any).pollInbox();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('auto-registers derived group when parent is registered', async () => {
      vi.mocked(messageExists).mockReturnValue(false);
      const registerDerivedGroup = vi.fn();
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'email:snak@example.com': {
            name: 'Email Parent',
            folder: 'email-parent',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
        registerDerivedGroup,
      });
      const channel = new GmailChannel(opts);
      await channel.connect();

      mockImapSearch.mockResolvedValueOnce([1]);
      mockImapFetchOne.mockResolvedValueOnce({
        envelope: {
          from: [{ address: 'new-customer@test.com', name: 'New' }],
          subject: 'Hi',
          messageId: 'derive-1',
          date: new Date(),
        },
        source: makeEmailSource({ from: 'new-customer@test.com' }),
      });

      await (channel as any).pollInbox();

      expect(registerDerivedGroup).toHaveBeenCalledWith(
        'email:snak@example.com:new-customer@test.com',
        'email:snak@example.com',
      );
    });
  });

  // --- Disconnect ---

  describe('disconnect', () => {
    it('clears poll and reconnect timers', async () => {
      const channel = new GmailChannel(createTestOpts());
      await channel.connect();
      await channel.disconnect();

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "gmail"', () => {
      const channel = new GmailChannel(createTestOpts());
      expect(channel.name).toBe('gmail');
    });
  });
});
