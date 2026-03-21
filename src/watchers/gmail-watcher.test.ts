import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { GmailWatcher } from './gmail-watcher.js';
import type { EventRouter } from '../event-router.js';
import type { EmailPayload } from '../classification-prompts.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockMessagesList = vi.fn();
const mockMessagesGet = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    gmail: vi.fn(() => ({
      users: {
        messages: {
          list: mockMessagesList,
          get: mockMessagesGet,
        },
      },
    })),
  },
}));

const mockGetAccessToken = vi.fn().mockResolvedValue({ token: 'fake-token' });

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => ({
    setCredentials: vi.fn(),
    getAccessToken: mockGetAccessToken,
  })),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-watcher-test-'));
}

function makeEventRouter(): EventRouter {
  return {
    route: vi.fn().mockResolvedValue({ routing: 'notify' }),
  } as unknown as EventRouter;
}

function makeCredentials(dir: string): string {
  const creds = {
    installed: {
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      redirect_uris: ['urn:ietf:wg:oauth:2.0:oob'],
      token: {
        access_token: 'fake-access',
        refresh_token: 'fake-refresh',
      },
    },
  };
  const credPath = path.join(dir, 'credentials.json');
  fs.writeFileSync(credPath, JSON.stringify(creds));
  return credPath;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('GmailWatcher', () => {
  let stateDir: string;
  let credDir: string;
  let credentialsPath: string;
  let eventRouter: EventRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    stateDir = makeTempDir();
    credDir = makeTempDir();
    credentialsPath = makeCredentials(credDir);
    eventRouter = makeEventRouter();

    // Default: no messages
    mockMessagesList.mockResolvedValue({ data: { messages: [] } });
    mockMessagesGet.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(credDir, { recursive: true, force: true });
  });

  it('creates watcher with config', () => {
    const watcher = new GmailWatcher({
      credentialsPath,
      account: 'test@example.com',
      eventRouter,
      pollIntervalMs: 60_000,
      stateDir,
    });

    expect(watcher).toBeDefined();
    expect(watcher).toBeInstanceOf(GmailWatcher);
  });

  it('reports initial status', () => {
    const watcher = new GmailWatcher({
      credentialsPath,
      account: 'test@example.com',
      eventRouter,
      pollIntervalMs: 60_000,
      stateDir,
    });

    const status = watcher.getStatus();

    expect(status.mode).toBe('polling');
    expect(status.messagesProcessed).toBe(0);
    expect(status.lastCheck).toBeNull();
  });

  it('stop() is safe to call before start()', () => {
    const watcher = new GmailWatcher({
      credentialsPath,
      account: 'test@example.com',
      eventRouter,
      pollIntervalMs: 60_000,
      stateDir,
    });

    expect(() => watcher.stop()).not.toThrow();
  });
});

// ─── parseMessage ─────────────────────────────────────────────────────────────

describe('GmailWatcher.parseMessage', () => {
  it('parses a full Gmail API message into EmailPayload', () => {
    const msg = {
      id: 'msg-001',
      threadId: 'thread-001',
      snippet: 'Hello, this is a test',
      labelIds: ['INBOX', 'UNREAD'],
      payload: {
        headers: [
          { name: 'From', value: 'alice@example.com' },
          { name: 'To', value: 'bob@example.com, carol@example.com' },
          { name: 'Cc', value: 'dan@example.com' },
          { name: 'Subject', value: 'Test Subject' },
          { name: 'Date', value: 'Mon, 21 Mar 2026 09:00:00 +0000' },
        ],
        parts: [
          { mimeType: 'text/plain', body: { size: 100 } },
          {
            mimeType: 'application/pdf',
            filename: 'attachment.pdf',
            body: { attachmentId: 'att-001', size: 5000 },
          },
        ],
      },
    };

    const payload = GmailWatcher.parseMessage(msg);

    expect(payload.messageId).toBe('msg-001');
    expect(payload.threadId).toBe('thread-001');
    expect(payload.from).toBe('alice@example.com');
    expect(payload.to).toEqual(['bob@example.com', 'carol@example.com']);
    expect(payload.cc).toEqual(['dan@example.com']);
    expect(payload.subject).toBe('Test Subject');
    expect(payload.snippet).toBe('Hello, this is a test');
    expect(payload.labels).toEqual(['INBOX', 'UNREAD']);
    expect(payload.hasAttachments).toBe(true);
  });

  it('handles missing optional headers gracefully', () => {
    const msg = {
      id: 'msg-002',
      threadId: 'thread-002',
      snippet: '',
      labelIds: [],
      payload: {
        headers: [
          { name: 'From', value: 'sender@example.com' },
          { name: 'Subject', value: 'Minimal' },
        ],
        parts: [],
      },
    };

    const payload = GmailWatcher.parseMessage(msg);

    expect(payload.from).toBe('sender@example.com');
    expect(payload.to).toEqual([]);
    expect(payload.cc).toEqual([]);
    expect(payload.hasAttachments).toBe(false);
  });

  it('detects attachments from parts with attachmentId', () => {
    const msg = {
      id: 'msg-003',
      threadId: 'thread-003',
      snippet: '',
      labelIds: [],
      payload: {
        headers: [{ name: 'From', value: 'x@x.com' }],
        parts: [
          {
            mimeType: 'image/png',
            filename: 'photo.png',
            body: { attachmentId: 'att-002', size: 200 },
          },
        ],
      },
    };

    const payload: EmailPayload = GmailWatcher.parseMessage(msg);
    expect(payload.hasAttachments).toBe(true);
  });

  it('returns empty payload when message has no payload field', () => {
    const msg = {
      id: 'msg-004',
      threadId: 'thread-004',
      snippet: 'bare',
      labelIds: ['INBOX'],
    };

    const payload = GmailWatcher.parseMessage(msg);

    expect(payload.messageId).toBe('msg-004');
    expect(payload.from).toBe('');
    expect(payload.to).toEqual([]);
    expect(payload.cc).toEqual([]);
    expect(payload.hasAttachments).toBe(false);
  });
});
