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

const imapMock = {
  connect: vi.fn().mockResolvedValue(undefined),
  logout: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
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

vi.mock('mailparser', () => ({
  simpleParser: vi.fn(),
}));

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

// --- Tests ---

describe('EmailChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
