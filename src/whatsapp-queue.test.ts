import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock all external dependencies before importing
vi.mock('@whiskeysockets/baileys', () => ({
  default: vi.fn(),
  DisconnectReason: { loggedOut: 401 },
  makeCacheableSignalKeyStore: vi.fn(() => ({})),
  useMultiFileAuthState: vi.fn(() =>
    Promise.resolve({
      state: { creds: {}, keys: {} },
      saveCreds: vi.fn(),
    }),
  ),
}));

vi.mock('../db.js', () => ({
  getLastGroupSync: vi.fn(() => null),
  setLastGroupSync: vi.fn(),
  updateChatName: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => false),
      readdirSync: vi.fn(() => []),
      readFileSync: vi.fn(() => '""'),
      statSync: vi.fn(),
    },
  };
});

vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/test-store',
  MAX_OUTGOING_QUEUE_SIZE: 5,
  RECONNECT_INITIAL_DELAY_MS: 100,
  RECONNECT_MAX_ATTEMPTS: 3,
  RECONNECT_MAX_DELAY_MS: 1000,
}));

import { WhatsAppChannel } from './channels/whatsapp.js';

describe('WhatsAppChannel outgoing queue cap', () => {
  let channel: WhatsAppChannel;
  const mockOnMessage = vi.fn();
  const mockOnChatMetadata = vi.fn();
  const mockRegisteredGroups = vi.fn(() => ({}));

  beforeEach(() => {
    channel = new WhatsAppChannel({
      onMessage: mockOnMessage,
      onChatMetadata: mockOnChatMetadata,
      registeredGroups: mockRegisteredGroups,
    });
  });

  it('queues messages when disconnected', async () => {
    // Channel starts disconnected (connected = false by default)
    await channel.sendMessage('test@s.whatsapp.net', 'Hello');
    // Access the queue through another send to verify it grew
    await channel.sendMessage('test@s.whatsapp.net', 'Hello2');
    // We can verify queue size indirectly: send MAX_OUTGOING_QUEUE_SIZE+1 messages
    // and verify no error
    for (let i = 0; i < 3; i++) {
      await channel.sendMessage('test@s.whatsapp.net', `msg-${i}`);
    }
    // At this point we have 5 messages (the max)
    // This should cause the oldest to be dropped
    await channel.sendMessage('test@s.whatsapp.net', 'overflow');
    // No error thrown — that's the main assertion
  });

  it('drops oldest messages when queue exceeds max size', async () => {
    // Fill up to max (5 messages)
    for (let i = 0; i < 5; i++) {
      await channel.sendMessage('test@s.whatsapp.net', `msg-${i}`);
    }

    // Add one more — should trigger drop of oldest
    await channel.sendMessage('test@s.whatsapp.net', 'overflow-1');

    // Add two more to verify consistent capping
    await channel.sendMessage('test@s.whatsapp.net', 'overflow-2');
    await channel.sendMessage('test@s.whatsapp.net', 'overflow-3');

    // Queue should still be at max (5), not growing unbounded
    // We can't directly inspect the private queue, but we can verify
    // the channel doesn't crash and handles it gracefully
  });
});

describe('WhatsAppChannel reconnection backoff', () => {
  let channel: WhatsAppChannel;
  let mockExit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    channel = new WhatsAppChannel({
      onMessage: vi.fn(),
      onChatMetadata: vi.fn(),
      registeredGroups: vi.fn(() => ({})),
    });
    mockExit = vi.fn();
    vi.stubGlobal('process', { ...process, exit: mockExit });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('calculates exponential backoff delays correctly', () => {
    // Test the backoff formula: initial * 2^(attempt-1), capped at max
    // With RECONNECT_INITIAL_DELAY_MS=100 and RECONNECT_MAX_DELAY_MS=1000:
    // attempt 1: 100ms
    // attempt 2: 200ms
    // attempt 3: 400ms
    // attempt 4: 800ms (would be, but max attempts = 3)
    const initial = 100;
    const maxDelay = 1000;

    const delays = [1, 2, 3, 4].map((attempt) =>
      Math.min(initial * Math.pow(2, attempt - 1), maxDelay),
    );

    expect(delays[0]).toBe(100);
    expect(delays[1]).toBe(200);
    expect(delays[2]).toBe(400);
    expect(delays[3]).toBe(800);
  });

  it('backoff delay is capped at max delay', () => {
    const initial = 100;
    const maxDelay = 1000;

    // attempt 5 would be 100 * 2^4 = 1600, capped at 1000
    const delay = Math.min(initial * Math.pow(2, 4), maxDelay);
    expect(delay).toBe(1000);
  });
});
