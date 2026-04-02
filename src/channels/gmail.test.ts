import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock backoff
vi.mock('../backoff.js', () => ({
  calculateBackoff: vi.fn((errors: number, base: number, _max: number) =>
    errors > 0 ? base * Math.pow(2, errors) : base,
  ),
}));

// Mock googleapis
vi.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: vi.fn().mockImplementation(() => ({
        setCredentials: vi.fn(),
        on: vi.fn(),
      })),
    },
    gmail: vi.fn(() => ({})),
  },
  gmail_v1: {},
}));

// Mock fs — no top-level variable references allowed in factory
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn((filePath: string) => {
        if (String(filePath).includes('gmail-send-allowlist.json')) {
          return JSON.stringify({
            direct_send: [
              'eline@bestoftours.co.uk',
              'ahmed@bestoftours.co.uk',
              'yacine@bestoftours.co.uk',
            ],
            notify_email: 'yacine@bestoftours.co.uk',
            cc_email: 'yacine@bestoftours.co.uk',
          });
        }
        if (String(filePath).includes('gcp-oauth.keys.json')) {
          return JSON.stringify({
            installed: {
              client_id: 'test-id',
              client_secret: 'test-secret',
              redirect_uris: ['http://localhost'],
            },
          });
        }
        if (String(filePath).includes('credentials.json')) {
          return JSON.stringify({
            access_token: 'test-token',
            refresh_token: 'test-refresh',
          });
        }
        throw new Error(`Unexpected readFileSync: ${filePath}`);
      }),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
    },
  };
});

import { GmailChannel, GmailChannelOpts } from './gmail.js';
import { logger } from '../logger.js';
import { calculateBackoff } from '../backoff.js';

// --- Gmail API mock functions ---
const mockSend = vi.fn().mockResolvedValue({});
const mockDraftsCreate = vi.fn().mockResolvedValue({ data: { id: 'draft-1' } });
const mockMessagesList = vi.fn().mockResolvedValue({ data: { messages: [] } });
const mockMessagesGet = vi.fn();
const mockMessagesModify = vi.fn().mockResolvedValue({});

function makeGmailMock() {
  return {
    users: {
      getProfile: vi
        .fn()
        .mockResolvedValue({ data: { emailAddress: 'bot@company.com' } }),
      messages: {
        list: mockMessagesList,
        get: mockMessagesGet,
        send: mockSend,
        modify: mockMessagesModify,
      },
      drafts: {
        create: mockDraftsCreate,
      },
    },
  };
}

function makeOpts(overrides?: Partial<GmailChannelOpts>): GmailChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({
      'main-jid': {
        name: 'Main Group',
        folder: 'main',
        trigger: '',
        added_at: '2024-01-01T00:00:00.000Z',
        isMain: true,
      },
    }),
    ...overrides,
  };
}

/**
 * Helper to create a GmailChannel with mocked gmail client set directly.
 */
function createConnectedChannel(opts: GmailChannelOpts): GmailChannel {
  const channel = new GmailChannel(opts, 60000);
  const any = channel as any;
  any.gmail = makeGmailMock();
  any.userEmail = 'bot@company.com';
  return channel;
}

describe('GmailChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Remove env overrides
    delete process.env.GMAIL_DIRECT_SEND_ALLOWLIST;
    delete process.env.GMAIL_NOTIFY_EMAIL;
    delete process.env.GMAIL_CC_EMAIL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // --- Basic channel properties ---

  describe('ownsJid', () => {
    it('returns true for gmail: prefixed JIDs', () => {
      const ch = new GmailChannel(makeOpts());
      expect(ch.ownsJid('gmail:abc123')).toBe(true);
      expect(ch.ownsJid('gmail:thread-id-456')).toBe(true);
    });

    it('returns false for non-gmail JIDs', () => {
      const ch = new GmailChannel(makeOpts());
      expect(ch.ownsJid('12345@g.us')).toBe(false);
      expect(ch.ownsJid('tg:123')).toBe(false);
      expect(ch.ownsJid('gchat:spaces/abc')).toBe(false);
    });
  });

  describe('name', () => {
    it('is gmail', () => {
      expect(new GmailChannel(makeOpts()).name).toBe('gmail');
    });
  });

  describe('isConnected', () => {
    it('returns false before connect', () => {
      expect(new GmailChannel(makeOpts()).isConnected()).toBe(false);
    });

    it('returns true when gmail client is set', () => {
      const ch = createConnectedChannel(makeOpts());
      expect(ch.isConnected()).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('sets connected to false and clears timer', async () => {
      const ch = createConnectedChannel(makeOpts());
      await ch.disconnect();
      expect(ch.isConnected()).toBe(false);
    });
  });

  // --- sendMessage: direct send (allowlisted recipient) ---

  describe('sendMessage direct send', () => {
    it('sends email directly when recipient is in allowlist', async () => {
      vi.useFakeTimers();
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      any.threadMeta.set('thread-1', {
        sender: 'ahmed@bestoftours.co.uk',
        senderName: 'Ahmed',
        subject: 'Test Subject',
        messageId: '<msg-1@mail.com>',
      });

      await ch.sendMessage('gmail:thread-1', 'Hello Ahmed');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const callArgs = mockSend.mock.calls[0][0];
      expect(callArgs.userId).toBe('me');
      expect(callArgs.requestBody.threadId).toBe('thread-1');

      // Decode the raw email to verify headers
      const raw = callArgs.requestBody.raw;
      const decoded = Buffer.from(raw, 'base64').toString('utf-8');
      expect(decoded).toContain('To: ahmed@bestoftours.co.uk');
      expect(decoded).toContain('Subject: Re: Test Subject');
      expect(decoded).toContain('Cc: yacine@bestoftours.co.uk');
      expect(decoded).toContain('Hello Ahmed');
    });

    it('does not add CC when sending to yacine@', async () => {
      vi.useFakeTimers();
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      any.threadMeta.set('thread-2', {
        sender: 'yacine@bestoftours.co.uk',
        senderName: 'Yacine',
        subject: 'Important',
        messageId: '<msg-2@mail.com>',
      });

      await ch.sendMessage('gmail:thread-2', 'Hi Yacine');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const raw = mockSend.mock.calls[0][0].requestBody.raw;
      const decoded = Buffer.from(raw, 'base64').toString('utf-8');
      expect(decoded).toContain('To: yacine@bestoftours.co.uk');
      expect(decoded).not.toContain('Cc:');
    });

    it('prepends Re: to subject if not already present', async () => {
      vi.useFakeTimers();
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      any.threadMeta.set('thread-3', {
        sender: 'ahmed@bestoftours.co.uk',
        senderName: 'Ahmed',
        subject: 'Booking Update',
        messageId: '<msg-3@mail.com>',
      });

      await ch.sendMessage('gmail:thread-3', 'Got it');

      const raw = mockSend.mock.calls[0][0].requestBody.raw;
      const decoded = Buffer.from(raw, 'base64').toString('utf-8');
      expect(decoded).toContain('Subject: Re: Booking Update');
    });

    it('does not double-prepend Re: to subject', async () => {
      vi.useFakeTimers();
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      any.threadMeta.set('thread-4', {
        sender: 'ahmed@bestoftours.co.uk',
        senderName: 'Ahmed',
        subject: 'Re: Booking Update',
        messageId: '<msg-4@mail.com>',
      });

      await ch.sendMessage('gmail:thread-4', 'Thanks');

      const raw = mockSend.mock.calls[0][0].requestBody.raw;
      const decoded = Buffer.from(raw, 'base64').toString('utf-8');
      expect(decoded).toContain('Subject: Re: Booking Update');
      expect(decoded).not.toContain('Subject: Re: Re:');
    });
  });

  // --- sendMessage: draft (non-allowlisted recipient) ---

  describe('sendMessage draft', () => {
    it('creates draft and sends notification for non-allowlisted recipient', async () => {
      vi.useFakeTimers();
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      any.threadMeta.set('thread-ext', {
        sender: 'external@unknown.com',
        senderName: 'External Person',
        subject: 'Question',
        messageId: '<msg-ext@mail.com>',
      });

      await ch.sendMessage('gmail:thread-ext', 'Here is my reply');

      // Draft should be created
      expect(mockDraftsCreate).toHaveBeenCalledTimes(1);
      const draftArgs = mockDraftsCreate.mock.calls[0][0];
      expect(draftArgs.userId).toBe('me');
      const draftRaw = Buffer.from(
        draftArgs.requestBody.message.raw,
        'base64',
      ).toString('utf-8');
      expect(draftRaw).toContain('To: external@unknown.com');
      expect(draftRaw).toContain('Here is my reply');

      // Notification email should be sent
      expect(mockSend).toHaveBeenCalledTimes(1);
      const notifyRaw = Buffer.from(
        mockSend.mock.calls[0][0].requestBody.raw,
        'base64',
      ).toString('utf-8');
      expect(notifyRaw).toContain('To: yacine@bestoftours.co.uk');
      expect(notifyRaw).toContain('[Draft pending]');
      expect(notifyRaw).toContain('external@unknown.com');
    });
  });

  // --- Reply to matching ---

  describe('Reply to matching', () => {
    it('[Reply to: X] in text matches correct thread by sender name', async () => {
      vi.useFakeTimers();
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      any.threadMeta.set('thread-ahmed', {
        sender: 'ahmed@bestoftours.co.uk',
        senderName: 'Ahmed',
        subject: 'Booking',
        messageId: '<msg-a@mail.com>',
      });
      any.threadMeta.set('thread-eline', {
        sender: 'eline@bestoftours.co.uk',
        senderName: 'Eline',
        subject: 'Invoice',
        messageId: '<msg-e@mail.com>',
      });

      await ch.sendMessage(
        'gmail:main',
        '[Reply to: Eline] Thanks for the invoice',
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      const raw = mockSend.mock.calls[0][0].requestBody.raw;
      const decoded = Buffer.from(raw, 'base64').toString('utf-8');
      expect(decoded).toContain('To: eline@bestoftours.co.uk');
      expect(decoded).not.toContain('[Reply to:');
      expect(decoded).toContain('Thanks for the invoice');
    });

    it('[Reply to: X] matches by sender email', async () => {
      vi.useFakeTimers();
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      any.threadMeta.set('thread-a', {
        sender: 'ahmed@bestoftours.co.uk',
        senderName: 'Ahmed B',
        subject: 'Subject A',
        messageId: '<msg-aa@mail.com>',
      });

      await ch.sendMessage(
        'gmail:main',
        '[Reply to: ahmed@bestoftours.co.uk] got it',
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      const decoded = Buffer.from(
        mockSend.mock.calls[0][0].requestBody.raw,
        'base64',
      ).toString('utf-8');
      expect(decoded).toContain('To: ahmed@bestoftours.co.uk');
    });
  });

  // --- Reply to fallback ---

  describe('Reply to fallback', () => {
    it('uses lastDeliveredThreadId when no explicit [Reply to:] match', async () => {
      vi.useFakeTimers();
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      any.threadMeta.set('thread-last', {
        sender: 'eline@bestoftours.co.uk',
        senderName: 'Eline',
        subject: 'Last Email',
        messageId: '<msg-last@mail.com>',
      });
      any.lastDeliveredThreadId = 'thread-last';

      await ch.sendMessage('gmail:main', 'Thanks!');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const decoded = Buffer.from(
        mockSend.mock.calls[0][0].requestBody.raw,
        'base64',
      ).toString('utf-8');
      expect(decoded).toContain('To: eline@bestoftours.co.uk');
    });
  });

  // --- No thread metadata ---

  describe('No thread metadata', () => {
    it('logs warning and returns without sending when no metadata', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      await ch.sendMessage('gmail:unknown-thread', 'Hello?');

      expect(mockSend).not.toHaveBeenCalled();
      expect(mockDraftsCreate).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'gmail:unknown-thread' }),
        expect.stringContaining('No thread metadata'),
      );
    });

    it('returns early when gmail is not initialized', async () => {
      const ch = new GmailChannel(makeOpts());
      await ch.sendMessage('gmail:thread-1', 'hello');
      expect(mockSend).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith('Gmail not initialized');
    });
  });

  // --- Poll error backoff ---

  describe('Poll error backoff', () => {
    it('consecutive errors increase backoff', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      mockMessagesList.mockRejectedValueOnce(new Error('API 500'));
      await (ch as any).pollForMessages();

      expect((ch as any).consecutiveErrors).toBe(1);
      expect(calculateBackoff).toHaveBeenCalledWith(1, 60000, 30 * 60 * 1000);

      mockMessagesList.mockRejectedValueOnce(new Error('API 503'));
      await (ch as any).pollForMessages();

      expect((ch as any).consecutiveErrors).toBe(2);
      expect(calculateBackoff).toHaveBeenCalledWith(2, 60000, 30 * 60 * 1000);
    });
  });

  // --- Poll success resets errors ---

  describe('Poll success resets errors', () => {
    it('consecutiveErrors resets to 0 on successful poll', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      // Simulate previous errors
      any.consecutiveErrors = 3;

      // The mock is already set to return empty messages by default
      await any.pollForMessages();

      expect(any.consecutiveErrors).toBe(0);
    });
  });

  // --- Skip self emails ---

  describe('Skip self emails', () => {
    it('emails from self (userEmail) are skipped', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      // Wire the get mock into the gmail mock
      any.gmail.users.messages.get = mockMessagesGet;

      mockMessagesList.mockResolvedValueOnce({
        data: { messages: [{ id: 'msg-self' }] },
      });

      mockMessagesGet.mockResolvedValueOnce({
        data: {
          threadId: 'thread-self',
          internalDate: '1700000000000',
          payload: {
            headers: [
              { name: 'From', value: 'Bot <bot@company.com>' },
              { name: 'Subject', value: 'Test' },
              { name: 'Message-ID', value: '<self@mail.com>' },
            ],
            mimeType: 'text/plain',
            body: { data: Buffer.from('Hello').toString('base64') },
          },
        },
      });

      await any.pollForMessages();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Gmail allowlist loading ---

  describe('Gmail allowlist loading', () => {
    it('reads from allowlist file', () => {
      vi.useFakeTimers();
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      expect(any.isDirectSendAllowed('ahmed@bestoftours.co.uk')).toBe(true);
      expect(any.isDirectSendAllowed('external@random.com')).toBe(false);
    });

    it('env var GMAIL_DIRECT_SEND_ALLOWLIST overrides file', () => {
      vi.useFakeTimers();
      // Advance time past the cache TTL (60s) so the cache is invalidated
      vi.advanceTimersByTime(120_000);

      process.env.GMAIL_DIRECT_SEND_ALLOWLIST =
        'custom@example.com,another@example.com';

      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      expect(any.isDirectSendAllowed('custom@example.com')).toBe(true);
      expect(any.isDirectSendAllowed('ahmed@bestoftours.co.uk')).toBe(false);
    });
  });

  // --- processMessage delivers to main group ---

  describe('processMessage', () => {
    it('delivers email to main group with correct format', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      any.gmail.users.messages.get = mockMessagesGet;
      any.gmail.users.messages.modify = mockMessagesModify;

      mockMessagesGet.mockResolvedValueOnce({
        data: {
          threadId: 'thread-new',
          internalDate: '1700000000000',
          payload: {
            headers: [
              { name: 'From', value: 'Alice Smith <alice@example.com>' },
              { name: 'Subject', value: 'Hello there' },
              { name: 'Message-ID', value: '<alice-msg@mail.com>' },
            ],
            mimeType: 'text/plain',
            body: { data: Buffer.from('Hi from Alice').toString('base64') },
          },
        },
      });

      await any.processMessage('msg-new');

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'gmail:thread-new',
        expect.any(String),
        'Hello there',
        'gmail',
        false,
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'main-jid',
        expect.objectContaining({
          id: 'msg-new',
          chat_jid: 'main-jid',
          sender: 'alice@example.com',
          sender_name: 'Alice Smith',
          content: expect.stringContaining('[Email from Alice Smith'),
          is_from_me: false,
        }),
      );

      expect(mockMessagesModify).toHaveBeenCalledWith({
        userId: 'me',
        id: 'msg-new',
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
    });

    it('skips email with no text body', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      any.gmail.users.messages.get = mockMessagesGet;

      mockMessagesGet.mockResolvedValueOnce({
        data: {
          threadId: 'thread-nobody',
          internalDate: '1700000000000',
          payload: {
            headers: [
              { name: 'From', value: 'nobody@example.com' },
              { name: 'Subject', value: 'Empty' },
              { name: 'Message-ID', value: '<nobody@mail.com>' },
            ],
            mimeType: 'text/html',
          },
        },
      });

      await any.processMessage('msg-nobody');

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('caps processedIds set to prevent unbounded growth', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      // Populate processedIds beyond the 5000 threshold
      for (let i = 0; i < 5100; i++) {
        any.processedIds.add(`msg-${i}`);
      }

      // Wire up list mock and return empty
      any.gmail.users.messages.list = mockMessagesList;
      mockMessagesList.mockResolvedValueOnce({ data: { messages: [] } });

      await any.pollForMessages();

      expect(any.processedIds.size).toBe(2500);
    });
  });

  describe('constructor options', () => {
    it('defaults to unread query', () => {
      const ch = new GmailChannel(makeOpts());
      const query = (
        ch as unknown as { buildQuery: () => string }
      ).buildQuery();
      expect(query).toBe('is:unread in:inbox');
    });
  });

  describe('isAutomatedEmail filtering', () => {
    function callFilter(
      senderEmail: string,
      headers: Array<{ name: string; value: string }> = [],
    ): boolean {
      const ch = new GmailChannel(makeOpts());
      return (
        ch as unknown as {
          isAutomatedEmail: (
            email: string,
            headers: Array<{ name?: string | null; value?: string | null }>,
          ) => boolean;
        }
      ).isAutomatedEmail(senderEmail, headers);
    }

    it('filters noreply@ senders', () => {
      expect(callFilter('noreply@company.com')).toBe(true);
      expect(callFilter('no-reply@service.io')).toBe(true);
      expect(callFilter('donotreply@example.com')).toBe(true);
    });

    it('filters known marketing domains', () => {
      expect(callFilter('news@mail.beehiiv.com')).toBe(true);
      expect(callFilter('campaign@email.mailchimp.com')).toBe(true);
      expect(callFilter('info@sendgrid.net')).toBe(true);
      expect(callFilter('hello@brevo.com')).toBe(true);
    });

    it('filters List-Unsubscribe header', () => {
      expect(
        callFilter('real@company.com', [
          { name: 'List-Unsubscribe', value: '<mailto:unsub@list.com>' },
        ]),
      ).toBe(true);
    });

    it('filters Precedence: bulk/list', () => {
      expect(
        callFilter('info@company.com', [{ name: 'Precedence', value: 'bulk' }]),
      ).toBe(true);
      expect(
        callFilter('info@company.com', [{ name: 'Precedence', value: 'list' }]),
      ).toBe(true);
    });

    it('filters Auto-Submitted (not "no")', () => {
      expect(
        callFilter('bounce@example.com', [
          { name: 'Auto-Submitted', value: 'auto-replied' },
        ]),
      ).toBe(true);
      expect(
        callFilter('bounce@example.com', [
          { name: 'Auto-Submitted', value: 'auto-generated' },
        ]),
      ).toBe(true);
    });

    it('does NOT filter Auto-Submitted: no', () => {
      expect(
        callFilter('person@company.com', [
          { name: 'Auto-Submitted', value: 'no' },
        ]),
      ).toBe(false);
    });

    it('filters X-Campaign-Id header', () => {
      expect(
        callFilter('marketing@company.com', [
          { name: 'X-Campaign-Id', value: 'abc123' },
        ]),
      ).toBe(true);
    });

    it('passes through normal emails', () => {
      expect(callFilter('eline@bestoftours.co.uk')).toBe(false);
      expect(callFilter('ahmed@bestoftours.co.uk')).toBe(false);
      expect(callFilter('client@hotel.com')).toBe(false);
    });

    it('passes through emails with Precedence: first-class', () => {
      expect(
        callFilter('person@company.com', [
          { name: 'Precedence', value: 'first-class' },
        ]),
      ).toBe(false);
    });
  });
});
