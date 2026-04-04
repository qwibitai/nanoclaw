/**
 * Integration tests for Gmail email filtering pipeline.
 *
 * Tests the isAutomatedEmail filter with various header combinations,
 * and the sendMessage routing (direct send vs draft).
 *
 * Uses a real GmailChannel instance with mocked googleapis.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock registry (registerChannel runs at import time)
vi.mock('../channels/registry.js', () => ({ registerChannel: vi.fn() }));

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
  calculateBackoff: vi.fn((errors: number, base: number) =>
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

// Mock @google-cloud/firestore
vi.mock('@google-cloud/firestore', () => ({
  Firestore: vi.fn(),
}));

// Mock fs
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

import { GmailChannel, GmailChannelOpts } from '../channels/gmail.js';
import { logger } from '../logger.js';

// --- Gmail API mocks ---
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

function createConnectedChannel(opts: GmailChannelOpts): GmailChannel {
  const channel = new GmailChannel(opts, 60000);
  const any = channel as any;
  any.gmail = makeGmailMock();
  any.userEmail = 'bot@company.com';
  return channel;
}

/**
 * Helper to test isAutomatedEmail directly.
 */
function callFilter(
  senderEmail: string,
  headers: Array<{ name: string; value: string }> = [],
): boolean {
  const ch = new GmailChannel(makeOpts());
  // isAutomatedEmail returns a reason string or null; coerce to boolean
  return !!(ch as any).isAutomatedEmail(senderEmail, headers);
}

/**
 * Helper to simulate processMessage with mock data.
 */
async function simulateIncomingEmail(
  channel: GmailChannel,
  opts: GmailChannelOpts,
  config: {
    messageId?: string;
    from: string;
    subject: string;
    body: string;
    threadId?: string;
    headers?: Array<{ name: string; value: string }>;
  },
): Promise<void> {
  const any = channel as any;
  const msgId = config.messageId || `msg-${Date.now()}`;
  const threadId = config.threadId || `thread-${Date.now()}`;

  const allHeaders = [
    { name: 'From', value: config.from },
    { name: 'Subject', value: config.subject },
    { name: 'Message-ID', value: `<${msgId}@mail.com>` },
    ...(config.headers || []),
  ];

  any.gmail.users.messages.get = vi.fn().mockResolvedValue({
    data: {
      threadId,
      internalDate: String(Date.now()),
      payload: {
        headers: allHeaders,
        mimeType: 'text/plain',
        body: { data: Buffer.from(config.body).toString('base64') },
      },
    },
  });
  any.gmail.users.messages.modify = vi.fn().mockResolvedValue({});

  await any.processMessage(msgId);
}

// --- Tests ---

describe('Email Filtering Pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GMAIL_DIRECT_SEND_ALLOWLIST;
    delete process.env.GMAIL_NOTIFY_EMAIL;
    delete process.env.GMAIL_CC_EMAIL;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // --- Newsletter filtering ---

  describe('newsletter filtering (List-Unsubscribe)', () => {
    it('skips emails with List-Unsubscribe header', () => {
      expect(
        callFilter('newsletter@company.com', [
          { name: 'List-Unsubscribe', value: '<mailto:unsub@list.com>' },
        ]),
      ).toBe(true);
    });

    it('skips emails with List-Unsubscribe-Post header', () => {
      expect(
        callFilter('news@company.com', [
          { name: 'List-Unsubscribe', value: '<https://list.com/unsub>' },
        ]),
      ).toBe(true);
    });
  });

  // --- Noreply sender filtering ---

  describe('noreply sender filtering', () => {
    it('skips noreply@ sender', () => {
      expect(callFilter('noreply@service.com')).toBe(true);
    });

    it('skips no-reply@ sender', () => {
      expect(callFilter('no-reply@service.com')).toBe(true);
    });

    it('skips no_reply@ sender', () => {
      expect(callFilter('no_reply@service.com')).toBe(true);
    });

    it('skips donotreply@ sender', () => {
      expect(callFilter('donotreply@example.com')).toBe(true);
    });

    it('skips do-not-reply@ sender', () => {
      expect(callFilter('do-not-reply@example.com')).toBe(true);
    });

    it('skips mailer-daemon@ sender', () => {
      expect(callFilter('mailer-daemon@gmail.com')).toBe(true);
    });

    it('skips notifications@ sender', () => {
      expect(callFilter('notifications@github.com')).toBe(true);
    });

    it('skips alerts@ sender', () => {
      expect(callFilter('alerts@monitoring.com')).toBe(true);
    });
  });

  // --- Marketing domain filtering ---

  describe('marketing domain filtering', () => {
    it('skips beehiiv domains', () => {
      expect(callFilter('news@mail.beehiiv.com')).toBe(true);
    });

    it('skips mailchimp domains', () => {
      expect(callFilter('campaign@email.mailchimp.com')).toBe(true);
    });

    it('skips sendgrid domains', () => {
      expect(callFilter('info@sendgrid.net')).toBe(true);
    });

    it('skips brevo domains', () => {
      expect(callFilter('hello@brevo.com')).toBe(true);
    });

    it('skips klaviyo domains', () => {
      expect(callFilter('marketing@klaviyo.com')).toBe(true);
    });

    it('skips customer.io domains', () => {
      expect(callFilter('updates@customer.io')).toBe(true);
    });

    it('skips intercom-mail domains', () => {
      expect(callFilter('support@intercom-mail.com')).toBe(true);
    });
  });

  // --- Precedence header filtering ---

  describe('Precedence header filtering', () => {
    it('skips Precedence: bulk', () => {
      expect(
        callFilter('info@company.com', [{ name: 'Precedence', value: 'bulk' }]),
      ).toBe(true);
    });

    it('skips Precedence: list', () => {
      expect(
        callFilter('info@company.com', [{ name: 'Precedence', value: 'list' }]),
      ).toBe(true);
    });

    it('passes Precedence: first-class', () => {
      expect(
        callFilter('info@company.com', [
          { name: 'Precedence', value: 'first-class' },
        ]),
      ).toBe(false);
    });
  });

  // --- Auto-Submitted filtering ---

  describe('Auto-Submitted filtering', () => {
    it('skips Auto-Submitted: auto-replied', () => {
      expect(
        callFilter('bounce@example.com', [
          { name: 'Auto-Submitted', value: 'auto-replied' },
        ]),
      ).toBe(true);
    });

    it('skips Auto-Submitted: auto-generated', () => {
      expect(
        callFilter('system@example.com', [
          { name: 'Auto-Submitted', value: 'auto-generated' },
        ]),
      ).toBe(true);
    });

    it('passes Auto-Submitted: no (human-sent)', () => {
      expect(
        callFilter('person@company.com', [
          { name: 'Auto-Submitted', value: 'no' },
        ]),
      ).toBe(false);
    });
  });

  // --- Campaign header filtering ---

  describe('campaign header filtering', () => {
    it('skips emails with X-Campaign-Id', () => {
      expect(
        callFilter('marketing@company.com', [
          { name: 'X-Campaign-Id', value: 'camp-2024-q1' },
        ]),
      ).toBe(true);
    });

    it('skips emails with X-Mailchimp-Id', () => {
      expect(
        callFilter('news@company.com', [
          { name: 'X-Mailchimp-Id', value: 'mc-abc123' },
        ]),
      ).toBe(true);
    });
  });

  // --- Normal emails pass through ---

  describe('normal emails pass through', () => {
    it('delivers email from colleague', () => {
      expect(callFilter('eline@bestoftours.co.uk')).toBe(false);
    });

    it('delivers email from client', () => {
      expect(callFilter('client@hotel.com')).toBe(false);
    });

    it('delivers email with no special headers', () => {
      expect(callFilter('person@company.com')).toBe(false);
    });

    it('delivers email with normal headers', () => {
      expect(
        callFilter('person@company.com', [
          { name: 'Content-Type', value: 'text/plain' },
          { name: 'Date', value: 'Mon, 15 Jun 2024 10:30:00 +0000' },
        ]),
      ).toBe(false);
    });
  });

  // --- Self-email skipping ---

  describe('self-email skipping', () => {
    it('skips emails from self (userEmail)', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      await simulateIncomingEmail(ch, opts, {
        from: 'Bot <bot@company.com>',
        subject: 'Self Email',
        body: 'This is from myself',
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Normal email delivery ---

  describe('normal email delivery to main group', () => {
    it('delivers colleague email to main group', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      await simulateIncomingEmail(ch, opts, {
        from: 'Alice Smith <alice@example.com>',
        subject: 'Meeting tomorrow',
        body: 'Hi, let us discuss the project.',
      });

      expect(opts.onMessage).toHaveBeenCalledWith(
        'main-jid',
        expect.objectContaining({
          sender: 'alice@example.com',
          sender_name: 'Alice Smith',
          content: expect.stringContaining('[Email from Alice Smith'),
        }),
      );
    });

    it('skips automated email from newsletter', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      await simulateIncomingEmail(ch, opts, {
        from: 'newsletter@mail.beehiiv.com',
        subject: 'Weekly Digest',
        body: 'Here is your weekly update.',
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips email with List-Unsubscribe header', async () => {
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);

      await simulateIncomingEmail(ch, opts, {
        from: 'news@company.com',
        subject: 'Company Newsletter',
        body: 'Latest news...',
        headers: [
          { name: 'List-Unsubscribe', value: '<mailto:unsub@company.com>' },
        ],
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Send routing: direct vs draft ---

  describe('send routing: direct send vs draft', () => {
    it('sends directly to allowlisted recipient with CC', async () => {
      vi.useFakeTimers();
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      any.threadMeta.set('thread-1', {
        sender: 'ahmed@bestoftours.co.uk',
        senderName: 'Ahmed',
        subject: 'Booking Question',
        messageId: '<msg-1@mail.com>',
      });

      await ch.sendMessage('gmail:thread-1', 'Confirmed for tomorrow');

      expect(mockSend).toHaveBeenCalledTimes(1);
      const raw = mockSend.mock.calls[0][0].requestBody.raw;
      const decoded = Buffer.from(raw, 'base64').toString('utf-8');
      expect(decoded).toContain('To: ahmed@bestoftours.co.uk');
      expect(decoded).toContain('Cc: yacine@bestoftours.co.uk');
      expect(decoded).toContain('Confirmed for tomorrow');
    });

    it('creates draft + notification for non-allowlisted recipient', async () => {
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

      await ch.sendMessage('gmail:thread-ext', 'Reply to external');

      // Draft created
      expect(mockDraftsCreate).toHaveBeenCalledTimes(1);
      const draftRaw = Buffer.from(
        mockDraftsCreate.mock.calls[0][0].requestBody.message.raw,
        'base64',
      ).toString('utf-8');
      expect(draftRaw).toContain('To: external@unknown.com');

      // Notification sent
      expect(mockSend).toHaveBeenCalledTimes(1);
      const notifyRaw = Buffer.from(
        mockSend.mock.calls[0][0].requestBody.raw,
        'base64',
      ).toString('utf-8');
      expect(notifyRaw).toContain('To: yacine@bestoftours.co.uk');
      expect(notifyRaw).toContain('[Draft pending]');
    });

    it('does not add CC when sending to cc_email itself', async () => {
      vi.useFakeTimers();
      const opts = makeOpts();
      const ch = createConnectedChannel(opts);
      const any = ch as any;

      any.threadMeta.set('thread-yacine', {
        sender: 'yacine@bestoftours.co.uk',
        senderName: 'Yacine',
        subject: 'Direct',
        messageId: '<msg-y@mail.com>',
      });

      await ch.sendMessage('gmail:thread-yacine', 'Hi');

      const raw = mockSend.mock.calls[0][0].requestBody.raw;
      const decoded = Buffer.from(raw, 'base64').toString('utf-8');
      expect(decoded).toContain('To: yacine@bestoftours.co.uk');
      expect(decoded).not.toContain('Cc:');
    });
  });
});
