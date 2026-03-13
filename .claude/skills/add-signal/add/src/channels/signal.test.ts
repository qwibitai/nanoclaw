/**
 * Unit tests for SignalChannel.
 *
 * Tests the channel logic — JID parsing, envelope routing, JSON-RPC framing —
 * without requiring a live signal-cli daemon. The socket is mocked via a
 * mock net.Socket.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import * as net from 'net';

// ---------------------------------------------------------------------------
// Mock net.createConnection before importing SignalChannel
// ---------------------------------------------------------------------------

vi.mock('net', () => {
  const mockSocket = {
    once: vi.fn(),
    on: vi.fn(),
    write: vi.fn((data: string, encoding: string, cb?: (err?: Error) => void) => {
      if (cb) cb();
      return true;
    }),
    destroy: vi.fn(),
    _handlers: {} as Record<string, ((...args: unknown[]) => void)[]>,
    _emit(event: string, ...args: unknown[]) {
      for (const fn of this._handlers[event] ?? []) fn(...args);
    },
  };

  // Store handlers registered via .once() and .on()
  mockSocket.once.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    mockSocket._handlers[event] = mockSocket._handlers[event] ?? [];
    mockSocket._handlers[event].push(handler);
    // Auto-fire 'connect' so connect() resolves
    if (event === 'connect') setTimeout(() => mockSocket._emit('connect'), 0);
  });
  mockSocket.on.mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
    mockSocket._handlers[event] = mockSocket._handlers[event] ?? [];
    mockSocket._handlers[event].push(handler);
  });

  return {
    createConnection: vi.fn(() => mockSocket),
    Socket: vi.fn(),
    _mockSocket: mockSocket,
  };
});

// Mock config
vi.mock('../config.js', () => ({
  SIGNAL_PHONE_NUMBER: '+15551234567',
  SIGNAL_SOCKET_PATH: '/tmp/test-signal.sock',
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock registry (capture the registered factory)
let capturedFactory: ((opts: unknown) => unknown) | null = null;
vi.mock('./registry.js', () => ({
  registerChannel: vi.fn((name: string, factory: (opts: unknown) => unknown) => {
    capturedFactory = factory;
  }),
}));

import { SignalChannel } from './signal.js';
import type { ChannelOpts } from './registry.js';

// ---------------------------------------------------------------------------
// Helper: get the mock socket
// ---------------------------------------------------------------------------

function getMockSocket() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (net as any)._mockSocket;
}

function makeOpts(): ChannelOpts & { messages: unknown[]; metadata: unknown[] } {
  const messages: unknown[] = [];
  const metadata: unknown[] = [];
  return {
    onMessage: vi.fn((...args) => messages.push(args)),
    onChatMetadata: vi.fn((...args) => metadata.push(args)),
    registeredGroups: vi.fn(() => ({})),
    messages,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SignalChannel', () => {
  let channel: SignalChannel;
  let opts: ReturnType<typeof makeOpts>;

  beforeEach(() => {
    getMockSocket()._handlers = {};
    opts = makeOpts();
    channel = new SignalChannel(opts as unknown as ChannelOpts);
  });

  afterEach(async () => {
    await channel.disconnect();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------

  it('name is "signal"', () => {
    expect(channel.name).toBe('signal');
  });

  it('ownsJid returns true for signal: JIDs', () => {
    expect(channel.ownsJid('signal:550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(channel.ownsJid('signal:group:abc123==')).toBe(true);
    expect(channel.ownsJid('whatsapp:+15551234567')).toBe(false);
    expect(channel.ownsJid('telegram:123456')).toBe(false);
  });

  it('connects to the socket and subscribes', async () => {
    await channel.connect();

    expect(net.createConnection).toHaveBeenCalledWith('/tmp/test-signal.sock');
    expect(channel.isConnected()).toBe(true);

    // Should have sent a subscribeReceive RPC
    const sock = getMockSocket();
    const writeCalls = (sock.write as Mock).mock.calls;
    const subscribeLine = writeCalls.find(([line]: [string]) =>
      line.includes('subscribeReceive'),
    );
    expect(subscribeLine).toBeTruthy();
    const parsed = JSON.parse(subscribeLine[0]);
    expect(parsed.method).toBe('subscribeReceive');
    expect(parsed.params.account).toBe('+15551234567');
  });

  it('routes inbound direct message to onMessage', async () => {
    await channel.connect();
    const sock = getMockSocket();

    const notification = {
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          sourceUuid: '550e8400-e29b-41d4-a716-446655440000',
          sourceNumber: '+15559876543',
          sourceName: 'Alice',
          timestamp: 1741827600000,
          dataMessage: {
            message: 'Hello NanoClaw!',
            attachments: [],
          },
        },
      },
    };

    sock._emit('data', Buffer.from(JSON.stringify(notification) + '\n'));

    expect(opts.onMessage).toHaveBeenCalledOnce();
    const [jid, msg] = (opts.onMessage as Mock).mock.calls[0];
    expect(jid).toBe('signal:550e8400-e29b-41d4-a716-446655440000');
    expect(msg.body).toBe('Hello NanoClaw!');
  });

  it('routes inbound group message with group JID', async () => {
    await channel.connect();
    const sock = getMockSocket();

    const notification = {
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          sourceUuid: '550e8400-e29b-41d4-a716-446655440000',
          sourceName: 'Bob',
          timestamp: 1741827700000,
          dataMessage: {
            message: 'Group message',
            groupInfo: { groupId: 'groupBase64Id==' },
            attachments: [],
          },
        },
      },
    };

    sock._emit('data', Buffer.from(JSON.stringify(notification) + '\n'));

    expect(opts.onMessage).toHaveBeenCalledOnce();
    const [jid] = (opts.onMessage as Mock).mock.calls[0];
    expect(jid).toBe('signal:group:groupBase64Id==');
  });

  it('ignores envelopes without a text message (typing, receipts)', async () => {
    await channel.connect();
    const sock = getMockSocket();

    const typingNotif = {
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          sourceUuid: 'some-uuid',
          timestamp: Date.now(),
          typingMessage: { action: 'STARTED' },
        },
      },
    };

    sock._emit('data', Buffer.from(JSON.stringify(typingNotif) + '\n'));
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('handles chunked/split socket data correctly', async () => {
    await channel.connect();
    const sock = getMockSocket();

    const notification = {
      jsonrpc: '2.0',
      method: 'receive',
      params: {
        envelope: {
          sourceUuid: 'test-uuid-1234',
          sourceNumber: '+15551111111',
          sourceName: 'Charlie',
          timestamp: 1741827800000,
          dataMessage: { message: 'Split message', attachments: [] },
        },
      },
    };

    const full = JSON.stringify(notification) + '\n';
    const half = Math.floor(full.length / 2);

    // Send in two chunks
    sock._emit('data', Buffer.from(full.slice(0, half)));
    expect(opts.onMessage).not.toHaveBeenCalled();
    sock._emit('data', Buffer.from(full.slice(half)));
    expect(opts.onMessage).toHaveBeenCalledOnce();
  });

  it('sends a direct message via JSON-RPC', async () => {
    await channel.connect();
    const sock = getMockSocket();

    // Pre-stage a response for the send RPC
    sock.write.mockImplementationOnce(
      (line: string, _enc: string, cb?: (err?: Error) => void) => {
        if (cb) cb();
        const req = JSON.parse(line);
        setTimeout(() => {
          const response = JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: { results: [] },
          });
          sock._emit('data', Buffer.from(response + '\n'));
        }, 0);
        return true;
      },
    );

    await channel.sendMessage('signal:550e8400-e29b-41d4-a716-446655440000', 'Hi there');

    const writeCalls = (sock.write as Mock).mock.calls;
    const sendCall = writeCalls.find(([line]: [string]) => {
      try {
        return JSON.parse(line).method === 'send';
      } catch {
        return false;
      }
    });
    expect(sendCall).toBeTruthy();
    const parsed = JSON.parse(sendCall[0]);
    expect(parsed.params.message).toBe('Hi there');
    expect(parsed.params.recipient).toContain('550e8400-e29b-41d4-a716-446655440000');
  });

  it('sends a group message with groupId instead of recipient', async () => {
    await channel.connect();
    const sock = getMockSocket();

    sock.write.mockImplementationOnce(
      (line: string, _enc: string, cb?: (err?: Error) => void) => {
        if (cb) cb();
        const req = JSON.parse(line);
        setTimeout(() => {
          sock._emit(
            'data',
            Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\n'),
          );
        }, 0);
        return true;
      },
    );

    await channel.sendMessage('signal:group:myGroupId==', 'Hello group!');

    const writeCalls = (sock.write as Mock).mock.calls;
    const sendCall = writeCalls.find(([line]: [string]) => {
      try {
        return JSON.parse(line).method === 'send';
      } catch {
        return false;
      }
    });
    const parsed = JSON.parse(sendCall[0]);
    expect(parsed.params.groupId).toBe('myGroupId==');
    expect(parsed.params.recipient).toBeUndefined();
  });

  it('disconnects cleanly', async () => {
    await channel.connect();
    expect(channel.isConnected()).toBe(true);
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
    expect(getMockSocket().destroy).toHaveBeenCalled();
  });

  it('self-registers when env vars are set', () => {
    expect(capturedFactory).not.toBeNull();
    const instance = capturedFactory!(opts);
    expect(instance).toBeInstanceOf(SignalChannel);
  });

  it('self-registration returns null when SIGNAL_PHONE_NUMBER is missing', async () => {
    vi.resetModules();
    vi.doMock('../config.js', () => ({
      SIGNAL_PHONE_NUMBER: '',
      SIGNAL_SOCKET_PATH: '/tmp/test.sock',
    }));

    let nullFactory: ((opts: unknown) => unknown) | null = null;
    vi.doMock('./registry.js', () => ({
      registerChannel: vi.fn((name: string, factory: (opts: unknown) => unknown) => {
        nullFactory = factory;
      }),
    }));

    await import('./signal.js?unconfigured');
    if (nullFactory) {
      const result = (nullFactory as (opts: unknown) => unknown)(opts);
      expect(result).toBeNull();
    }
  });
});
