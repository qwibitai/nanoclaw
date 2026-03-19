import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({
    SIGNAL_BRIDGE_URL: 'http://signal-bridge.local:8420',
    SIGNAL_BRIDGE_TOKEN: 'secret-token',
  }),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { SignalChannel } from './signal.js';
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    json: async () => body,
  } as Response;
}

function createTestOpts() {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'signal:thread-1': {
        name: 'Signal Main',
        folder: 'signal_main',
        trigger: '@Andy',
        added_at: '2026-03-09T12:00:00.000Z',
      },
    })),
  };
}

describe('SignalChannel', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('connects, syncs metadata, and polls events', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(
        jsonResponse({
          threads: [
            {
              id: 'thread-1',
              name: 'Signal Main',
              isGroup: false,
              lastMessageAt: '2026-03-09T12:01:00.000Z',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          events: [
            {
              id: 'evt-1',
              type: 'message',
              direction: 'incoming',
              threadId: 'thread-1',
              threadName: 'Signal Main',
              senderId: '+358401234567',
              senderName: 'Alice',
              text: '@Andy hello',
              timestamp: '2026-03-09T12:02:00.000Z',
              isGroup: false,
              attachments: [],
            },
          ],
          nextCursor: 'cursor-1',
        }),
      );

    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://signal-bridge.local:8420',
      'secret-token',
      opts,
    );

    await channel.connect();

    expect(channel.isConnected()).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://signal-bridge.local:8420/health',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token',
        }),
      }),
    );
    expect(opts.onChatMetadata).toHaveBeenCalledWith(
      'signal:thread-1',
      '2026-03-09T12:01:00.000Z',
      'Signal Main',
      'signal',
      false,
    );
    expect(opts.onMessage).toHaveBeenCalledWith(
      'signal:thread-1',
      expect.objectContaining({
        id: 'evt-1',
        sender_name: 'Alice',
        content: '@Andy hello',
        is_from_me: false,
      }),
    );

    await channel.disconnect();
  });

  it('formats attachment placeholders for non-text messages', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ threads: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          events: [
            {
              id: 'evt-2',
              threadId: 'thread-1',
              direction: 'incoming',
              senderId: '+358401234567',
              senderName: 'Alice',
              timestamp: '2026-03-09T12:03:00.000Z',
              attachments: [{ kind: 'image' }, { kind: 'document', name: 'a.pdf' }],
            },
          ],
        }),
      );

    const opts = createTestOpts();
    const channel = new SignalChannel(
      'http://signal-bridge.local:8420',
      'secret-token',
      opts,
    );

    await channel.connect();

    expect(opts.onMessage).toHaveBeenCalledWith(
      'signal:thread-1',
      expect.objectContaining({
        content: '[Photo] [Document: a.pdf]',
      }),
    );

    await channel.disconnect();
  });

  it('posts outbound messages to the bridge', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));

    const channel = new SignalChannel(
      'http://signal-bridge.local:8420',
      'secret-token',
      createTestOpts(),
    );

    await channel.sendMessage('signal:thread-9', 'hello');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://signal-bridge.local:8420/messages',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ threadId: 'thread-9', text: 'hello' }),
      }),
    );
  });

  it('owns the signal jid namespace', () => {
    const channel = new SignalChannel(
      'http://signal-bridge.local:8420',
      'secret-token',
      createTestOpts(),
    );

    expect(channel.ownsJid('signal:thread-9')).toBe(true);
    expect(channel.ownsJid('tg:123')).toBe(false);
  });
});
