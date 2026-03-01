import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  IMAP_HOST: 'imap.example.com',
  IMAP_PORT: 993,
  IMAP_USER: 'user@example.com',
  IMAP_PASS: 'secret',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: 587,
  SMTP_USER: 'user@example.com',
  SMTP_PASS: 'secret',
  EMAIL_POLL_INTERVAL: 900000,
  EMAIL_FROM_NAME: 'Andy',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- ImapFlow mock ---

const lockRelease = vi.fn();

const imapMock = {
  connect: vi.fn().mockResolvedValue(undefined),
  logout: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
  getMailboxLock: vi.fn().mockResolvedValue({ release: lockRelease }),
  search: vi.fn().mockResolvedValue([]),
  fetchOne: vi.fn(),
  messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
};

vi.mock('imapflow', () => ({
  ImapFlow: class MockImapFlow {
    constructor() {
      Object.assign(this, imapMock);
    }
  },
}));

// --- Nodemailer mock ---

const transporterMock = {
  verify: vi.fn().mockResolvedValue(true),
  close: vi.fn(),
  sendMail: vi.fn().mockResolvedValue({ messageId: '<test@example.com>' }),
};

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => transporterMock),
  },
}));

// --- mailparser mock ---

import { simpleParser } from 'mailparser';

vi.mock('mailparser', () => ({
  simpleParser: vi.fn(),
}));

const simpleParserMock = vi.mocked(simpleParser);

// --- fs mock ---

vi.mock('node:fs', async () => {
  const actual =
    await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

import { EmailChannel, EmailChannelOpts } from './email.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<EmailChannelOpts>,
): EmailChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    ...overrides,
  };
}

async function createConnectedChannel(
  overrides?: Partial<EmailChannelOpts>,
) {
  const opts = createTestOpts(overrides);
  const channel = new EmailChannel(opts);
  await channel.connect();
  return { channel, opts };
}

// --- Tests ---

describe('EmailChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: empty inbox
    imapMock.search.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "email"', () => {
      const channel = new EmailChannel(createTestOpts());
      expect(channel.name).toBe('email');
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns email: JIDs', () => {
      const channel = new EmailChannel(createTestOpts());
      expect(channel.ownsJid('email:abc123@example.com')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new EmailChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new EmailChannel(createTestOpts());
      expect(channel.ownsJid('tg:100200300')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new EmailChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('isConnected() returns false before connect', () => {
      const channel = new EmailChannel(createTestOpts());
      expect(channel.isConnected()).toBe(false);
    });

    it('connects IMAP and verifies SMTP transporter', async () => {
      const channel = new EmailChannel(createTestOpts());
      await channel.connect();

      expect(imapMock.connect).toHaveBeenCalled();
      expect(transporterMock.verify).toHaveBeenCalled();
      expect(channel.isConnected()).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const channel = new EmailChannel(createTestOpts());
      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(imapMock.logout).toHaveBeenCalled();
      expect(transporterMock.close).toHaveBeenCalled();
    });

    it('disconnect is safe to call when not connected', async () => {
      const channel = new EmailChannel(createTestOpts());
      await expect(channel.disconnect()).resolves.toBeUndefined();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('is a no-op (emails sent via IPC)', async () => {
      const channel = new EmailChannel(createTestOpts());
      await channel.connect();

      // sendMessage should not throw and should not send mail
      await expect(
        channel.sendMessage('email:abc123@example.com', 'Hello'),
      ).resolves.toBeUndefined();
      expect(transporterMock.sendMail).not.toHaveBeenCalled();
    });
  });

  // --- Thread metadata ---

  describe('thread metadata', () => {
    it('returns undefined for unknown JID', () => {
      const channel = new EmailChannel(createTestOpts());
      expect(channel.getThreadMetadata('email:unknown')).toBeUndefined();
    });

    it('exposes the SMTP transporter', async () => {
      const channel = new EmailChannel(createTestOpts());
      await channel.connect();
      expect(channel.getTransporter()).toBe(transporterMock);
    });

    it('getTransporter returns undefined before connect', () => {
      const channel = new EmailChannel(createTestOpts());
      expect(channel.getTransporter()).toBeUndefined();
    });
  });

  // --- pollOnce ---

  describe('pollOnce', () => {
    it('handles empty inbox (no unseen messages)', async () => {
      const { channel, opts } = await createConnectedChannel();

      imapMock.search.mockResolvedValue([]);

      await channel.pollOnce();

      expect(imapMock.getMailboxLock).toHaveBeenCalledWith('INBOX');
      expect(imapMock.search).toHaveBeenCalledWith({ seen: false });
      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(lockRelease).toHaveBeenCalled();
    });

    it('processes a single new email with text body', async () => {
      const onEmail = vi.fn();
      const { channel, opts } = await createConnectedChannel({ onEmail });

      imapMock.search.mockResolvedValue([42]);
      imapMock.fetchOne.mockResolvedValue({
        uid: 42,
        source: Buffer.from('raw email source'),
      });

      simpleParserMock.mockResolvedValue({
        messageId: '<msg-001@example.com>',
        from: { value: [{ name: 'Alice', address: 'alice@example.com' }] },
        subject: 'Hello World',
        text: 'This is the body text.',
        html: '<p>This is the body text.</p>',
        inReplyTo: undefined,
        references: undefined,
        attachments: [],
      } as any);

      await channel.pollOnce();

      // Should call onMessage with formatted text
      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      const [jid, msg] = (opts.onMessage as any).mock.calls[0];
      expect(jid).toMatch(/^email:/);
      expect(msg.content).toContain('[Email von Alice <alice@example.com>]');
      expect(msg.content).toContain('Betreff: Hello World');
      expect(msg.content).toContain('This is the body text.');
      expect(msg.sender_name).toBe('Alice');

      // Should call onEmail
      expect(onEmail).toHaveBeenCalledTimes(1);

      // Should mark as read
      expect(imapMock.messageFlagsAdd).toHaveBeenCalledWith(
        [42],
        ['\\Seen'],
        { uid: true },
      );

      // Lock released
      expect(lockRelease).toHaveBeenCalled();
    });

    it('processes email with HTML body when text is absent', async () => {
      const { channel, opts } = await createConnectedChannel();

      imapMock.search.mockResolvedValue([10]);
      imapMock.fetchOne.mockResolvedValue({
        uid: 10,
        source: Buffer.from('raw'),
      });

      simpleParserMock.mockResolvedValue({
        messageId: '<html-only@example.com>',
        from: { value: [{ name: 'Bob', address: 'bob@example.com' }] },
        subject: 'HTML Only',
        text: undefined,
        html: '<p>HTML content here</p>',
        inReplyTo: undefined,
        references: undefined,
        attachments: [],
      } as any);

      await channel.pollOnce();

      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      const msg = (opts.onMessage as any).mock.calls[0][1];
      expect(msg.content).toContain('HTML content here');
    });

    it('saves attachments and includes them in the message', async () => {
      const { channel, opts } = await createConnectedChannel();

      imapMock.search.mockResolvedValue([20]);
      imapMock.fetchOne.mockResolvedValue({
        uid: 20,
        source: Buffer.from('raw'),
      });

      simpleParserMock.mockResolvedValue({
        messageId: '<attach-001@example.com>',
        from: { value: [{ name: 'Carol', address: 'carol@example.com' }] },
        subject: 'With Attachment',
        text: 'See attached.',
        html: undefined,
        inReplyTo: undefined,
        references: undefined,
        attachments: [
          {
            filename: 'report.pdf',
            content: Buffer.from('pdf-content'),
          },
        ],
      } as any);

      await channel.pollOnce();

      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      const msg = (opts.onMessage as any).mock.calls[0][1];
      expect(msg.content).toContain('[Anhang: report.pdf');
      expect(msg.content).toContain('See attached.');
    });

    it('skips already-processed message IDs', async () => {
      const { channel, opts } = await createConnectedChannel();

      // First poll: process the message
      imapMock.search.mockResolvedValue([42]);
      imapMock.fetchOne.mockResolvedValue({
        uid: 42,
        source: Buffer.from('raw'),
      });

      simpleParserMock.mockResolvedValue({
        messageId: '<dup@example.com>',
        from: { value: [{ name: 'Dave', address: 'dave@example.com' }] },
        subject: 'Duplicate',
        text: 'Hello',
        html: undefined,
        inReplyTo: undefined,
        references: undefined,
        attachments: [],
      } as any);

      await channel.pollOnce();
      expect(opts.onMessage).toHaveBeenCalledTimes(1);

      // Reset mocks for second poll
      (opts.onMessage as any).mockClear();
      imapMock.search.mockResolvedValue([42]);
      imapMock.fetchOne.mockResolvedValue({
        uid: 42,
        source: Buffer.from('raw'),
      });

      simpleParserMock.mockResolvedValue({
        messageId: '<dup@example.com>',
        from: { value: [{ name: 'Dave', address: 'dave@example.com' }] },
        subject: 'Duplicate',
        text: 'Hello',
        html: undefined,
        inReplyTo: undefined,
        references: undefined,
        attachments: [],
      } as any);

      // Second poll: should skip the duplicate
      await channel.pollOnce();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips own emails (from IMAP_USER)', async () => {
      const { channel, opts } = await createConnectedChannel();

      imapMock.search.mockResolvedValue([55]);
      imapMock.fetchOne.mockResolvedValue({
        uid: 55,
        source: Buffer.from('raw'),
      });

      simpleParserMock.mockResolvedValue({
        messageId: '<own@example.com>',
        from: {
          value: [{ name: 'Me', address: 'user@example.com' }],
        },
        subject: 'Own Message',
        text: 'Sent by me',
        html: undefined,
        inReplyTo: undefined,
        references: undefined,
        attachments: [],
      } as any);

      await channel.pollOnce();

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('handles IMAP errors gracefully', async () => {
      const { channel, opts } = await createConnectedChannel();

      imapMock.getMailboxLock.mockRejectedValueOnce(
        new Error('Connection lost'),
      );

      // Should not throw
      await expect(channel.pollOnce()).resolves.toBeUndefined();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('releases lock even when search throws', async () => {
      const { channel } = await createConnectedChannel();

      imapMock.search.mockRejectedValueOnce(new Error('Search failed'));

      await channel.pollOnce();

      expect(lockRelease).toHaveBeenCalled();
    });

    it('truncates body to 4000 characters', async () => {
      const { channel, opts } = await createConnectedChannel();

      imapMock.search.mockResolvedValue([99]);
      imapMock.fetchOne.mockResolvedValue({
        uid: 99,
        source: Buffer.from('raw'),
      });

      const longBody = 'A'.repeat(5000);
      simpleParserMock.mockResolvedValue({
        messageId: '<long@example.com>',
        from: { value: [{ name: 'Eve', address: 'eve@example.com' }] },
        subject: 'Long',
        text: longBody,
        html: undefined,
        inReplyTo: undefined,
        references: undefined,
        attachments: [],
      } as any);

      await channel.pollOnce();

      const msg = (opts.onMessage as any).mock.calls[0][1];
      // The body portion should be at most 4000 chars
      // The full content includes the header lines too
      const bodyLine = msg.content.split('\n\n').slice(1).join('\n\n');
      expect(bodyLine.length).toBeLessThanOrEqual(4100); // allow for attachment lines
    });
  });

  // --- startPolling ---

  describe('startPolling', () => {
    it('calls pollOnce immediately and sets interval', async () => {
      vi.useFakeTimers();
      const { channel } = await createConnectedChannel();

      imapMock.search.mockResolvedValue([]);

      channel.startPolling(60000);

      // pollOnce is called immediately (async, but triggered)
      // Let microtasks settle
      await vi.advanceTimersByTimeAsync(0);

      expect(imapMock.getMailboxLock).toHaveBeenCalledTimes(1);

      // Advance by one interval
      await vi.advanceTimersByTimeAsync(60000);

      expect(imapMock.getMailboxLock).toHaveBeenCalledTimes(2);

      // Clean up
      await channel.disconnect();
      vi.useRealTimers();
    });
  });
});
