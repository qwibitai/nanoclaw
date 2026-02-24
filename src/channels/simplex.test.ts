import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type WebSocket from 'ws';

// --- Mocks ---

vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    mkdtempSync: vi.fn((prefix: string) => `${prefix}test`),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
    statSync: vi.fn(() => ({ size: 1024 })),
    rmSync: vi.fn(),
  },
}));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  GROUPS_DIR: '/tmp/test-groups',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Build a fake WebSocket
function createFakeWebSocket() {
  const ws = new EventEmitter() as EventEmitter & {
    readyState: number;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    simulateOpen: () => void;
    simulateClose: () => void;
    simulateMessage: (data: unknown) => void;
    OPEN: number;
  };

  ws.readyState = 1;
  ws.send = vi.fn();
  ws.close = vi.fn(() => {
    ws.readyState = 3;
  });
  ws.OPEN = 1;

  ws.simulateOpen = () => {
    ws.readyState = 1;
    ws.emit('open');
  };

  ws.simulateClose = () => {
    ws.readyState = 3;
    ws.emit('close');
  };

  ws.simulateMessage = (data: unknown) => {
    ws.emit('message', JSON.stringify(data));
  };

  return ws;
}

type FakeWs = ReturnType<typeof createFakeWebSocket>;

import { SimplexChannel, SimplexChannelOpts, formatForSimplex } from './simplex.js';

// --- Test helpers ---

let fakeWs: FakeWs;
let wsFactory: ReturnType<typeof vi.fn>;

function createTestOpts(overrides?: Partial<SimplexChannelOpts>): SimplexChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'sx:42': {
        name: 'Main',
        folder: 'main',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'sx:g:10': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    createWebSocket: wsFactory as unknown as (url: string) => WebSocket,
    ...overrides,
  };
}

function makeDirectMessage(contactId: number, displayName: string, text: string, localDisplayName?: string) {
  return {
    resp: {
      type: 'newChatItems',
      chatItems: [
        {
          chatInfo: {
            type: 'direct',
            contact: {
              contactId,
              localDisplayName: localDisplayName ?? displayName,
              profile: { displayName },
            },
          },
          chatItem: {
            chatDir: { type: 'directRcv' },
            content: {
              type: 'rcvMsgContent',
              msgContent: { type: 'text', text },
            },
          },
        },
      ],
    },
  };
}

function makeGroupMessage(
  groupId: number,
  groupName: string,
  memberId: number,
  senderName: string,
  text: string,
) {
  return {
    resp: {
      type: 'newChatItems',
      chatItems: [
        {
          chatInfo: {
            type: 'group',
            groupInfo: {
              groupId,
              groupProfile: { displayName: groupName },
            },
          },
          chatItem: {
            chatDir: {
              type: 'groupRcv',
              groupMember: {
                memberId,
                memberProfile: { displayName: senderName },
              },
            },
            content: {
              type: 'rcvMsgContent',
              msgContent: { type: 'text', text },
            },
          },
        },
      ],
    },
  };
}

function makeDirectImageMessage(
  contactId: number,
  displayName: string,
  imageBase64: string | undefined,
  caption?: string,
) {
  return {
    resp: {
      type: 'newChatItems',
      chatItems: [
        {
          chatInfo: {
            type: 'direct',
            contact: {
              contactId,
              localDisplayName: displayName,
              profile: { displayName },
            },
          },
          chatItem: {
            chatDir: { type: 'directRcv' },
            content: {
              type: 'rcvMsgContent',
              msgContent: {
                type: 'image',
                ...(imageBase64 !== undefined && { image: imageBase64 }),
                ...(caption !== undefined && { text: caption }),
              },
            },
          },
        },
      ],
    },
  };
}

// --- Tests ---

describe('SimplexChannel', () => {
  beforeEach(() => {
    fakeWs = createFakeWebSocket();
    wsFactory = vi.fn(() => fakeWs);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when WebSocket opens', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      expect(channel.isConnected()).toBe(true);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(fakeWs.close).toHaveBeenCalled();
    });

    it('reports not connected before connect()', () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Inbound message parsing ---

  describe('inbound messages', () => {
    it('handles direct message from registered contact', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      fakeWs.simulateMessage(makeDirectMessage(42, 'Alice', 'Hello Andy'));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'sx:42',
        expect.any(String),
        'Alice',
        'simplex',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'sx:42',
        expect.objectContaining({
          chat_jid: 'sx:42',
          sender_name: 'Alice',
          content: 'Hello Andy',
          is_from_me: false,
          is_bot_message: false,
        }),
      );
    });

    it('handles group message from registered group', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      fakeWs.simulateMessage(makeGroupMessage(10, 'Test Group', 5, 'Bob', 'Hey everyone'));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'sx:g:10',
        expect.any(String),
        'Test Group',
        'simplex',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'sx:g:10',
        expect.objectContaining({
          chat_jid: 'sx:g:10',
          sender_name: 'Bob',
          content: 'Hey everyone',
        }),
      );
    });

    it('only emits metadata for unregistered contacts', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      fakeWs.simulateMessage(makeDirectMessage(99, 'Stranger', 'Hi'));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'sx:99',
        expect.any(String),
        'Stranger',
        'simplex',
        false,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores sent messages (directSnd)', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      fakeWs.simulateMessage({
        resp: {
          type: 'newChatItems',
          chatItems: [
            {
              chatInfo: {
                type: 'direct',
                contact: { contactId: 42, profile: { displayName: 'Alice' } },
              },
              chatItem: {
                chatDir: { type: 'directSnd' },
                content: {
                  type: 'sndMsgContent',
                  msgContent: { type: 'text', text: 'My own message' },
                },
              },
            },
          ],
        },
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('handles image messages with base64 data', async () => {
      const fs = await import('fs');
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      // JPEG data URI as SimpleX sends it
      const jpegBase64url = 'data:image/jpg;base64,/9j/4AAQ';
      fakeWs.simulateMessage(makeDirectImageMessage(42, 'Alice', jpegBase64url));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sx:42',
        expect.objectContaining({
          chat_jid: 'sx:42',
          content: expect.stringContaining('[Image: /workspace/group/media/'),
        }),
      );
      expect(fs.default.mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('media'),
        { recursive: true },
      );
      expect(fs.default.writeFileSync).toHaveBeenCalled();
    });

    it('handles image with caption', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      const jpegDataUri = 'data:image/jpg;base64,/9j/4AAQ';
      fakeWs.simulateMessage(makeDirectImageMessage(42, 'Alice', jpegDataUri, 'Check this out'));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sx:42',
        expect.objectContaining({
          content: expect.stringMatching(/\[Image: \/workspace\/group\/media\/.*\]\nCheck this out/),
        }),
      );
    });

    it('delivers [Image] placeholder when no base64 data', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      fakeWs.simulateMessage(makeDirectImageMessage(42, 'Alice', undefined));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sx:42',
        expect.objectContaining({
          content: '[Image]',
        }),
      );
    });
  });

  // --- Outbound message sending ---

  describe('outbound messages', () => {
    it('sends direct message using cached contact name', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      // First, receive a message to cache the contact name
      fakeWs.simulateMessage(makeDirectMessage(42, 'Alice', 'Hi'));

      // Now send a reply
      await channel.sendMessage('sx:42', 'Hello back');

      expect(fakeWs.send).toHaveBeenCalledWith(
        expect.stringContaining('@Alice Hello back'),
      );
    });

    it('sends group message using cached group name', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      // Receive a group message to cache the group name
      fakeWs.simulateMessage(makeGroupMessage(10, 'TestGroup', 5, 'Bob', 'Hey'));

      await channel.sendMessage('sx:g:10', 'Group reply');

      expect(fakeWs.send).toHaveBeenCalledWith(
        expect.stringContaining('#TestGroup Group reply'),
      );
    });

    it('falls back to /send command when no cached name', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      await channel.sendMessage('sx:42', 'Hello');

      expect(fakeWs.send).toHaveBeenCalledWith(
        expect.stringContaining('/send @42 text Hello'),
      );
    });

    it('does not prefix messages with assistant name', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      fakeWs.simulateMessage(makeDirectMessage(42, 'Alice', 'Hi'));
      await channel.sendMessage('sx:42', 'test message');

      // Find the send call that contains the user message (skip /_files_folder setup)
      const msgCall = fakeWs.send.mock.calls.find((c: unknown[]) => {
        const payload = JSON.parse(c[0] as string);
        return !payload.cmd.startsWith('/_files_folder');
      });
      expect(msgCall).toBeDefined();
      const sentPayload = JSON.parse(msgCall![0] as string);
      expect(sentPayload.cmd).toContain('test message');
      expect(sentPayload.cmd).not.toContain('Andy:');
    });
  });

  // --- JID ownership ---

  describe('ownsJid', () => {
    it('owns sx: JIDs (SimpleX DMs)', () => {
      const channel = new SimplexChannel(5225, createTestOpts());
      expect(channel.ownsJid('sx:42')).toBe(true);
    });

    it('owns sx:g: JIDs (SimpleX groups)', () => {
      const channel = new SimplexChannel(5225, createTestOpts());
      expect(channel.ownsJid('sx:g:10')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new SimplexChannel(5225, createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SimplexChannel(5225, createTestOpts());
      expect(channel.ownsJid('tg:12345')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new SimplexChannel(5225, createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- Queue behavior ---

  describe('outgoing queue', () => {
    it('queues messages when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      // Don't connect — channel starts disconnected
      await channel.sendMessage('sx:42', 'Queued message');
      // No ws.send should have been called since we never connected
    });

    it('flushes queue on reconnect', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      // Queue a message while not connected
      await channel.sendMessage('sx:42', 'Queued');

      // Now connect — should flush
      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      // Give flush time to run
      await vi.advanceTimersByTimeAsync(0);

      expect(fakeWs.send).toHaveBeenCalledWith(
        expect.stringContaining('Queued'),
      );
    });
  });

  // --- Reconnection ---

  describe('reconnection', () => {
    it('reconnects after WebSocket close with 5s delay', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      expect(channel.isConnected()).toBe(true);

      // Simulate close
      const callCountBefore = wsFactory.mock.calls.length;
      fakeWs.simulateClose();
      expect(channel.isConnected()).toBe(false);

      // WebSocket factory should be called again after 5s
      await vi.advanceTimersByTimeAsync(5000);

      expect(wsFactory.mock.calls.length).toBeGreaterThan(callCountBefore);
    });

    it('does not reconnect after explicit disconnect', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      await channel.disconnect();

      const callCountAfter = wsFactory.mock.calls.length;
      await vi.advanceTimersByTimeAsync(10000);

      // No new WebSocket connection should be created
      expect(wsFactory.mock.calls.length).toBe(callCountAfter);
    });
  });

  // --- Malformed JSON resilience ---

  describe('malformed input resilience', () => {
    it('handles invalid JSON without crashing', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      fakeWs.emit('message', 'not valid json');

      expect(channel.isConnected()).toBe(true);
    });

    it('handles events with missing resp field', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      fakeWs.simulateMessage({ corrId: '1' });

      expect(channel.isConnected()).toBe(true);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('handles newChatItems with missing chatItem fields', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      fakeWs.simulateMessage({
        resp: {
          type: 'newChatItems',
          chatItems: [{ chatInfo: { type: 'direct' } }],
        },
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('handles events with unknown type gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SimplexChannel(5225, opts);

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeWs.simulateOpen();
      await p;

      fakeWs.simulateMessage({
        resp: { type: 'chatItemUpdated', chatItem: {} },
      });

      expect(channel.isConnected()).toBe(true);
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "simplex"', () => {
      const channel = new SimplexChannel(5225, createTestOpts());
      expect(channel.name).toBe('simplex');
    });
  });
});

// --- formatForSimplex ---

describe('formatForSimplex', () => {
  it('converts headings to bold', () => {
    expect(formatForSimplex('## Summary')).toBe('*Summary*');
    expect(formatForSimplex('### Details')).toBe('*Details*');
    expect(formatForSimplex('# Title')).toBe('*Title*');
  });

  it('converts **double asterisks** to *single*', () => {
    expect(formatForSimplex('This is **bold** text')).toBe('This is *bold* text');
  });

  it('converts __double underscores__ to *bold*', () => {
    expect(formatForSimplex('This is __bold__ text')).toBe('This is *bold* text');
  });

  it('strips fenced code block markers but keeps content', () => {
    const input = 'Before\n```js\nconst x = 1;\nconsole.log(x);\n```\nAfter';
    const expected = 'Before\nconst x = 1;\nconsole.log(x);\nAfter';
    expect(formatForSimplex(input)).toBe(expected);
  });

  it('strips blockquote prefixes', () => {
    expect(formatForSimplex('> quoted text')).toBe('quoted text');
    expect(formatForSimplex('> line one\n> line two')).toBe('line one\nline two');
  });

  it('handles empty blockquote lines', () => {
    expect(formatForSimplex('> first\n>\n> second')).toBe('first\n\nsecond');
  });

  it('leaves already-compatible formatting alone', () => {
    expect(formatForSimplex('*bold* and _italic_ and `code`')).toBe('*bold* and _italic_ and `code`');
  });

  it('handles mixed formatting in one message', () => {
    const input = '## Title\n\nSome **bold** and _italic_ text.\n\n```\ncode here\n```\n\n> A quote';
    const expected = '*Title*\n\nSome *bold* and _italic_ text.\n\ncode here\n\nA quote';
    expect(formatForSimplex(input)).toBe(expected);
  });

  it('passes plain text through unchanged', () => {
    const plain = 'Just a normal message with no formatting.';
    expect(formatForSimplex(plain)).toBe(plain);
  });
});
