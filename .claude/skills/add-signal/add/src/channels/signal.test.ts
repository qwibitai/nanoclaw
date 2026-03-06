import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock dependencies before importing SignalChannel
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'TestBot',
}));

vi.mock('../db.js', () => ({
  getLatestMessage: vi.fn(),
  getMessageById: vi.fn(),
  storeReaction: vi.fn(),
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({
    SIGNAL_ACCOUNT_NUMBER: '+1234567890',
    SIGNAL_SOCKET_PATH: '',
  })),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock registry to capture the factory
const { capturedFactory } = vi.hoisted(() => {
  const ref: { current: ((opts: unknown) => unknown) | null } = { current: null };
  return { capturedFactory: ref };
});
vi.mock('./registry.js', () => ({
  registerChannel: vi.fn((_name: string, factory: (opts: unknown) => unknown) => {
    capturedFactory.current = factory;
  }),
  ChannelOpts: {},
}));

import { SignalChannel } from './signal.js';
import { getLatestMessage, getMessageById } from '../db.js';
import type { OnInboundMessage, OnChatMetadata } from '../types.js';

describe('SignalChannel', () => {
  let socketPath: string;
  let server: net.Server;
  let channel: SignalChannel;
  let onMessage: ReturnType<typeof vi.fn<OnInboundMessage>>;
  let onChatMetadata: ReturnType<typeof vi.fn<OnChatMetadata>>;

  beforeEach(async () => {
    socketPath = path.join(
      os.tmpdir(),
      `signal-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
    );

    onMessage = vi.fn<OnInboundMessage>();
    onChatMetadata = vi.fn<OnChatMetadata>();

    // Create a mock signal-cli server
    server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    channel = new SignalChannel(
      {
        onMessage,
        onChatMetadata,
        registeredGroups: () => ({
          'signal:+9876543210': {
            name: 'Test DM',
            folder: 'signal_test-dm',
            trigger: '@Bot',
            added_at: new Date().toISOString(),
          },
          'signal:group:testgroup123': {
            name: 'Test Group',
            folder: 'signal_test-group',
            trigger: '@Bot',
            added_at: new Date().toISOString(),
          },
        }),
      },
      '+1234567890',
      socketPath,
    );
  });

  afterEach(async () => {
    await channel.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // already cleaned up
    }
  });

  it('connects to signal-cli socket', async () => {
    // Accept connection and send a listGroups response
    server.on('connection', (sock) => {
      sock.on('error', () => {}); // ignore EPIPE during teardown
      sock.on('data', (data) => {
        const parsed = JSON.parse(data.toString().trim());
        if (parsed.method === 'listGroups') {
          sock.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsed.id,
              result: [],
            }) + '\n',
          );
        }
      });
    });

    await channel.connect();
    expect(channel.isConnected()).toBe(true);
  });

  it('owns signal: JIDs', () => {
    expect(channel.ownsJid('signal:+1234567890')).toBe(true);
    expect(channel.ownsJid('signal:group:abc123')).toBe(true);
    expect(channel.ownsJid('120363@g.us')).toBe(false);
    expect(channel.ownsJid('tg:-100123')).toBe(false);
  });

  it('sends DM messages', async () => {
    let sentMessage: unknown = null;

    server.on('connection', (sock) => {
      sock.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          if (parsed.method === 'listGroups') {
            sock.write(
              JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: [] }) +
                '\n',
            );
          } else if (parsed.method === 'send') {
            sentMessage = parsed.params;
            sock.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: parsed.id,
                result: { timestamp: Date.now() },
              }) + '\n',
            );
          }
        }
      });
    });

    await channel.connect();
    await channel.sendMessage('signal:+9876543210', 'Hello!');

    expect(sentMessage).toMatchObject({
      account: '+1234567890',
      recipient: ['+9876543210'],
      message: 'TestBot: Hello!',
    });
  });

  it('sends group messages', async () => {
    let sentMessage: unknown = null;

    server.on('connection', (sock) => {
      sock.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          if (parsed.method === 'listGroups') {
            sock.write(
              JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: [] }) +
                '\n',
            );
          } else if (parsed.method === 'send') {
            sentMessage = parsed.params;
            sock.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: parsed.id,
                result: { timestamp: Date.now() },
              }) + '\n',
            );
          }
        }
      });
    });

    await channel.connect();
    await channel.sendMessage(
      'signal:group:testgroup123',
      'Hello group!',
    );

    expect(sentMessage).toMatchObject({
      account: '+1234567890',
      groupId: 'testgroup123',
      message: 'TestBot: Hello group!',
    });
  });

  it('handles incoming DM notification', async () => {
    let clientSocket: net.Socket | null = null;

    server.on('connection', (sock) => {
      clientSocket = sock;
      sock.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          if (parsed.method === 'listGroups') {
            sock.write(
              JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: [] }) +
                '\n',
            );
          }
        }
      });
    });

    await channel.connect();

    // Wait for listGroups to complete
    await new Promise((r) => setTimeout(r, 50));

    // Send a notification
    clientSocket!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+9876543210',
            sourceName: 'Alice',
            dataMessage: {
              timestamp: 1700000000000,
              message: 'Hi there!',
            },
          },
        },
      }) + '\n',
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(onChatMetadata).toHaveBeenCalledWith(
      'signal:+9876543210',
      expect.any(String),
      undefined,
      'signal',
      false,
    );

    expect(onMessage).toHaveBeenCalledWith(
      'signal:+9876543210',
      expect.objectContaining({
        id: 'signal-1700000000000',
        chat_jid: 'signal:+9876543210',
        sender: '+9876543210',
        sender_name: 'Alice',
        content: 'Hi there!',
        is_from_me: false,
      }),
    );
  });

  it('handles incoming group notification with quote', async () => {
    let clientSocket: net.Socket | null = null;

    server.on('connection', (sock) => {
      clientSocket = sock;
      sock.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          if (parsed.method === 'listGroups') {
            sock.write(
              JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: [] }) +
                '\n',
            );
          }
        }
      });
    });

    await channel.connect();
    await new Promise((r) => setTimeout(r, 50));

    clientSocket!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+9876543210',
            sourceName: 'Alice',
            dataMessage: {
              timestamp: 1700000000000,
              message: 'Replying to you',
              groupInfo: { groupId: 'testgroup123' },
              quote: {
                id: 1699999999000,
                authorName: 'Bob',
                text: 'Original message',
              },
            },
          },
        },
      }) + '\n',
    );

    await new Promise((r) => setTimeout(r, 50));

    expect(onMessage).toHaveBeenCalledWith(
      'signal:group:testgroup123',
      expect.objectContaining({
        quoted_message_id: 'signal-1699999999000',
        quote_sender_name: 'Bob',
        quote_content: 'Original message',
      }),
    );
  });

  it('reacts to latest message', async () => {
    let reactionParams: unknown = null;

    vi.mocked(getLatestMessage).mockReturnValue({
      id: 'signal-1700000000000',
      sender: '+9876543210',
      sender_name: 'Alice',
      is_from_me: false,
    });

    server.on('connection', (sock) => {
      sock.on('data', (data) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          if (parsed.method === 'listGroups') {
            sock.write(
              JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: [] }) +
                '\n',
            );
          } else if (parsed.method === 'sendReaction') {
            reactionParams = parsed.params;
            sock.write(
              JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: {} }) +
                '\n',
            );
          }
        }
      });
    });

    await channel.connect();
    await channel.reactToLatestMessage('signal:+9876543210', '👍');

    expect(reactionParams).toMatchObject({
      account: '+1234567890',
      emoji: '👍',
      targetAuthor: '+9876543210',
      targetTimestamp: 1700000000000,
      recipient: ['+9876543210'],
    });
  });

  it('registers with channel registry', async () => {
    // Import triggers the registerChannel call
    await import('./signal.js');
    expect(capturedFactory.current).toBeTruthy();
  });
});
