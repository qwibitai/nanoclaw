import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- WebSocket mock ---

type WSHandler = (event: any) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  url: string;
  listeners = new Map<string, WSHandler[]>();
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, handler: WSHandler) {
    const existing = this.listeners.get(event) || [];
    existing.push(handler);
    this.listeners.set(event, existing);
  }

  close() {
    this.closed = true;
  }

  // Test helper: simulate server event
  _emit(event: string, data?: any) {
    const handlers = this.listeners.get(event) || [];
    for (const h of handlers) h(data ?? {});
  }

  _emitOpen() {
    this._emit('open');
  }

  _emitMessage(data: any) {
    this._emit('message', { data: JSON.stringify(data) });
  }

  _emitClose() {
    this._emit('close');
  }

  _emitError(err?: any) {
    this._emit('error', err ?? new Error('ws error'));
  }
}

// Replace global WebSocket
const originalWebSocket = globalThis.WebSocket;
beforeEach(() => {
  MockWebSocket.instances = [];
  (globalThis as any).WebSocket = MockWebSocket;
});
afterEach(() => {
  (globalThis as any).WebSocket = originalWebSocket;
});

// --- fetch mock ---

const mockFetch = vi.fn();
const originalFetch = globalThis.fetch;
beforeEach(() => {
  (globalThis as any).fetch = mockFetch;
  mockFetch.mockReset();
});
afterEach(() => {
  (globalThis as any).fetch = originalFetch;
});

import { SignalChannel, SignalChannelOpts } from './signal.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<SignalChannelOpts>,
): SignalChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'sig:+15559990000': {
        name: 'Personal DM',
        folder: 'main',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'sig:groupABC123': {
        name: 'Team Chat',
        folder: 'team',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function currentWs(): MockWebSocket {
  return MockWebSocket.instances[MockWebSocket.instances.length - 1];
}

/** Connect a channel, automatically resolving the WebSocket open */
async function connectChannel(
  channel: SignalChannel,
): Promise<MockWebSocket> {
  // Mock /v1/about as reachable
  mockFetch.mockResolvedValueOnce({ ok: true });

  const connectPromise = channel.connect();
  // The fetch is async so we need to flush the microtask queue
  // to allow the WebSocket constructor to be called
  await vi.advanceTimersByTimeAsync(0);

  const ws = currentWs();
  ws._emitOpen();
  await connectPromise;
  return ws;
}

function makeEnvelope(overrides: {
  source?: string;
  sourceName?: string;
  message?: string;
  timestamp?: number;
  groupId?: string;
  groupName?: string;
  attachments?: any[];
}) {
  const dataMessage: any = {
    timestamp: overrides.timestamp ?? Date.now(),
    message: overrides.message ?? null,
  };
  if (overrides.groupId) {
    dataMessage.groupInfo = {
      groupId: overrides.groupId,
      groupName: overrides.groupName || 'Group',
    };
  }
  if (overrides.attachments) {
    dataMessage.attachments = overrides.attachments;
  }
  return {
    envelope: {
      source: overrides.source ?? '+15559990000',
      sourceName: overrides.sourceName ?? 'Alice',
      dataMessage,
    },
  };
}

// --- Tests ---

describe('SignalChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('verifies API is reachable before connecting WebSocket', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );

      mockFetch.mockResolvedValueOnce({ ok: true });
      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      currentWs()._emitOpen();
      await p;

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/about',
      );
    });

    it('throws if API is not reachable', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );

      mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });

      await expect(channel.connect()).rejects.toThrow('Signal API not reachable');
    });

    it('connects WebSocket to correct URL', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );

      await connectChannel(channel);

      expect(currentWs().url).toBe(
        'ws://localhost:8080/v1/receive/+15551234567',
      );
    });

    it('converts https to wss for WebSocket URL', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'https://signal.example.com',
        '+15551234567',
        opts,
      );

      await connectChannel(channel);

      expect(currentWs().url).toBe(
        'wss://signal.example.com/v1/receive/+15551234567',
      );
    });

    it('isConnected() is true after connect', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );

      await connectChannel(channel);

      expect(channel.isConnected()).toBe(true);
    });

    it('isConnected() is false before connect', () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );

      expect(channel.isConnected()).toBe(false);
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );

      const ws = await connectChannel(channel);

      await channel.disconnect();

      expect(ws.closed).toBe(true);
      expect(channel.isConnected()).toBe(false);
    });

    it('auto-reconnects on WebSocket close', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );

      const ws1 = await connectChannel(channel);
      ws1._emitClose();

      expect(channel.isConnected()).toBe(false);

      // Advance past reconnect delay (5s) — openWebSocket() will be called
      await vi.advanceTimersByTimeAsync(5000);

      // A new WebSocket should have been created
      expect(MockWebSocket.instances.length).toBe(2);

      // Complete the reconnection so it doesn't hang
      currentWs()._emitOpen();
      await vi.advanceTimersByTimeAsync(0);

      expect(channel.isConnected()).toBe(true);
    });

    it('does not reconnect after explicit disconnect', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );

      await connectChannel(channel);
      await channel.disconnect();

      await vi.advanceTimersByTimeAsync(10000);

      // Only the initial WebSocket should exist
      expect(MockWebSocket.instances.length).toBe(1);
    });
  });

  // --- DM message handling ---

  describe('DM message handling', () => {
    it('delivers DM for registered chat', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      const ts = 1704067200000; // 2024-01-01T00:00:00.000Z
      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          sourceName: 'Alice',
          message: 'Hello',
          timestamp: ts,
        }),
      );

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'sig:+15559990000',
        '2024-01-01T00:00:00.000Z',
        'Alice',
        'signal',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({
          id: `${ts}-+15559990000`,
          chat_jid: 'sig:+15559990000',
          sender: '+15559990000',
          sender_name: 'Alice',
          content: 'Hello',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered DMs', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15550000001',
          sourceName: 'Unknown',
          message: 'Hey',
        }),
      );

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('uses sender phone as name when sourceName is missing', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      const envelope = makeEnvelope({
        source: '+15559990000',
        message: 'Hi',
      });
      envelope.envelope.sourceName = undefined as any;
      ws._emitMessage(envelope);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({ sender_name: '+15559990000' }),
      );
    });
  });

  // --- Group message handling ---

  describe('group message handling', () => {
    it('delivers group message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          sourceName: 'Alice',
          message: 'Group hello',
          groupId: 'groupABC123',
          groupName: 'Team Chat',
        }),
      );

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'sig:groupABC123',
        expect.any(String),
        'Team Chat',
        'signal',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:groupABC123',
        expect.objectContaining({
          chat_jid: 'sig:groupABC123',
          sender: '+15559990000',
          content: 'Group hello',
        }),
      );
    });

    it('only emits metadata for unregistered groups', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: 'Test',
          groupId: 'unknownGroup',
          groupName: 'Random',
        }),
      );

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Self-message filtering ---

  describe('self-message filtering', () => {
    it('ignores messages from own phone number', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15551234567', // same as channel's phone number
          message: 'My own message',
        }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });
  });

  // --- Commands ---

  describe('commands', () => {
    it('!chatid replies with DM chat ID', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      // Mock the send response
      mockFetch.mockResolvedValueOnce({ ok: true });

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          sourceName: 'Alice',
          message: '!chatid',
        }),
      );

      // Should have called sendMessage (fetch POST to /v2/send)
      // Allow async send to complete
      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v2/send',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('sig:+15559990000'),
        }),
      );

      // Should NOT deliver as a regular message
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('!chatid replies with group chat ID', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({ ok: true });

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: '!chatid',
          groupId: 'groupABC123',
          groupName: 'Team Chat',
        }),
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v2/send',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('sig:groupABC123'),
        }),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('!ping replies with online status', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({ ok: true });

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: '!ping',
        }),
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v2/send',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('Andy is online'),
        }),
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Media placeholders ---

  describe('media placeholders', () => {
    it('maps image attachment to [Photo]', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: '',
          attachments: [{ contentType: 'image/jpeg' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({ content: '[Photo]' }),
      );
    });

    it('maps video attachment to [Video]', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: '',
          attachments: [{ contentType: 'video/mp4' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({ content: '[Video]' }),
      );
    });

    it('maps audio attachment to [Audio]', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: '',
          attachments: [{ contentType: 'audio/ogg' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({ content: '[Audio]' }),
      );
    });

    it('maps unknown attachment to [Attachment]', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: '',
          attachments: [{ contentType: 'application/pdf' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({ content: '[Attachment]' }),
      );
    });

    it('appends attachment placeholder to text message', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: 'Look at this',
          attachments: [{ contentType: 'image/png' }],
        }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'sig:+15559990000',
        expect.objectContaining({ content: 'Look at this [Photo]' }),
      );
    });

    it('ignores messages with no text and no attachments', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage(
        makeEnvelope({
          source: '+15559990000',
          message: '',
        }),
      );

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends DM with recipients array', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({ ok: true });
      await channel.sendMessage('sig:+15559990000', 'Hello');

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v2/send',
        expect.objectContaining({ method: 'POST' }),
      );

      const body = JSON.parse(
        (mockFetch.mock.calls.find(
          (c: any) => c[0] === 'http://localhost:8080/v2/send',
        ) as any)[1].body,
      );
      expect(body.recipients).toEqual(['+15559990000']);
      expect(body.number).toBe('+15551234567');
      expect(body.message).toBe('Hello');
    });

    it('sends group message with group field', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({ ok: true });
      await channel.sendMessage('sig:groupABC123', 'Group msg');

      const sendCall = mockFetch.mock.calls.find(
        (c: any) => c[0] === 'http://localhost:8080/v2/send',
      ) as any;
      const body = JSON.parse(sendCall[1].body);
      expect(body.group).toBe('groupABC123');
      expect(body.recipients).toEqual([]);
    });

    it('splits messages exceeding 4000 characters', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValueOnce({ ok: true });

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('sig:+15559990000', longText);

      const sendCalls = mockFetch.mock.calls.filter(
        (c: any) => c[0] === 'http://localhost:8080/v2/send',
      );
      expect(sendCalls.length).toBe(2);

      const body1 = JSON.parse((sendCalls[0] as any)[1].body);
      const body2 = JSON.parse((sendCalls[1] as any)[1].body);
      expect(body1.message.length).toBe(4000);
      expect(body2.message.length).toBe(1000);
    });

    it('sends exactly one message at 4000 characters', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({ ok: true });

      await channel.sendMessage('sig:+15559990000', 'y'.repeat(4000));

      const sendCalls = mockFetch.mock.calls.filter(
        (c: any) => c[0] === 'http://localhost:8080/v2/send',
      );
      expect(sendCalls.length).toBe(1);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      await expect(
        channel.sendMessage('sig:+15559990000', 'Will fail'),
      ).resolves.toBeUndefined();
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends PUT for typing start on DM', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({ ok: true });
      await channel.setTyping('sig:+15559990000', true);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/typing-indicator/+15551234567',
        expect.objectContaining({ method: 'PUT' }),
      );

      const typingCall = mockFetch.mock.calls.find(
        (c: any) =>
          typeof c[0] === 'string' && c[0].includes('typing-indicator'),
      ) as any;
      const body = JSON.parse(typingCall[1].body);
      expect(body.recipient).toBe('+15559990000');
    });

    it('sends DELETE for typing stop', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({ ok: true });
      await channel.setTyping('sig:+15559990000', false);

      const typingCall = mockFetch.mock.calls.find(
        (c: any) =>
          typeof c[0] === 'string' && c[0].includes('typing-indicator'),
      ) as any;
      expect(typingCall[1].method).toBe('DELETE');
    });

    it('sends group typing indicator with group field', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockResolvedValueOnce({ ok: true });
      await channel.setTyping('sig:groupABC123', true);

      const typingCall = mockFetch.mock.calls.find(
        (c: any) =>
          typeof c[0] === 'string' && c[0].includes('typing-indicator'),
      ) as any;
      const body = JSON.parse(typingCall[1].body);
      expect(body.group).toBe('groupABC123');
      expect(body.recipient).toBeUndefined();
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      await connectChannel(channel);

      mockFetch.mockRejectedValueOnce(new Error('Rate limited'));

      await expect(
        channel.setTyping('sig:+15559990000', true),
      ).resolves.toBeUndefined();
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns sig: JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        createTestOpts(),
      );
      expect(channel.ownsJid('sig:+15559990000')).toBe(true);
    });

    it('owns sig: group JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        createTestOpts(),
      );
      expect(channel.ownsJid('sig:groupABC123')).toBe(true);
    });

    it('does not own tg: JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        createTestOpts(),
      );
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        createTestOpts(),
      );
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        createTestOpts(),
      );
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "signal"', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        createTestOpts(),
      );
      expect(channel.name).toBe('signal');
    });
  });

  // --- Edge cases ---

  describe('edge cases', () => {
    it('ignores envelopes with no dataMessage', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage({ envelope: { source: '+15559990000' } });

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('ignores envelopes with no source', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      ws._emitMessage({
        envelope: { dataMessage: { timestamp: Date.now(), message: 'Hi' } },
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores malformed JSON', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+15551234567',
        opts,
      );
      const ws = await connectChannel(channel);

      // Send raw non-JSON string
      ws._emit('message', { data: 'not-json' });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('strips trailing slash from API URL', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080/',
        '+15551234567',
        opts,
      );

      await connectChannel(channel);

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8080/v1/about',
      );
    });
  });
});
