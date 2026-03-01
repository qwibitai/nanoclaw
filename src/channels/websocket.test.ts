import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// --- Mocks ---

vi.mock('../config.js', () => ({}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- Fake WebSocket client ---

function createFakeClient() {
  const ee = new EventEmitter();
  return {
    readyState: 1, // WebSocket.OPEN = 1
    send: vi.fn(),
    terminate: vi.fn(),
    ping: vi.fn(),
    on: (e: string, h: (...args: unknown[]) => void) => ee.on(e, h),
    _emit: (e: string, ...args: unknown[]) => ee.emit(e, ...args),
  };
}

type FakeClient = ReturnType<typeof createFakeClient>;

let fakeClient: FakeClient;
let connectionHandler: ((ws: unknown) => void) | null = null;

// --- Mock 'ws' module ---

vi.mock('ws', () => {
  function WSS(this: unknown) {
    return {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'connection') connectionHandler = handler;
      },
      close: vi.fn((cb?: () => void) => cb?.()),
    };
  }
  const WS = { OPEN: 1 };
  return { WebSocketServer: vi.fn().mockImplementation(WSS), WebSocket: WS };
});

import { WebSocketChannel } from './websocket.js';

// --- Helper: simulate client connection ---

function simulateClientConnect(channel: WebSocketChannel): FakeClient {
  fakeClient = createFakeClient();
  connectionHandler?.(fakeClient);
  return fakeClient;
}

// --- Tests ---

describe('WebSocketChannel', () => {
  beforeEach(() => {
    connectionHandler = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Channel properties (CHAN-01, CHAN-03) ---

  describe('channel properties', () => {
    it('has name "websocket"', () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      expect(channel.name).toBe('websocket');
    });

    it('ownsJid returns true for ws: JIDs', () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      expect(channel.ownsJid('ws:better-work')).toBe(true);
    });

    it('ownsJid returns false for non-ws JIDs', () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      expect(channel.ownsJid('tg:123')).toBe(false);
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });
  });

  // --- Connect and state (CHAN-02, CHAN-04, CHAN-05) ---

  describe('connect and state', () => {
    it('connect() starts server on given port', async () => {
      const onMessage = vi.fn();
      const onChatMetadata = vi.fn();
      const channel = new WebSocketChannel(3001, { onMessage, onChatMetadata });
      await channel.connect();

      const { WebSocketServer } = await import('ws');
      expect(WebSocketServer).toHaveBeenCalledWith({ port: 3001 });
    });

    it('isConnected() returns false before client connects', async () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      await channel.connect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns true when client is connected', async () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      await channel.connect();
      simulateClientConnect(channel);
      expect(channel.isConnected()).toBe(true);
    });

    it('sends connected event with buffered_count on client connect', async () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      await channel.connect();
      const client = simulateClientConnect(channel);

      expect(client.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'system',
          event: 'connected',
          payload: { buffered_count: 0 },
        }),
      );
    });

    it('terminates existing client when new one connects (CHAN-05)', async () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      await channel.connect();
      const client1 = simulateClientConnect(channel);
      simulateClientConnect(channel);

      expect(client1.terminate).toHaveBeenCalled();
    });
  });

  // --- Inbound protocol (PROTO-01, PROTO-02) ---

  describe('inbound protocol', () => {
    it('chat message calls onMessage with content', async () => {
      const onMessage = vi.fn();
      const channel = new WebSocketChannel(3001, {
        onMessage,
        onChatMetadata: vi.fn(),
      });
      await channel.connect();
      const client = simulateClientConnect(channel);

      client._emit('message', Buffer.from(JSON.stringify({ type: 'chat', content: 'hola' })));

      expect(onMessage).toHaveBeenCalledWith(
        'ws:better-work',
        expect.objectContaining({ content: 'hola' }),
      );
    });

    it('system message calls onMessage with [SYSTEM] prefix', async () => {
      const onMessage = vi.fn();
      const channel = new WebSocketChannel(3001, {
        onMessage,
        onChatMetadata: vi.fn(),
      });
      await channel.connect();
      const client = simulateClientConnect(channel);

      client._emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'system', action: 'ping', payload: { x: 1 } })),
      );

      expect(onMessage).toHaveBeenCalledWith(
        'ws:better-work',
        expect.objectContaining({ content: '[SYSTEM] ping: {"x":1}' }),
      );
    });

    it('invalid JSON sends PARSE_ERROR to client', async () => {
      const onMessage = vi.fn();
      const channel = new WebSocketChannel(3001, {
        onMessage,
        onChatMetadata: vi.fn(),
      });
      await channel.connect();
      const client = simulateClientConnect(channel);

      client._emit('message', Buffer.from('not valid json'));

      // The connected event is the first send call; error is the next
      const calls = client.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
      const errorCall = calls.find((c: { type: string }) => c.type === 'error');
      expect(errorCall).toMatchObject({ type: 'error', code: 'PARSE_ERROR' });
      expect(onMessage).not.toHaveBeenCalled();
    });

    it('unknown type is ignored silently', async () => {
      const onMessage = vi.fn();
      const channel = new WebSocketChannel(3001, {
        onMessage,
        onChatMetadata: vi.fn(),
      });
      await channel.connect();
      const client = simulateClientConnect(channel);

      client._emit('message', Buffer.from(JSON.stringify({ type: 'unknown', data: 'x' })));

      // Only onChatMetadata call happened (from connect), onMessage not called
      expect(onMessage).not.toHaveBeenCalled();
    });
  });

  // --- sendMessage and buffer (PROTO-03, PROTO-05) ---

  describe('sendMessage and buffer', () => {
    it('sends message directly when client is connected', async () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      await channel.connect();
      const client = simulateClientConnect(channel);
      client.send.mockClear();

      await channel.sendMessage('ws:better-work', 'hello');

      expect(client.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'chat', content: 'hello' }),
      );
    });

    it('buffers message silently when no client connected', async () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      await channel.connect();

      await expect(channel.sendMessage('ws:better-work', 'buffered')).resolves.toBeUndefined();
    });

    it('drops oldest message when buffer exceeds 50', async () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      await channel.connect();

      // Fill buffer with 50 messages
      for (let i = 0; i < 50; i++) {
        await channel.sendMessage('ws:better-work', `msg-${i}`);
      }

      // Add 51st — should drop oldest
      await channel.sendMessage('ws:better-work', 'msg-50');

      // On reconnect, check buffer length is still 50 and first message is msg-1 (not msg-0)
      const client = simulateClientConnect(channel);
      const calls = client.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
      const chatCalls = calls.filter((c: { type: string }) => c.type === 'chat');

      expect(chatCalls).toHaveLength(50);
      expect(chatCalls[0].content).toBe('msg-1'); // msg-0 was dropped
      expect(chatCalls[49].content).toBe('msg-50');
    });

    it('delivers buffered messages with buffered_start/buffered_end on reconnect', async () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      await channel.connect();

      await channel.sendMessage('ws:better-work', 'while-disconnected');
      const client = simulateClientConnect(channel);

      const calls = client.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
      const systemCalls = calls.filter((c: { type: string }) => c.type === 'system');

      const bufferedStart = systemCalls.find(
        (c: { event?: string }) => c.event === 'buffered_start',
      );
      const bufferedEnd = systemCalls.find(
        (c: { event?: string }) => c.event === 'buffered_end',
      );

      expect(bufferedStart).toBeDefined();
      expect(bufferedStart.count).toBe(1);
      expect(bufferedEnd).toBeDefined();
    });

    it('buffered messages carry original timestamps', async () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      await channel.connect();

      const before = new Date().toISOString();
      await channel.sendMessage('ws:better-work', 'timestamped');
      const after = new Date().toISOString();

      const client = simulateClientConnect(channel);
      const calls = client.send.mock.calls.map((c: unknown[]) => JSON.parse(c[0] as string));
      const chatMsg = calls.find(
        (c: { type: string; timestamp?: string }) =>
          c.type === 'chat' && c.timestamp !== undefined,
      );

      expect(chatMsg).toBeDefined();
      expect(chatMsg.timestamp >= before).toBe(true);
      expect(chatMsg.timestamp <= after).toBe(true);
    });
  });

  // --- setTyping (PROTO-04) ---

  describe('setTyping', () => {
    it('sends typing:true to client', async () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      await channel.connect();
      const client = simulateClientConnect(channel);
      client.send.mockClear();

      await channel.setTyping('ws:better-work', true);

      expect(client.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'system',
          event: 'typing',
          payload: { isTyping: true },
        }),
      );
    });

    it('sends typing:false to client', async () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      await channel.connect();
      const client = simulateClientConnect(channel);
      client.send.mockClear();

      await channel.setTyping('ws:better-work', false);

      expect(client.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'system',
          event: 'typing',
          payload: { isTyping: false },
        }),
      );
    });

    it('does not throw when no client connected', async () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      await channel.connect();

      await expect(channel.setTyping('ws:better-work', true)).resolves.toBeUndefined();
    });
  });

  // --- onChatMetadata (critical pitfall) ---

  describe('onChatMetadata', () => {
    it('calls onChatMetadata immediately in connect()', async () => {
      const onChatMetadata = vi.fn();
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata,
      });
      await channel.connect();

      expect(onChatMetadata).toHaveBeenCalledWith(
        'ws:better-work',
        expect.any(String),
        'better-work',
        'websocket',
        false,
      );
    });
  });

  // --- disconnect (CHAN-06) ---

  describe('disconnect', () => {
    it('closes the server on disconnect()', async () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      await channel.connect();

      const { WebSocketServer } = await import('ws');
      const wssInstance = vi.mocked(WebSocketServer).mock.results[0].value;

      await channel.disconnect();

      expect(wssInstance.close).toHaveBeenCalled();
    });

    it('isConnected() returns false after disconnect', async () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      await channel.connect();
      simulateClientConnect(channel);
      await channel.disconnect();

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Client disconnect ---

  describe('client disconnect', () => {
    it('notifies agent with [SYSTEM] client_disconnected on client close', async () => {
      const onMessage = vi.fn();
      const channel = new WebSocketChannel(3001, {
        onMessage,
        onChatMetadata: vi.fn(),
      });
      await channel.connect();
      const client = simulateClientConnect(channel);
      onMessage.mockClear();

      client._emit('close');

      expect(onMessage).toHaveBeenCalledWith(
        'ws:better-work',
        expect.objectContaining({
          content: expect.stringContaining('[SYSTEM] client_disconnected'),
        }),
      );
    });

    it('isConnected() returns false after client close', async () => {
      const channel = new WebSocketChannel(3001, {
        onMessage: vi.fn(),
        onChatMetadata: vi.fn(),
      });
      await channel.connect();
      const client = simulateClientConnect(channel);

      client._emit('close');

      expect(channel.isConnected()).toBe(false);
    });
  });
});
