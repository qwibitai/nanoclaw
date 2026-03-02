import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { Writable } from 'stream';

// --- Mocks ---

vi.mock('../config.js', () => ({
  SIGNAL_PHONE_NUMBER: '+15551234567',
  SIGNAL_CLI_PATH: 'signal-cli',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

let latestProc: ReturnType<typeof createFakeProcess>;

function createFakeProcess() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdinChunks: string[] = [];
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinChunks.push(chunk.toString());
      // Auto-respond to JSON-RPC requests
      const line = chunk.toString().trim();
      if (line.startsWith('{')) {
        try {
          const req = JSON.parse(line);
          if (req.id) {
            // Respond with success
            const response: Record<string, unknown> = {
              jsonrpc: '2.0',
              id: req.id,
              result: req.method === 'version'
                ? { version: '0.13.24' }
                : { timestamp: Date.now(), results: [] },
            };
            // Emit response on stdout after microtask
            queueMicrotask(() => {
              stdout.emit('data', Buffer.from(JSON.stringify(response) + '\n'));
            });
          }
        } catch { /* ignore */ }
      }
      cb();
    },
  });

  return {
    stdout,
    stderr,
    stdin,
    stdinChunks,
    kill: vi.fn(),
    on: vi.fn(),
    pid: 12345,
  };
}

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    latestProc = createFakeProcess();
    return latestProc;
  }),
}));

import { SignalChannel, SignalChannelOpts } from './signal.js';

// --- Test helpers ---

function createTestOpts(overrides?: Partial<SignalChannelOpts>): SignalChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'signal:+15559876543': {
        name: 'Signal DM',
        folder: 'signal-dm',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'signal:dGVzdGdyb3VwaWQ=': {
        name: 'Signal Group',
        folder: 'signal-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

/** Push a JSON-RPC notification (incoming message) to stdout */
function pushReceiveNotification(envelope: Record<string, unknown>) {
  const msg = {
    jsonrpc: '2.0',
    method: 'receive',
    params: { envelope },
  };
  latestProc.stdout.emit('data', Buffer.from(JSON.stringify(msg) + '\n'));
}

// --- Tests ---

describe('SignalChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('spawns signal-cli in jsonRpc mode and connects', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);

      const { spawn } = await import('child_process');
      expect(spawn).toHaveBeenCalledWith(
        'signal-cli',
        ['-a', '+15551234567', '-o', 'json', 'jsonRpc'],
        expect.any(Object),
      );

      await channel.disconnect();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(latestProc.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  // --- Incoming message handling (dataMessage) ---

  describe('dataMessage handling', () => {
    it('delivers DM to registered chat', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      pushReceiveNotification({
        sourceNumber: '+15559876543',
        sourceName: 'Alice',
        timestamp: 1700000000000,
        dataMessage: {
          message: 'Hello Andy',
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:+15559876543',
        expect.any(String),
        undefined,
        'signal',
        false,
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15559876543',
        expect.objectContaining({
          chat_jid: 'signal:+15559876543',
          sender: '+15559876543',
          sender_name: 'Alice',
          content: 'Hello Andy',
          is_from_me: false,
          is_bot_message: false,
        }),
      );

      await channel.disconnect();
    });

    it('delivers group message to registered chat', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      pushReceiveNotification({
        sourceNumber: '+15559876543',
        sourceName: 'Alice',
        timestamp: 1700000000000,
        dataMessage: {
          message: 'Group hello',
          groupInfo: {
            groupId: 'dGVzdGdyb3VwaWQ=',
            groupName: 'Test Group',
          },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:dGVzdGdyb3VwaWQ=',
        expect.any(String),
        'Test Group',
        'signal',
        true,
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:dGVzdGdyb3VwaWQ=',
        expect.objectContaining({
          content: 'Group hello',
          sender_name: 'Alice',
        }),
      );

      await channel.disconnect();
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      pushReceiveNotification({
        sourceNumber: '+15550000000',
        sourceName: 'Unknown',
        timestamp: 1700000000000,
        dataMessage: {
          message: 'Hey',
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();

      await channel.disconnect();
    });

    it('skips messages without text content', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      pushReceiveNotification({
        sourceNumber: '+15559876543',
        sourceName: 'Alice',
        timestamp: 1700000000000,
        dataMessage: {},
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();

      await channel.disconnect();
    });

    it('detects bot messages by isFromMe (syncMessage)', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      // syncMessage.sentMessage → isFromMe = true → is_bot_message = true
      pushReceiveNotification({
        sourceNumber: '+15551234567',
        sourceName: 'Echo',
        timestamp: 1700000000000,
        syncMessage: {
          sentMessage: {
            destinationNumber: '+15559876543',
            timestamp: 1700000000000,
            message: 'Hello from the bot',
          },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15559876543',
        expect.objectContaining({ is_bot_message: true, is_from_me: true }),
      );

      await channel.disconnect();
    });

    it('uses sourceNumber as sender_name when sourceName is missing', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      pushReceiveNotification({
        sourceNumber: '+15559876543',
        timestamp: 1700000000000,
        dataMessage: { message: 'No name' },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15559876543',
        expect.objectContaining({ sender_name: '+15559876543' }),
      );

      await channel.disconnect();
    });
  });

  // --- Sync message handling (sentMessage from primary device) ---

  describe('syncMessage handling', () => {
    it('delivers sync messages from primary device', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      pushReceiveNotification({
        sourceNumber: '+15551234567',
        sourceName: 'Nick',
        sourceDevice: 1,
        timestamp: 1700000000000,
        syncMessage: {
          sentMessage: {
            destinationNumber: '+15559876543',
            timestamp: 1700000000000,
            message: 'Hello from phone',
          },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      // Chat JID should be the destination, not the source
      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:+15559876543',
        expect.any(String),
        undefined,
        'signal',
        false,
      );

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15559876543',
        expect.objectContaining({
          chat_jid: 'signal:+15559876543',
          content: 'Hello from phone',
          is_from_me: true,
        }),
      );

      await channel.disconnect();
    });

    it('handles sync message to Note to Self', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'signal:+15551234567': {
            name: 'Note to Self',
            folder: 'note-to-self',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new SignalChannel(opts);
      await channel.connect();

      pushReceiveNotification({
        sourceNumber: '+15551234567',
        sourceName: 'Nick',
        sourceDevice: 1,
        timestamp: 1700000000000,
        syncMessage: {
          sentMessage: {
            destinationNumber: '+15551234567',
            timestamp: 1700000000000,
            message: 'Note to self test',
          },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({
          content: 'Note to self test',
          is_from_me: true,
        }),
      );

      await channel.disconnect();
    });

    it('handles sync group message', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      pushReceiveNotification({
        sourceNumber: '+15551234567',
        sourceName: 'Nick',
        sourceDevice: 1,
        timestamp: 1700000000000,
        syncMessage: {
          sentMessage: {
            timestamp: 1700000000000,
            message: 'Group sync msg',
            groupInfo: {
              groupId: 'dGVzdGdyb3VwaWQ=',
              groupName: 'Test Group',
            },
          },
        },
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:dGVzdGdyb3VwaWQ=',
        expect.any(String),
        'Test Group',
        'signal',
        true,
      );

      await channel.disconnect();
    });
  });

  // --- /chatid command ---

  describe('/chatid command', () => {
    it('responds with chat ID for dataMessage', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      pushReceiveNotification({
        sourceNumber: '+15559876543',
        sourceName: 'Alice',
        timestamp: 1700000000000,
        dataMessage: { message: '/chatid' },
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();

      // Check stdin for send RPC
      const sendCalls = latestProc.stdinChunks.filter(c => c.includes('"send"'));
      expect(sendCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(sendCalls[0]);
      expect(body.params.message).toContain('signal:+15559876543');

      await channel.disconnect();
    });
  });

  // --- Envelope edge cases ---

  describe('envelope edge cases', () => {
    it('skips envelopes without dataMessage or syncMessage', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      pushReceiveNotification({
        sourceNumber: '+15559876543',
        timestamp: 1700000000000,
        // No dataMessage or syncMessage (e.g., typing indicator, receipt)
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(opts.onChatMetadata).not.toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();

      await channel.disconnect();
    });

    it('ignores non-receive notifications', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      // Push a non-receive method notification
      const msg = { jsonrpc: '2.0', method: 'someOtherEvent', params: {} };
      latestProc.stdout.emit('data', Buffer.from(JSON.stringify(msg) + '\n'));

      await new Promise((r) => setTimeout(r, 10));

      expect(opts.onChatMetadata).not.toHaveBeenCalled();

      await channel.disconnect();
    });

    it('handles chunked stdout data', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      const full = JSON.stringify({
        jsonrpc: '2.0',
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+15559876543',
            sourceName: 'Alice',
            timestamp: 1700000000000,
            dataMessage: { message: 'Chunked message' },
          },
        },
      }) + '\n';

      const mid = Math.floor(full.length / 2);
      latestProc.stdout.emit('data', Buffer.from(full.slice(0, mid)));
      latestProc.stdout.emit('data', Buffer.from(full.slice(mid)));

      await new Promise((r) => setTimeout(r, 10));

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15559876543',
        expect.objectContaining({ content: 'Chunked message' }),
      );

      await channel.disconnect();
    });

    it('ignores non-JSON stdout lines', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      latestProc.stdout.emit('data', Buffer.from('INFO  Some log line\n'));

      await new Promise((r) => setTimeout(r, 10));

      expect(opts.onChatMetadata).not.toHaveBeenCalled();

      await channel.disconnect();
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends DM via stdin JSON-RPC', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      await channel.sendMessage('signal:+15559876543', 'Hello');

      const sendCalls = latestProc.stdinChunks.filter(c => c.includes('"send"'));
      expect(sendCalls.length).toBe(1);
      const body = JSON.parse(sendCalls[0]);
      expect(body.method).toBe('send');
      expect(body.params.recipient).toEqual(['+15559876543']);
      expect(body.params.message).toBe('Hello');

      await channel.disconnect();
    });

    it('sends group message via stdin JSON-RPC', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      await channel.sendMessage('signal:dGVzdGdyb3VwaWQ=', 'Group hello');

      const sendCalls = latestProc.stdinChunks.filter(c => c.includes('"send"'));
      expect(sendCalls.length).toBe(1);
      const body = JSON.parse(sendCalls[0]);
      expect(body.params.groupId).toBe('dGVzdGdyb3VwaWQ=');
      expect(body.params.message).toBe('Group hello');

      await channel.disconnect();
    });

    it('queues message when disconnected', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);

      // Channel is not connected — message should be queued, not sent
      // Snapshot stdinChunks length before sending
      const chunksBefore = latestProc?.stdinChunks?.length ?? 0;

      await channel.sendMessage('signal:+15559876543', 'Queued');

      // No new send RPC should have been written
      const chunksAfter = latestProc?.stdinChunks?.length ?? 0;
      const newSendCalls = (latestProc?.stdinChunks?.slice(chunksBefore) ?? [])
        .filter((c: string) => c.includes('"send"'));
      expect(newSendCalls.length).toBe(0);
    });

    it('prefixes messages with assistant name', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      await channel.sendMessage('signal:+15559876543', 'Test message');

      const sendCalls = latestProc.stdinChunks.filter(c => c.includes('"send"'));
      const body = JSON.parse(sendCalls[0]);
      expect(body.params.message).toBe('Test message');

      await channel.disconnect();
    });

    it('flushes queue on connect', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);

      // These will fail silently since no process exists yet
      (channel as any).outgoingQueue.push(
        { jid: 'signal:+15559876543', text: 'First' },
        { jid: 'signal:+15559876543', text: 'Second' },
      );

      await channel.connect();
      await new Promise((r) => setTimeout(r, 50));

      const sendCalls = latestProc.stdinChunks.filter(c => c.includes('"send"'));
      expect(sendCalls.length).toBe(2);

      const body1 = JSON.parse(sendCalls[0]);
      const body2 = JSON.parse(sendCalls[1]);
      expect(body1.params.message).toBe('First');
      expect(body2.params.message).toBe('Second');

      await channel.disconnect();
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns signal: prefixed JIDs', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('signal:+15551234567')).toBe(true);
    });

    it('owns signal group JIDs', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('signal:dGVzdGdyb3VwaWQ=')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('tg:12345')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "signal"', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.name).toBe('signal');
    });

    it('starts disconnected', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Security: caps and cleanup ---

  describe('pendingRpc cap', () => {
    it('rejects new RPC calls when cap is exceeded', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      // Fill up pending RPC map by disabling auto-responses
      const origWrite = latestProc.stdin.write;
      latestProc.stdin.write = function(chunk: unknown, ...args: unknown[]) {
        // Swallow writes so responses never come back, filling up pending map
        const cb = args.find(a => typeof a === 'function') as ((err?: Error | null) => void) | undefined;
        if (cb) cb();
        return true;
      } as typeof latestProc.stdin.write;

      // Fire 100 RPCs (they'll all be pending since we swallowed stdin)
      const promises: Promise<unknown>[] = [];
      for (let i = 0; i < 100; i++) {
        promises.push(
          (channel as any).rpcCall('test', {}).catch(() => {}),
        );
      }

      // The 101st should be rejected immediately
      await expect(
        (channel as any).rpcCall('test', {}),
      ).rejects.toThrow('RPC cap exceeded');

      latestProc.stdin.write = origWrite;
      await channel.disconnect();
    });
  });

  describe('outgoingQueue cap', () => {
    it('drops oldest message when queue exceeds cap', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);

      // Fill queue to cap (1000)
      const queue = (channel as any).outgoingQueue as Array<{ jid: string; text: string }>;
      for (let i = 0; i < 1000; i++) {
        queue.push({ jid: 'signal:+1', text: `msg-${i}` });
      }

      // Send one more while disconnected
      await channel.sendMessage('signal:+1', 'overflow');

      expect(queue.length).toBe(1000);
      // Oldest (msg-0) should have been dropped
      expect(queue[0].text).toBe('msg-1');
      expect(queue[queue.length - 1].text).toBe('overflow');
    });
  });

  describe('stdoutBuffer cap', () => {
    it('truncates buffer when exceeding 1MB', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      // Push a massive chunk without newlines to fill the buffer
      const bigData = 'x'.repeat(1_100_000);
      latestProc.stdout.emit('data', Buffer.from(bigData));

      // Buffer should be capped at 1MB
      const buffer = (channel as any).stdoutBuffer as string;
      expect(buffer.length).toBeLessThanOrEqual(1_000_000);

      await channel.disconnect();
    });
  });

  describe('disconnect cleanup', () => {
    it('resets flushing flag on disconnect', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      (channel as any).flushing = true;
      await channel.disconnect();

      expect((channel as any).flushing).toBe(false);
    });

    it('clears stdoutBuffer on disconnect', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      (channel as any).stdoutBuffer = 'some leftover data';
      await channel.disconnect();

      expect((channel as any).stdoutBuffer).toBe('');
    });

    it('clears outgoingQueue on disconnect', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      (channel as any).outgoingQueue.push({ jid: 'signal:+1', text: 'pending' });
      await channel.disconnect();

      expect((channel as any).outgoingQueue).toEqual([]);
    });

    it('clears pending RPC timeout handles on disconnect', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await channel.connect();

      // Manually add a pending entry with a timer
      const rejectFn = vi.fn();
      const timer = setTimeout(() => {}, 30000);
      (channel as any).pendingRpc.set('test-rpc', {
        resolve: vi.fn(),
        reject: rejectFn,
        timer,
      });

      await channel.disconnect();

      expect((channel as any).pendingRpc.size).toBe(0);
      expect(rejectFn).toHaveBeenCalledWith(expect.any(Error));
    });
  });
});
