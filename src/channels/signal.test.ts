import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// --- Mocks ---

vi.mock('../config.js', () => ({
  SIGNAL_PHONE_NUMBER: '+1555000000',
  SIGNAL_CLI_TCP_HOST: '127.0.0.1',
  SIGNAL_CLI_TCP_PORT: 7583,
  ASSISTANT_NAME: 'Andy',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Build a fake net.Socket that's an EventEmitter with controllable methods
function createFakeSocket() {
  const emitter = new EventEmitter();
  const writes: string[] = [];
  return {
    connect: vi.fn(),
    write: vi.fn((data: string) => {
      writes.push(data);
      return true;
    }),
    destroy: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      emitter.on(event, handler);
    },
    _emitter: emitter,
    _writes: writes,
  };
}

type FakeSocket = ReturnType<typeof createFakeSocket>;

// Module-scope variable: the MockSocket constructor returns whatever fakeSocket points to.
// Updated in beforeEach — safe because the constructor body runs per `new net.Socket()` call,
// which always happens inside a test (after beforeEach has set the value).
let fakeSocket: FakeSocket;

// Mock net using a regular function (not arrow) so it's a valid constructor.
vi.mock('net', () => ({
  default: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Socket: function MockSocket(this: any) {
      return fakeSocket;
    },
  },
}));

import { SignalChannel, SignalChannelOpts } from './signal.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<SignalChannelOpts>): SignalChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'signal:group.dGVzdA==': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'signal:+1555111111': {
        name: 'DM Chat',
        folder: 'dm-chat',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

async function connectChannel(channel: SignalChannel): Promise<void> {
  const p = channel.connect();
  await new Promise((r) => setTimeout(r, 0));
  fakeSocket._emitter.emit('connect');
  await new Promise((r) => setTimeout(r, 0));
  return p;
}

function sendRawData(data: unknown) {
  fakeSocket._emitter.emit('data', Buffer.from(JSON.stringify(data) + '\n'));
}

function sendReceiveEvent(envelope: unknown) {
  sendRawData({
    jsonrpc: '2.0',
    method: 'receive',
    params: { account: '+1555000000', envelope },
  });
}

// --- Tests ---

describe('SignalChannel', () => {
  beforeEach(() => {
    fakeSocket = createFakeSocket();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- JID ownership ---

  describe('ownsJid', () => {
    it('owns individual signal JIDs', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('signal:+1555111111')).toBe(true);
    });

    it('owns group signal JIDs', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('signal:group.dGVzdA==')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('tg:12345')).toBe(false);
    });

    it('does not own arbitrary strings', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when socket connects', async () => {
      const channel = new SignalChannel(createTestOpts());
      await connectChannel(channel);
      expect(channel.isConnected()).toBe(true);
    });

    it('sends subscribeReceive on connect', async () => {
      const channel = new SignalChannel(createTestOpts());
      await connectChannel(channel);

      const written = fakeSocket._writes[0];
      const parsed = JSON.parse(written);
      expect(parsed.method).toBe('subscribeReceive');
      expect(parsed.params.account).toBe('+1555000000');
    });

    it('isConnected() returns false before connect', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.isConnected()).toBe(false);
    });

    it('disconnects cleanly', async () => {
      const channel = new SignalChannel(createTestOpts());
      await connectChannel(channel);
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(fakeSocket.destroy).toHaveBeenCalled();
    });

    it('has name "signal"', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.name).toBe('signal');
    });
  });

  // --- Reconnection ---

  describe('reconnection', () => {
    it('schedules reconnect on socket close', async () => {
      vi.useFakeTimers();
      const channel = new SignalChannel(createTestOpts());

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeSocket._emitter.emit('connect');
      await vi.advanceTimersByTimeAsync(0);
      await p;

      const socket1 = fakeSocket;
      expect(channel.isConnected()).toBe(true);

      // Simulate socket close
      socket1._emitter.emit('close');
      expect(channel.isConnected()).toBe(false);

      // Point fakeSocket to new instance BEFORE the reconnect timer fires
      const socket2 = createFakeSocket();
      fakeSocket = socket2;

      await vi.advanceTimersByTimeAsync(5000);

      expect(socket2.connect).toHaveBeenCalled();

      vi.useRealTimers();
    });

    it('does not double-schedule reconnect', async () => {
      vi.useFakeTimers();
      const channel = new SignalChannel(createTestOpts());

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeSocket._emitter.emit('connect');
      await vi.advanceTimersByTimeAsync(0);
      await p;

      const socket1 = fakeSocket;

      // Emit close twice
      socket1._emitter.emit('close');
      socket1._emitter.emit('close');

      const socket2 = createFakeSocket();
      fakeSocket = socket2;

      await vi.advanceTimersByTimeAsync(5000);

      // Should only connect once
      expect(socket2.connect).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('cancels reconnect timer on disconnect', async () => {
      vi.useFakeTimers();
      const channel = new SignalChannel(createTestOpts());

      const p = channel.connect();
      await vi.advanceTimersByTimeAsync(0);
      fakeSocket._emitter.emit('connect');
      await vi.advanceTimersByTimeAsync(0);
      await p;

      const socket1 = fakeSocket;
      socket1._emitter.emit('close');

      // Disconnect before reconnect fires
      await channel.disconnect();

      const socket2 = createFakeSocket();
      fakeSocket = socket2;

      await vi.advanceTimersByTimeAsync(5000);

      // No reconnect should have happened
      expect(socket2.connect).not.toHaveBeenCalled();

      vi.useRealTimers();
    });
  });

  // --- Incoming message handling ---

  describe('incoming message handling', () => {
    it('delivers group message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await connectChannel(channel);

      sendReceiveEvent({
        sourceNumber: '+1555111222',
        sourceName: 'Alice',
        timestamp: 1700000000000,
        dataMessage: {
          message: '@Andy hello',
          timestamp: 1700000000000,
          groupInfo: { groupId: 'dGVzdA==', type: 'DELIVER' },
        },
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:group.dGVzdA==',
        expect.any(String),
        undefined,
        'signal',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:group.dGVzdA==',
        expect.objectContaining({
          chat_jid: 'signal:group.dGVzdA==',
          sender: '+1555111222',
          sender_name: 'Alice',
          content: '@Andy hello',
          is_from_me: false,
          is_bot_message: false,
        }),
      );
    });

    it('delivers individual message for registered DM', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await connectChannel(channel);

      sendReceiveEvent({
        sourceNumber: '+1555111111',
        sourceName: 'Bob',
        timestamp: 1700000001000,
        dataMessage: {
          message: '@Andy hi',
          timestamp: 1700000001000,
        },
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:+1555111111',
        expect.any(String),
        undefined,
        'signal',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+1555111111',
        expect.objectContaining({
          chat_jid: 'signal:+1555111111',
          sender: '+1555111111',
          content: '@Andy hi',
        }),
      );
    });

    it('only emits metadata for unregistered groups', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await connectChannel(channel);

      sendReceiveEvent({
        sourceNumber: '+1555999999',
        sourceName: 'Eve',
        timestamp: 1700000002000,
        dataMessage: {
          message: 'hello',
          timestamp: 1700000002000,
          groupInfo: { groupId: 'dW5yZWc=', type: 'DELIVER' },
        },
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:group.dW5yZWc=',
        expect.any(String),
        undefined,
        'signal',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('includes group name when available in groupContext', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await connectChannel(channel);

      sendReceiveEvent({
        sourceNumber: '+1555111222',
        sourceName: 'Alice',
        timestamp: 1700000003000,
        dataMessage: {
          message: '@Andy hey',
          timestamp: 1700000003000,
          groupInfo: { groupId: 'dGVzdA==', type: 'DELIVER' },
          groupContext: { title: 'My Signal Group', groupId: 'dGVzdA==' },
        },
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:group.dGVzdA==',
        expect.any(String),
        'My Signal Group',
        'signal',
        true,
      );
    });

    it('ignores messages with no dataMessage text', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await connectChannel(channel);

      sendReceiveEvent({
        sourceNumber: '+1555111222',
        timestamp: 1700000004000,
        dataMessage: { timestamp: 1700000004000 },
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores receive events with no envelope', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await connectChannel(channel);

      sendRawData({ jsonrpc: '2.0', method: 'receive', params: {} });

      await new Promise((r) => setTimeout(r, 0));

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('marks message from own number as is_from_me', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await connectChannel(channel);

      sendReceiveEvent({
        sourceNumber: '+1555000000', // own number
        sourceName: 'Me',
        timestamp: 1700000005000,
        dataMessage: {
          message: 'I said something',
          timestamp: 1700000005000,
          groupInfo: { groupId: 'dGVzdA==', type: 'DELIVER' },
        },
      });

      await new Promise((r) => setTimeout(r, 0));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:group.dGVzdA==',
        expect.objectContaining({ is_from_me: true, is_bot_message: true }),
      );
    });
  });

  // --- Outgoing message queue ---

  describe('outgoing message queue', () => {
    it('sends individual message directly when connected', async () => {
      const channel = new SignalChannel(createTestOpts());
      await connectChannel(channel);

      fakeSocket._writes.length = 0; // clear subscribeReceive write

      await channel.sendMessage('signal:+1555111111', 'Hello there');

      const sendWrite = fakeSocket._writes.find((w) => {
        const p = JSON.parse(w);
        return p.method === 'send';
      });
      expect(sendWrite).toBeDefined();
      const parsed = JSON.parse(sendWrite!);
      expect(parsed.params.recipient).toEqual(['+1555111111']);
      expect(parsed.params.message).toBe('Hello there');
    });

    it('sends group message directly when connected', async () => {
      const channel = new SignalChannel(createTestOpts());
      await connectChannel(channel);

      fakeSocket._writes.length = 0;

      await channel.sendMessage('signal:group.dGVzdA==', 'Group reply');

      const sendWrite = fakeSocket._writes.find((w) => {
        const p = JSON.parse(w);
        return p.method === 'send';
      });
      expect(sendWrite).toBeDefined();
      const parsed = JSON.parse(sendWrite!);
      expect(parsed.params.groupId).toBe('dGVzdA==');
      expect(parsed.params.message).toBe('Group reply');
    });

    it('queues message when disconnected', async () => {
      const channel = new SignalChannel(createTestOpts());

      // Don't connect
      await channel.sendMessage('signal:+1555111111', 'Queued');

      expect(fakeSocket.write).not.toHaveBeenCalled();
    });

    it('flushes queued messages on connect', async () => {
      const channel = new SignalChannel(createTestOpts());

      // Queue messages while disconnected
      await channel.sendMessage('signal:+1555111111', 'First');
      await channel.sendMessage('signal:+1555111111', 'Second');

      // Now connect
      await connectChannel(channel);
      await new Promise((r) => setTimeout(r, 10));

      const sendWrites = fakeSocket._writes
        .map((w) => JSON.parse(w))
        .filter((p) => p.method === 'send');

      expect(sendWrites).toHaveLength(2);
      expect(sendWrites[0].params.message).toBe('First');
      expect(sendWrites[1].params.message).toBe('Second');
    });

    it('logs warning for invalid JID and sends nothing', async () => {
      const { logger } = await import('../logger.js');
      const channel = new SignalChannel(createTestOpts());
      await connectChannel(channel);

      fakeSocket._writes.length = 0;

      await channel.sendMessage('invalid-jid', 'Test');

      expect(logger.warn).toHaveBeenCalled();
      const sendWrites = fakeSocket._writes.filter((w) => {
        const p = JSON.parse(w);
        return p.method === 'send';
      });
      expect(sendWrites).toHaveLength(0);
    });
  });

  // --- setTyping (no-op) ---

  describe('setTyping', () => {
    it('resolves without sending anything (no-op)', async () => {
      const channel = new SignalChannel(createTestOpts());
      await connectChannel(channel);
      fakeSocket._writes.length = 0;

      await expect(channel.setTyping('signal:+1555111111', true)).resolves.toBeUndefined();
      expect(fakeSocket._writes).toHaveLength(0);
    });
  });

  // --- Multi-line framing ---

  describe('newline-delimited framing', () => {
    it('handles multiple JSON objects in one chunk', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await connectChannel(channel);

      const msg1 = JSON.stringify({
        jsonrpc: '2.0',
        method: 'receive',
        params: {
          account: '+1555000000',
          envelope: {
            sourceNumber: '+1555111111',
            sourceName: 'Alice',
            timestamp: 1700000010000,
            dataMessage: { message: 'First', timestamp: 1700000010000 },
          },
        },
      });
      const msg2 = JSON.stringify({
        jsonrpc: '2.0',
        method: 'receive',
        params: {
          account: '+1555000000',
          envelope: {
            sourceNumber: '+1555111111',
            sourceName: 'Alice',
            timestamp: 1700000011000,
            dataMessage: { message: 'Second', timestamp: 1700000011000 },
          },
        },
      });

      fakeSocket._emitter.emit('data', Buffer.from(msg1 + '\n' + msg2 + '\n'));
      await new Promise((r) => setTimeout(r, 0));

      expect(opts.onMessage).toHaveBeenCalledTimes(2);
    });

    it('handles JSON split across multiple chunks', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await connectChannel(channel);

      const fullMsg =
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'receive',
          params: {
            account: '+1555000000',
            envelope: {
              sourceNumber: '+1555111111',
              sourceName: 'Alice',
              timestamp: 1700000020000,
              dataMessage: { message: 'Split', timestamp: 1700000020000 },
            },
          },
        }) + '\n';

      const half = Math.floor(fullMsg.length / 2);
      fakeSocket._emitter.emit('data', Buffer.from(fullMsg.slice(0, half)));
      fakeSocket._emitter.emit('data', Buffer.from(fullMsg.slice(half)));
      await new Promise((r) => setTimeout(r, 0));

      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+1555111111',
        expect.objectContaining({ content: 'Split' }),
      );
    });
  });
});
