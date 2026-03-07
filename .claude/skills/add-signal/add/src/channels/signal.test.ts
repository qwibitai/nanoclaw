import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
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

const wsRef = vi.hoisted(() => ({ current: null as any }));

vi.mock('ws', () => {
  class MockWebSocket {
    url: string;
    readyState = 0; // CONNECTING

    private _listeners = new Map<string, Array<(...args: any[]) => any>>();
    private _onceListeners = new Map<string, Array<(...args: any[]) => any>>();

    constructor(url: string) {
      this.url = url;
      wsRef.current = this;
    }

    on(event: string, handler: (...args: any[]) => any) {
      const list = this._listeners.get(event) ?? [];
      list.push(handler);
      this._listeners.set(event, list);
    }

    once(event: string, handler: (...args: any[]) => any) {
      const list = this._onceListeners.get(event) ?? [];
      list.push(handler);
      this._onceListeners.set(event, list);
    }

    close() {
      this.readyState = 3; // CLOSED
    }

    // Test helpers
    simulateOpen() {
      this.readyState = 1; // OPEN
      for (const h of this._onceListeners.get('open') ?? []) h();
      this._onceListeners.delete('open');
      for (const h of this._listeners.get('open') ?? []) h();
    }

    simulateMessage(data: object) {
      const raw = JSON.stringify(data);
      for (const h of this._listeners.get('message') ?? []) h(raw);
    }

    simulateClose() {
      this.readyState = 3;
      for (const h of this._listeners.get('close') ?? []) h();
    }

    simulateError(err: Error) {
      for (const h of this._onceListeners.get('error') ?? []) h(err);
      this._onceListeners.delete('error');
      for (const h of this._listeners.get('error') ?? []) h(err);
    }
  }

  return { default: MockWebSocket };
});

// --- fetch mock ---

const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
vi.stubGlobal('fetch', fetchMock);

// --- setTimeout mock ---

vi.useFakeTimers();

import { SignalChannel, SignalChannelOpts } from './signal.js';

// --- Helpers ---

function createTestOpts(
  overrides?: Partial<SignalChannelOpts>,
): SignalChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'signal:+1234567890': {
        name: 'Alice',
        folder: 'signal-alice',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'signal:group.abc123==': {
        name: 'Project Team',
        folder: 'signal-team',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function buildDmEnvelope(overrides: {
  source?: string;
  sourceName?: string;
  message?: string;
  timestamp?: number;
}) {
  return {
    envelope: {
      source: overrides.source ?? '+1234567890',
      sourceNumber: overrides.source ?? '+1234567890',
      sourceName: overrides.sourceName ?? 'Alice',
      timestamp: overrides.timestamp ?? 1704067200000,
      dataMessage: {
        timestamp: overrides.timestamp ?? 1704067200000,
        message: overrides.message ?? 'Hello',
        expiresInSeconds: 0,
      },
    },
    account: '+19876543210',
  };
}

function buildGroupEnvelope(overrides: {
  source?: string;
  sourceName?: string;
  groupId?: string;
  message?: string;
  timestamp?: number;
}) {
  return {
    envelope: {
      source: overrides.source ?? '+1234567890',
      sourceNumber: overrides.source ?? '+1234567890',
      sourceName: overrides.sourceName ?? 'Alice',
      timestamp: overrides.timestamp ?? 1704067200000,
      dataMessage: {
        timestamp: overrides.timestamp ?? 1704067200000,
        message: overrides.message ?? 'Hello group',
        expiresInSeconds: 0,
        groupInfo: {
          groupId: overrides.groupId ?? 'abc123==',
          type: 'DELIVER',
        },
      },
    },
    account: '+19876543210',
  };
}

function currentWs() {
  return wsRef.current;
}

async function connectChannel(channel: SignalChannel): Promise<void> {
  const connectPromise = channel.connect();
  currentWs().simulateOpen();
  await connectPromise;
}

// --- Tests ---

describe('SignalChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({ ok: true, text: async () => '' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when WebSocket opens', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        createTestOpts(),
      );
      const connectPromise = channel.connect();
      currentWs().simulateOpen();
      await connectPromise;

      expect(channel.isConnected()).toBe(true);
    });

    it('rejects connect() when WebSocket errors on open', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        createTestOpts(),
      );
      const connectPromise = channel.connect();
      const err = new Error('Connection refused');
      currentWs().simulateError(err);

      await expect(connectPromise).rejects.toThrow('Connection refused');
    });

    it('uses wss:// for https:// API URLs', async () => {
      const channel = new SignalChannel(
        'https://signal.example.com',
        '+19876543210',
        createTestOpts(),
      );
      const connectPromise = channel.connect();
      currentWs().simulateOpen();
      await connectPromise;

      expect(currentWs().url).toContain('wss://signal.example.com');
    });

    it('uses ws:// for http:// API URLs', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        createTestOpts(),
      );
      const connectPromise = channel.connect();
      currentWs().simulateOpen();
      await connectPromise;

      expect(currentWs().url).toContain('ws://localhost:8080');
    });

    it('encodes phone number in WebSocket URL', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        createTestOpts(),
      );
      const connectPromise = channel.connect();
      currentWs().simulateOpen();
      await connectPromise;

      expect(currentWs().url).toContain(
        encodeURIComponent('+19876543210'),
      );
    });

    it('isConnected() returns false before connect', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        createTestOpts(),
      );
      expect(channel.isConnected()).toBe(false);
    });

    it('disconnects cleanly', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        createTestOpts(),
      );
      await connectChannel(channel);
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('clears reconnect timer on disconnect', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        createTestOpts(),
      );
      await connectChannel(channel);
      await channel.disconnect();

      // No timers should remain after disconnect
      expect(vi.getTimerCount()).toBe(0);
    });

    it('schedules reconnect after WebSocket closes', async () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        createTestOpts(),
      );
      await connectChannel(channel);

      currentWs().simulateClose();

      expect(channel.isConnected()).toBe(false);
      expect(vi.getTimerCount()).toBe(1); // reconnect timer scheduled
    });
  });

  // --- DM message handling ---

  describe('direct message handling', () => {
    it('delivers DM message for registered contact', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      currentWs().simulateMessage(buildDmEnvelope({}));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:+1234567890',
        expect.any(String),
        'Alice',
        'signal',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+1234567890',
        expect.objectContaining({
          chat_jid: 'signal:+1234567890',
          sender: '+1234567890',
          sender_name: 'Alice',
          content: 'Hello',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered contacts', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      currentWs().simulateMessage(
        buildDmEnvelope({ source: '+9999999999', sourceName: 'Unknown' }),
      );

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:+9999999999',
        expect.any(String),
        'Unknown',
        'signal',
        false,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('uses sourceName as sender name', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      currentWs().simulateMessage(
        buildDmEnvelope({ sourceName: 'Bob Smith' }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+1234567890',
        expect.objectContaining({ sender_name: 'Bob Smith' }),
      );
    });

    it('falls back to source number when sourceName missing', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      const envelope = buildDmEnvelope({});
      delete envelope.envelope.sourceName;
      currentWs().simulateMessage(envelope);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+1234567890',
        expect.objectContaining({ sender_name: '+1234567890' }),
      );
    });

    it('converts envelope timestamp to ISO string', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      currentWs().simulateMessage(
        buildDmEnvelope({ timestamp: 1704067200000 }),
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+1234567890',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });

    it('ignores envelopes without dataMessage', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      currentWs().simulateMessage({
        envelope: {
          source: '+1234567890',
          timestamp: 1704067200000,
          // No dataMessage
        },
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('ignores envelopes with empty message', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      currentWs().simulateMessage({
        envelope: {
          source: '+1234567890',
          timestamp: 1704067200000,
          dataMessage: { message: '' },
        },
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores messages without source', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      currentWs().simulateMessage({
        envelope: {
          // No source or sourceNumber
          dataMessage: { message: 'No sender' },
        },
      });

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Group message handling ---

  describe('group message handling', () => {
    it('delivers group message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      currentWs().simulateMessage(buildGroupEnvelope({}));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:group.abc123==',
        expect.any(String),
        'signal:group.abc123==',
        'signal',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:group.abc123==',
        expect.objectContaining({
          chat_jid: 'signal:group.abc123==',
          sender: '+1234567890',
          sender_name: 'Alice',
          content: 'Hello group',
          is_from_me: false,
        }),
      );
    });

    it('marks group messages as isGroup=true in metadata', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      currentWs().simulateMessage(buildGroupEnvelope({}));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        'signal',
        true, // isGroup
      );
    });

    it('marks DM messages as isGroup=false in metadata', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      currentWs().simulateMessage(buildDmEnvelope({}));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        'signal',
        false, // not a group
      );
    });

    it('only emits metadata for unregistered groups', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      currentWs().simulateMessage(
        buildGroupEnvelope({ groupId: 'unknown_group_xyz==' }),
      );

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('POSTs to /v2/send for DM', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      await channel.sendMessage('signal:+1234567890', 'Hello');

      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8080/v2/send',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'Hello',
            number: '+19876543210',
            recipients: ['+1234567890'],
          }),
        }),
      );
    });

    it('strips signal: prefix from recipient', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      await channel.sendMessage('signal:+1234567890', 'Test');

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.recipients).toEqual(['+1234567890']);
    });

    it('sends group message with group. recipient', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      await channel.sendMessage('signal:group.abc123==', 'Group message');

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.recipients).toEqual(['group.abc123==']);
    });

    it('handles HTTP error response gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      await expect(
        channel.sendMessage('signal:+1234567890', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('handles fetch network failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      fetchMock.mockRejectedValueOnce(new Error('Network failure'));

      await expect(
        channel.sendMessage('signal:+1234567890', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when not connected', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      // Do NOT connect

      await channel.sendMessage('signal:+1234567890', 'No connection');

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns signal: JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        createTestOpts(),
      );
      expect(channel.ownsJid('signal:+1234567890')).toBe(true);
    });

    it('owns signal:group. JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        createTestOpts(),
      );
      expect(channel.ownsJid('signal:group.abc123==')).toBe(true);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        createTestOpts(),
      );
      expect(channel.ownsJid('tg:123456789')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        createTestOpts(),
      );
      expect(channel.ownsJid('1234567890@s.whatsapp.net')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        createTestOpts(),
      );
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('PUTs to typing indicator endpoint when isTyping=true', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      await channel.setTyping('signal:+1234567890', true);

      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/v1/typing-indicator/'),
        expect.objectContaining({
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipient: '+1234567890' }),
        }),
      );
    });

    it('does nothing when isTyping=false', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      await channel.setTyping('signal:+1234567890', false);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('handles typing indicator failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      fetchMock.mockRejectedValueOnce(new Error('Rate limited'));

      await expect(
        channel.setTyping('signal:+1234567890', true),
      ).resolves.toBeUndefined();
    });

    it('strips signal: prefix from recipient in typing indicator', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      await channel.setTyping('signal:+1234567890', true);

      const callBody = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(callBody.recipient).toBe('+1234567890');
    });
  });

  // --- Invalid JSON ---

  describe('malformed messages', () => {
    it('ignores invalid JSON gracefully', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        opts,
      );
      await connectChannel(channel);

      // Manually emit raw invalid data
      const ws = currentWs();
      for (const h of ws._listeners.get('message') ?? []) {
        h('not-json{{{');
      }

      expect(opts.onMessage).not.toHaveBeenCalled();
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "signal"', () => {
      const channel = new SignalChannel(
        'http://localhost:8080',
        '+19876543210',
        createTestOpts(),
      );
      expect(channel.name).toBe('signal');
    });
  });
});
