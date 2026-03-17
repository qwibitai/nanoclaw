import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

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

// Mock config — provide GROUPS_DIR for attachment saving
vi.mock('../config.js', () => ({
  GROUPS_DIR: '/tmp/test-gmail-groups',
}));

import { registerChannel } from './registry.js';
import {
  GmailChannel,
  GmailChannelOpts,
  mimeTypeFromExtension,
} from './gmail.js';

// INVARIANT: Importing gmail.ts registers the 'gmail' channel factory via registerChannel.
it('registers gmail channel on import', () => {
  expect(registerChannel).toHaveBeenCalledWith('gmail', expect.any(Function));
});

// Test harness: builds a GmailChannel with mocked Gmail API internals
function makeOpts(overrides?: Partial<GmailChannelOpts>): GmailChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: () => ({
      'tg:-5128317012': {
        name: 'Main Group',
        folder: 'telegram_main',
        trigger: '@bot',
        added_at: '2026-01-01T00:00:00Z',
        isMain: true,
      },
    }),
    ...overrides,
  };
}

interface MockGmailApi {
  users: {
    getProfile: ReturnType<typeof vi.fn>;
    messages: {
      list: ReturnType<typeof vi.fn>;
      get: ReturnType<typeof vi.fn>;
      send: ReturnType<typeof vi.fn>;
      modify: ReturnType<typeof vi.fn>;
      attachments: {
        get: ReturnType<typeof vi.fn>;
      };
    };
    threads: {
      get: ReturnType<typeof vi.fn>;
    };
  };
}

function createMockGmailApi(): MockGmailApi {
  return {
    users: {
      getProfile: vi.fn().mockResolvedValue({
        data: { emailAddress: 'me@example.com' },
      }),
      messages: {
        list: vi.fn().mockResolvedValue({ data: { messages: [] } }),
        get: vi.fn(),
        send: vi.fn().mockResolvedValue({ data: {} }),
        modify: vi.fn().mockResolvedValue({ data: {} }),
        attachments: {
          get: vi.fn(),
        },
      },
      threads: {
        get: vi.fn(),
      },
    },
  };
}

/** Inject mock Gmail API and userEmail into a GmailChannel instance. */
function injectGmailApi(
  channel: GmailChannel,
  mockApi: MockGmailApi,
  userEmail = 'me@example.com',
): void {
  // Use type assertion to set private properties for testing
  const ch = channel as unknown as Record<string, unknown>;
  ch.gmail = mockApi;
  ch.userEmail = userEmail;
}

/** Seed threadMeta cache for a given threadId. */
function seedThreadMeta(
  channel: GmailChannel,
  threadId: string,
  meta: {
    sender: string;
    senderName: string;
    subject: string;
    messageId: string;
  },
): void {
  const ch = channel as unknown as {
    threadMeta: Map<string, unknown>;
  };
  ch.threadMeta.set(threadId, meta);
}

/** Build a Gmail API message response payload for testing. */
function buildGmailMessage(opts: {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  messageId?: string;
  body?: string;
  internalDate?: string;
  parts?: Array<{
    mimeType: string;
    filename?: string;
    body?: { data?: string; attachmentId?: string; size?: number };
    parts?: unknown[];
  }>;
}): { data: Record<string, unknown> } {
  const headers = [
    { name: 'From', value: opts.from },
    { name: 'Subject', value: opts.subject },
    { name: 'Message-ID', value: opts.messageId || `<msg-${opts.id}@mail>` },
  ];

  const payload: Record<string, unknown> = { headers };

  if (opts.parts) {
    payload.mimeType = 'multipart/mixed';
    payload.parts = opts.parts;
  } else if (opts.body !== undefined) {
    payload.mimeType = 'text/plain';
    payload.body = {
      data: Buffer.from(opts.body).toString('base64'),
    };
  }

  return {
    data: {
      id: opts.id,
      threadId: opts.threadId,
      internalDate: opts.internalDate || String(Date.now()),
      payload,
    },
  };
}

describe('GmailChannel', () => {
  let channel: GmailChannel;

  beforeEach(() => {
    channel = new GmailChannel(makeOpts());
  });

  describe('ownsJid', () => {
    it('returns true for gmail: prefixed JIDs', () => {
      expect(channel.ownsJid('gmail:abc123')).toBe(true);
      expect(channel.ownsJid('gmail:thread-id-456')).toBe(true);
    });

    it('returns false for non-gmail JIDs', () => {
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('dc:456')).toBe(false);
    });
  });

  describe('name', () => {
    it('is gmail', () => {
      expect(channel.name).toBe('gmail');
    });
  });

  describe('isConnected', () => {
    it('returns false before connect', () => {
      expect(channel.isConnected()).toBe(false);
    });

    it('returns true after injecting gmail API', () => {
      const mockApi = createMockGmailApi();
      injectGmailApi(channel, mockApi);
      expect(channel.isConnected()).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('sets connected to false', async () => {
      const mockApi = createMockGmailApi();
      injectGmailApi(channel, mockApi);
      expect(channel.isConnected()).toBe(true);
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('constructor options', () => {
    it('accepts custom poll interval', () => {
      const ch = new GmailChannel(makeOpts(), 30000);
      expect(ch.name).toBe('gmail');
    });

    it('defaults to unread query when no filter configured', () => {
      const ch = new GmailChannel(makeOpts());
      const query = (
        ch as unknown as { buildQuery: () => string }
      ).buildQuery();
      expect(query).toBe('is:unread category:primary');
    });
  });
});

describe('sendMessage — in-thread replies', () => {
  let channel: GmailChannel;
  let mockApi: MockGmailApi;

  beforeEach(() => {
    channel = new GmailChannel(makeOpts());
    mockApi = createMockGmailApi();
    injectGmailApi(channel, mockApi);
  });

  // INVARIANT: Replies must use threadId and In-Reply-To/References headers
  // to stay in the email thread, never compose a new email.
  it('sends reply in-thread with correct headers when threadMeta is cached', async () => {
    seedThreadMeta(channel, 'thread-123', {
      sender: 'alice@example.com',
      senderName: 'Alice',
      subject: 'Hello',
      messageId: '<original@mail>',
    });

    await channel.sendMessage('gmail:thread-123', 'Thanks!');

    expect(mockApi.users.messages.send).toHaveBeenCalledTimes(1);
    const call = mockApi.users.messages.send.mock.calls[0][0];
    expect(call.requestBody.threadId).toBe('thread-123');

    // Decode the raw message and verify threading headers
    const raw = call.requestBody.raw;
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    expect(decoded).toContain('In-Reply-To: <original@mail>');
    expect(decoded).toContain('References: <original@mail>');
    expect(decoded).toContain('To: alice@example.com');
    expect(decoded).toContain('Re: Hello');
    expect(decoded).toContain('Thanks!');
  });

  it('adds Re: prefix only once', async () => {
    seedThreadMeta(channel, 'thread-456', {
      sender: 'bob@example.com',
      senderName: 'Bob',
      subject: 'Re: Already a reply',
      messageId: '<re-msg@mail>',
    });

    await channel.sendMessage('gmail:thread-456', 'Got it');

    const raw = mockApi.users.messages.send.mock.calls[0][0].requestBody.raw;
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    // Should NOT double-prefix
    expect(decoded).not.toContain('Re: Re:');
    expect(decoded).toContain('Subject: Re: Already a reply');
  });

  // INVARIANT: When threadMeta cache misses, fetch from Gmail API (fallback)
  // instead of silently dropping the reply.
  it('fetches thread metadata from API when cache misses', async () => {
    mockApi.users.threads.get.mockResolvedValue({
      data: {
        messages: [
          {
            payload: {
              headers: [
                { name: 'From', value: 'Carol <carol@example.com>' },
                { name: 'Subject', value: 'Question' },
                { name: 'Message-ID', value: '<carol-msg@mail>' },
              ],
            },
          },
        ],
      },
    });

    await channel.sendMessage('gmail:thread-789', 'Reply here');

    // Should have called threads.get to fetch metadata
    expect(mockApi.users.threads.get).toHaveBeenCalledWith({
      userId: 'me',
      id: 'thread-789',
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Message-ID'],
    });

    // And then sent the reply
    expect(mockApi.users.messages.send).toHaveBeenCalledTimes(1);
    const raw = mockApi.users.messages.send.mock.calls[0][0].requestBody.raw;
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    expect(decoded).toContain('To: carol@example.com');
    expect(decoded).toContain('In-Reply-To: <carol-msg@mail>');
  });

  it('finds non-self sender when thread has mixed senders', async () => {
    mockApi.users.threads.get.mockResolvedValue({
      data: {
        messages: [
          {
            payload: {
              headers: [
                { name: 'From', value: 'Dave <dave@example.com>' },
                { name: 'Subject', value: 'Chat' },
                { name: 'Message-ID', value: '<dave-1@mail>' },
              ],
            },
          },
          {
            payload: {
              headers: [
                { name: 'From', value: 'me@example.com' },
                { name: 'Subject', value: 'Re: Chat' },
                { name: 'Message-ID', value: '<me-reply@mail>' },
              ],
            },
          },
          {
            payload: {
              headers: [
                { name: 'From', value: 'Dave <dave@example.com>' },
                { name: 'Subject', value: 'Re: Chat' },
                { name: 'Message-ID', value: '<dave-2@mail>' },
              ],
            },
          },
        ],
      },
    });

    await channel.sendMessage('gmail:thread-mixed', 'Ok');

    const raw = mockApi.users.messages.send.mock.calls[0][0].requestBody.raw;
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    // Should reply to Dave, not to self
    expect(decoded).toContain('To: dave@example.com');
    // In-Reply-To should reference the last message's Message-ID
    expect(decoded).toContain('In-Reply-To: <dave-2@mail>');
  });

  it('warns and does not send when thread metadata cannot be found', async () => {
    mockApi.users.threads.get.mockResolvedValue({
      data: { messages: [] },
    });

    await channel.sendMessage('gmail:thread-empty', 'Hello?');

    expect(mockApi.users.messages.send).not.toHaveBeenCalled();
  });

  it('warns and does not send when gmail is not initialized', async () => {
    await channel.disconnect();
    await channel.sendMessage('gmail:thread-x', 'text');
    expect(mockApi.users.messages.send).not.toHaveBeenCalled();
  });
});

describe('sendImage', () => {
  let channel: GmailChannel;
  let mockApi: MockGmailApi;
  const testImagePath = '/tmp/test-gmail-img.png';

  beforeEach(() => {
    channel = new GmailChannel(makeOpts());
    mockApi = createMockGmailApi();
    injectGmailApi(channel, mockApi);

    seedThreadMeta(channel, 'img-thread', {
      sender: 'alice@example.com',
      senderName: 'Alice',
      subject: 'Photos',
      messageId: '<photo-msg@mail>',
    });

    // Create a small test file
    fs.writeFileSync(testImagePath, 'fake-png-data');
  });

  afterEach(() => {
    try {
      fs.unlinkSync(testImagePath);
    } catch {
      /* ignore */
    }
  });

  // INVARIANT: sendImage sends a multipart MIME email with the image as an inline attachment.
  it('sends multipart email with inline image', async () => {
    await channel.sendImage(
      'gmail:img-thread',
      testImagePath,
      'Check this out',
    );

    expect(mockApi.users.messages.send).toHaveBeenCalledTimes(1);
    const call = mockApi.users.messages.send.mock.calls[0][0];
    expect(call.requestBody.threadId).toBe('img-thread');

    const decoded = Buffer.from(call.requestBody.raw, 'base64').toString(
      'utf-8',
    );
    expect(decoded).toContain('Content-Type: multipart/mixed; boundary=');
    expect(decoded).toContain(
      'Content-Disposition: inline; filename="test-gmail-img.png"',
    );
    expect(decoded).toContain('Content-Type: image/png');
    expect(decoded).toContain('Check this out');
    expect(decoded).toContain('In-Reply-To: <photo-msg@mail>');
  });

  it('falls back to text on file read error', async () => {
    await channel.sendImage(
      'gmail:img-thread',
      '/nonexistent/image.png',
      'caption',
    );

    // Should have attempted sendMessage as fallback
    expect(mockApi.users.messages.send).toHaveBeenCalledTimes(1);
    const decoded = Buffer.from(
      mockApi.users.messages.send.mock.calls[0][0].requestBody.raw,
      'base64',
    ).toString('utf-8');
    // Fallback sends the caption as text
    expect(decoded).toContain('caption');
  });

  it('does nothing when gmail not initialized', async () => {
    await channel.disconnect();
    await channel.sendImage('gmail:img-thread', testImagePath, 'caption');
    expect(mockApi.users.messages.send).not.toHaveBeenCalled();
  });
});

describe('sendDocument', () => {
  let channel: GmailChannel;
  let mockApi: MockGmailApi;
  const testDocPath = '/tmp/test-gmail-doc.pdf';

  beforeEach(() => {
    channel = new GmailChannel(makeOpts());
    mockApi = createMockGmailApi();
    injectGmailApi(channel, mockApi);

    seedThreadMeta(channel, 'doc-thread', {
      sender: 'bob@example.com',
      senderName: 'Bob',
      subject: 'Report',
      messageId: '<report-msg@mail>',
    });

    fs.writeFileSync(testDocPath, 'fake-pdf-data');
  });

  afterEach(() => {
    try {
      fs.unlinkSync(testDocPath);
    } catch {
      /* ignore */
    }
  });

  // INVARIANT: sendDocument sends a multipart MIME email with the file as a download attachment.
  it('sends multipart email with file attachment', async () => {
    await channel.sendDocument(
      'gmail:doc-thread',
      testDocPath,
      'report.pdf',
      'Here is the report',
    );

    expect(mockApi.users.messages.send).toHaveBeenCalledTimes(1);
    const call = mockApi.users.messages.send.mock.calls[0][0];
    expect(call.requestBody.threadId).toBe('doc-thread');

    const decoded = Buffer.from(call.requestBody.raw, 'base64').toString(
      'utf-8',
    );
    expect(decoded).toContain('Content-Type: multipart/mixed; boundary=');
    expect(decoded).toContain(
      'Content-Disposition: attachment; filename="report.pdf"',
    );
    expect(decoded).toContain('Content-Type: application/pdf');
    expect(decoded).toContain('Here is the report');
    expect(decoded).toContain('In-Reply-To: <report-msg@mail>');
  });

  it('uses basename when filename not provided', async () => {
    await channel.sendDocument('gmail:doc-thread', testDocPath);

    const decoded = Buffer.from(
      mockApi.users.messages.send.mock.calls[0][0].requestBody.raw,
      'base64',
    ).toString('utf-8');
    expect(decoded).toContain('filename="test-gmail-doc.pdf"');
  });

  it('fetches thread metadata when cache misses', async () => {
    // Use a fresh channel with no cached metadata
    const fresh = new GmailChannel(makeOpts());
    const freshApi = createMockGmailApi();
    injectGmailApi(fresh, freshApi);

    freshApi.users.threads.get.mockResolvedValue({
      data: {
        messages: [
          {
            payload: {
              headers: [
                { name: 'From', value: 'Eve <eve@example.com>' },
                { name: 'Subject', value: 'Docs' },
                { name: 'Message-ID', value: '<eve@mail>' },
              ],
            },
          },
        ],
      },
    });

    await fresh.sendDocument('gmail:new-thread', testDocPath, 'file.pdf');

    expect(freshApi.users.threads.get).toHaveBeenCalled();
    expect(freshApi.users.messages.send).toHaveBeenCalledTimes(1);
  });
});

describe('processMessage — incoming emails with attachments', () => {
  let channel: GmailChannel;
  let mockApi: MockGmailApi;
  let opts: GmailChannelOpts;
  const groupDir = '/tmp/test-gmail-groups/telegram_main';

  beforeEach(() => {
    opts = makeOpts();
    channel = new GmailChannel(opts);
    mockApi = createMockGmailApi();
    injectGmailApi(channel, mockApi);

    // Ensure test directories exist
    fs.mkdirSync(path.join(groupDir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(groupDir, 'uploads'), { recursive: true });
  });

  afterEach(() => {
    // Clean up test files
    try {
      fs.rmSync('/tmp/test-gmail-groups', { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // INVARIANT: Incoming emails with attachments download them and include paths in the message.
  it('processes email with text body and file attachment', async () => {
    const attachmentData = Buffer.from('PDF content here').toString('base64');

    mockApi.users.messages.get.mockResolvedValue(
      buildGmailMessage({
        id: 'msg-1',
        threadId: 'thread-att-1',
        from: 'Sender <sender@example.com>',
        subject: 'Report with attachment',
        parts: [
          {
            mimeType: 'text/plain',
            body: {
              data: Buffer.from('See attached report.').toString('base64'),
            },
          },
          {
            mimeType: 'application/pdf',
            filename: 'report.pdf',
            body: { attachmentId: 'att-id-1', size: 1234 },
          },
        ],
      }),
    );

    mockApi.users.messages.attachments.get.mockResolvedValue({
      data: { data: attachmentData },
    });

    // Invoke processMessage directly
    await (
      channel as unknown as { processMessage(id: string): Promise<void> }
    ).processMessage('msg-1');

    // Attachment should be downloaded
    expect(mockApi.users.messages.attachments.get).toHaveBeenCalledWith({
      userId: 'me',
      messageId: 'msg-1',
      id: 'att-id-1',
    });

    // File should be saved to uploads dir
    const savedFile = path.join(groupDir, 'uploads', 'report.pdf');
    expect(fs.existsSync(savedFile)).toBe(true);
    expect(fs.readFileSync(savedFile, 'utf-8')).toBe('PDF content here');

    // Message should be delivered with attachment info
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    const content = (opts.onMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][1].content;
    expect(content).toContain('See attached report.');
    expect(content).toContain(
      '[Attachment: /workspace/group/uploads/report.pdf]',
    );
    expect(content).toContain('report.pdf');
  });

  it('processes email with inline image', async () => {
    const imageData = Buffer.from('fake-image-bytes').toString('base64');

    mockApi.users.messages.get.mockResolvedValue(
      buildGmailMessage({
        id: 'msg-2',
        threadId: 'thread-img-1',
        from: 'Photo <photo@example.com>',
        subject: 'Check this photo',
        parts: [
          {
            mimeType: 'text/plain',
            body: { data: Buffer.from('Look at this!').toString('base64') },
          },
          {
            mimeType: 'image/jpeg',
            filename: 'photo.jpg',
            body: { data: imageData },
          },
        ],
      }),
    );

    await (
      channel as unknown as { processMessage(id: string): Promise<void> }
    ).processMessage('msg-2');

    // Image should be saved to images dir (not uploads)
    const savedImage = path.join(groupDir, 'images', 'photo.jpg');
    expect(fs.existsSync(savedImage)).toBe(true);

    const content = (opts.onMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][1].content;
    expect(content).toContain('[Image: /workspace/group/images/photo.jpg');
    expect(content).toContain('photo.jpg');
  });

  it('processes email with multiple attachments', async () => {
    mockApi.users.messages.get.mockResolvedValue(
      buildGmailMessage({
        id: 'msg-3',
        threadId: 'thread-multi',
        from: 'Multi <multi@example.com>',
        subject: 'Multiple files',
        parts: [
          {
            mimeType: 'text/plain',
            body: {
              data: Buffer.from('Two files attached.').toString('base64'),
            },
          },
          {
            mimeType: 'image/png',
            filename: 'chart.png',
            body: { data: Buffer.from('png-data').toString('base64') },
          },
          {
            mimeType: 'application/zip',
            filename: 'archive.zip',
            body: { attachmentId: 'att-zip-1', size: 5000 },
          },
        ],
      }),
    );

    mockApi.users.messages.attachments.get.mockResolvedValue({
      data: { data: Buffer.from('zip-data').toString('base64') },
    });

    await (
      channel as unknown as { processMessage(id: string): Promise<void> }
    ).processMessage('msg-3');

    expect(fs.existsSync(path.join(groupDir, 'images', 'chart.png'))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(groupDir, 'uploads', 'archive.zip'))).toBe(
      true,
    );

    const content = (opts.onMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][1].content;
    expect(content).toContain('chart.png');
    expect(content).toContain('archive.zip');
    expect(content).toContain('Attachments:');
  });

  it('processes email with only attachments (no text body)', async () => {
    mockApi.users.messages.get.mockResolvedValue(
      buildGmailMessage({
        id: 'msg-4',
        threadId: 'thread-no-text',
        from: 'NoText <notext@example.com>',
        subject: 'Image only',
        parts: [
          {
            mimeType: 'image/jpeg',
            filename: 'just-image.jpg',
            body: { data: Buffer.from('img').toString('base64') },
          },
        ],
      }),
    );

    await (
      channel as unknown as { processMessage(id: string): Promise<void> }
    ).processMessage('msg-4');

    // Should still deliver even without text body
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    const content = (opts.onMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][1].content;
    expect(content).toContain('[Image:');
  });

  it('skips email with no text body and no attachments', async () => {
    mockApi.users.messages.get.mockResolvedValue(
      buildGmailMessage({
        id: 'msg-5',
        threadId: 'thread-empty',
        from: 'Empty <empty@example.com>',
        subject: 'Empty email',
        parts: [
          {
            mimeType: 'text/html',
            body: { data: Buffer.from('<p>html only</p>').toString('base64') },
          },
        ],
      }),
    );

    await (
      channel as unknown as { processMessage(id: string): Promise<void> }
    ).processMessage('msg-5');

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('skips emails from self', async () => {
    mockApi.users.messages.get.mockResolvedValue(
      buildGmailMessage({
        id: 'msg-self',
        threadId: 'thread-self',
        from: 'Me <me@example.com>',
        subject: 'My own email',
        body: 'self-sent',
      }),
    );

    await (
      channel as unknown as { processMessage(id: string): Promise<void> }
    ).processMessage('msg-self');

    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('caches threadMeta for subsequent replies', async () => {
    mockApi.users.messages.get.mockResolvedValue(
      buildGmailMessage({
        id: 'msg-cache',
        threadId: 'thread-cache',
        from: 'Cache <cache@example.com>',
        subject: 'Cache test',
        messageId: '<cache-msg@mail>',
        body: 'Hello',
      }),
    );

    await (
      channel as unknown as { processMessage(id: string): Promise<void> }
    ).processMessage('msg-cache');

    // Now send a reply — should use cached metadata, not call threads.get
    await channel.sendMessage('gmail:thread-cache', 'Reply');

    expect(mockApi.users.threads.get).not.toHaveBeenCalled();
    expect(mockApi.users.messages.send).toHaveBeenCalledTimes(1);
    const decoded = Buffer.from(
      mockApi.users.messages.send.mock.calls[0][0].requestBody.raw,
      'base64',
    ).toString('utf-8');
    expect(decoded).toContain('To: cache@example.com');
    expect(decoded).toContain('In-Reply-To: <cache-msg@mail>');
  });

  it('sanitizes attachment filenames with special characters', async () => {
    mockApi.users.messages.get.mockResolvedValue(
      buildGmailMessage({
        id: 'msg-special',
        threadId: 'thread-special',
        from: 'Special <special@example.com>',
        subject: 'Special chars',
        parts: [
          {
            mimeType: 'text/plain',
            body: { data: Buffer.from('See file').toString('base64') },
          },
          {
            mimeType: 'application/pdf',
            filename: 'my report (final) [v2].pdf',
            body: { data: Buffer.from('pdf').toString('base64') },
          },
        ],
      }),
    );

    await (
      channel as unknown as { processMessage(id: string): Promise<void> }
    ).processMessage('msg-special');

    // Filename should be sanitized
    const sanitized = 'my_report__final___v2_.pdf';
    expect(fs.existsSync(path.join(groupDir, 'uploads', sanitized))).toBe(true);
  });

  it('handles attachment download failure gracefully', async () => {
    mockApi.users.messages.get.mockResolvedValue(
      buildGmailMessage({
        id: 'msg-fail',
        threadId: 'thread-fail',
        from: 'Fail <fail@example.com>',
        subject: 'Broken attachment',
        parts: [
          {
            mimeType: 'text/plain',
            body: { data: Buffer.from('text').toString('base64') },
          },
          {
            mimeType: 'application/pdf',
            filename: 'broken.pdf',
            body: { attachmentId: 'att-broken', size: 100 },
          },
        ],
      }),
    );

    mockApi.users.messages.attachments.get.mockRejectedValue(
      new Error('API error'),
    );

    await (
      channel as unknown as { processMessage(id: string): Promise<void> }
    ).processMessage('msg-fail');

    // Should still deliver the text body even if attachment fails
    expect(opts.onMessage).toHaveBeenCalledTimes(1);
    const content = (opts.onMessage as ReturnType<typeof vi.fn>).mock
      .calls[0][1].content;
    expect(content).toContain('text');
    // Should NOT contain attachment info since download failed
    expect(content).not.toContain('Attachments:');
  });

  it('skips email when no main group is registered', async () => {
    const noMainOpts = makeOpts({ registeredGroups: () => ({}) });
    const noMainChannel = new GmailChannel(noMainOpts);
    injectGmailApi(noMainChannel, mockApi);

    mockApi.users.messages.get.mockResolvedValue(
      buildGmailMessage({
        id: 'msg-no-main',
        threadId: 'thread-no-main',
        from: 'Alice <alice@example.com>',
        subject: 'Hi',
        body: 'Hello',
      }),
    );

    await (
      noMainChannel as unknown as { processMessage(id: string): Promise<void> }
    ).processMessage('msg-no-main');
    expect(noMainOpts.onMessage).not.toHaveBeenCalled();
  });
});

describe('fetchThreadMeta', () => {
  let channel: GmailChannel;
  let mockApi: MockGmailApi;

  beforeEach(() => {
    channel = new GmailChannel(makeOpts());
    mockApi = createMockGmailApi();
    injectGmailApi(channel, mockApi);
  });

  it('returns undefined when gmail is not initialized', async () => {
    await channel.disconnect();
    const result = await (
      channel as unknown as {
        fetchThreadMeta(
          id: string,
        ): Promise<Record<string, string> | undefined>;
      }
    ).fetchThreadMeta('thread-x');
    expect(result).toBeUndefined();
  });

  it('returns undefined when thread has no messages', async () => {
    mockApi.users.threads.get.mockResolvedValue({
      data: { messages: [] },
    });
    const result = await (
      channel as unknown as {
        fetchThreadMeta(
          id: string,
        ): Promise<Record<string, string> | undefined>;
      }
    ).fetchThreadMeta('thread-empty');
    expect(result).toBeUndefined();
  });

  it('returns undefined on API error', async () => {
    mockApi.users.threads.get.mockRejectedValue(new Error('API down'));
    const result = await (
      channel as unknown as {
        fetchThreadMeta(
          id: string,
        ): Promise<Record<string, string> | undefined>;
      }
    ).fetchThreadMeta('thread-error');
    expect(result).toBeUndefined();
  });

  it('extracts metadata from single-message thread', async () => {
    mockApi.users.threads.get.mockResolvedValue({
      data: {
        messages: [
          {
            payload: {
              headers: [
                { name: 'From', value: '"Jane Doe" <jane@example.com>' },
                { name: 'Subject', value: 'Hello' },
                { name: 'Message-ID', value: '<jane-1@mail>' },
              ],
            },
          },
        ],
      },
    });

    const result = await (
      channel as unknown as {
        fetchThreadMeta(
          id: string,
        ): Promise<Record<string, string> | undefined>;
      }
    ).fetchThreadMeta('thread-jane');
    expect(result).toEqual({
      sender: 'jane@example.com',
      senderName: 'Jane Doe',
      subject: 'Hello',
      messageId: '<jane-1@mail>',
    });
  });

  it('skips self-authored messages to find external sender', async () => {
    mockApi.users.threads.get.mockResolvedValue({
      data: {
        messages: [
          {
            payload: {
              headers: [
                { name: 'From', value: 'External <ext@example.com>' },
                { name: 'Subject', value: 'Thread' },
                { name: 'Message-ID', value: '<ext-1@mail>' },
              ],
            },
          },
          {
            payload: {
              headers: [
                { name: 'From', value: 'me@example.com' },
                { name: 'Subject', value: 'Re: Thread' },
                { name: 'Message-ID', value: '<self@mail>' },
              ],
            },
          },
        ],
      },
    });

    const result = await (
      channel as unknown as {
        fetchThreadMeta(
          id: string,
        ): Promise<Record<string, string> | undefined>;
      }
    ).fetchThreadMeta('thread-mixed');
    expect(result?.sender).toBe('ext@example.com');
    expect(result?.senderName).toBe('External');
  });
});

describe('mimeTypeFromExtension', () => {
  it('returns correct types for common extensions', () => {
    expect(mimeTypeFromExtension('photo.jpg')).toBe('image/jpeg');
    expect(mimeTypeFromExtension('photo.jpeg')).toBe('image/jpeg');
    expect(mimeTypeFromExtension('image.png')).toBe('image/png');
    expect(mimeTypeFromExtension('doc.pdf')).toBe('application/pdf');
    expect(mimeTypeFromExtension('data.csv')).toBe('text/csv');
    expect(mimeTypeFromExtension('archive.zip')).toBe('application/zip');
  });

  it('returns octet-stream for unknown extensions', () => {
    expect(mimeTypeFromExtension('file.xyz')).toBe('application/octet-stream');
    expect(mimeTypeFromExtension('noext')).toBe('application/octet-stream');
  });

  it('handles uppercase extensions', () => {
    expect(mimeTypeFromExtension('Photo.JPG')).toBe('image/jpeg');
    expect(mimeTypeFromExtension('Doc.PDF')).toBe('application/pdf');
  });
});
