/**
 * Load / stress tests for NanoClaw.
 *
 * Verifies correct behavior under concurrent load: database writes,
 * GroupQueue concurrency control, retry logic, anti-spam cooldowns,
 * message-loop cursor management, state consistency, and channel routing.
 *
 * Uses real in-memory SQLite and mocked container execution.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks (must come before imports that use them) ---

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  ASSISTANT_HAS_OWN_NUMBER: false,
  POLL_INTERVAL: 50,
  STORE_DIR: '/tmp/nanoclaw-stress-store',
  GROUPS_DIR: '/tmp/nanoclaw-stress-groups',
  DATA_DIR: '/tmp/nanoclaw-stress-data',
  TIMEZONE: 'UTC',
  TRIGGER_PATTERN: /^@Andy\b/i,
  CONTAINER_TIMEOUT: 300000,
  IDLE_TIMEOUT: 60000,
  MAX_CONCURRENT_CONTAINERS: 3,
  CONTAINER_PREFIX: 'nanoclaw',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CREDENTIAL_PROXY_PORT: 3001,
  IPC_POLL_INTERVAL: 1000,
  SCHEDULER_POLL_INTERVAL: 60000,
  SENDER_ALLOWLIST_PATH: '/tmp/nanoclaw-stress-sender-allowlist.json',
  MOUNT_ALLOWLIST_PATH: '/tmp/nanoclaw-stress-mount-allowlist.json',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('../group-folder.js', () => ({
  isValidGroupFolder: vi.fn((folder: string) =>
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(folder),
  ),
  assertValidGroupFolder: vi.fn(),
  resolveGroupFolderPath: vi.fn(
    (folder: string) => `/tmp/nanoclaw-stress-groups/${folder}`,
  ),
  resolveGroupIpcPath: vi.fn(
    (folder: string) => `/tmp/nanoclaw-stress-data/ipc/${folder}`,
  ),
}));

vi.mock('../sender-allowlist.js', () => ({
  loadSenderAllowlist: vi.fn(() => ({
    default: { allow: '*', mode: 'trigger' },
    chats: {},
    logDenied: false,
  })),
  isSenderAllowed: vi.fn(() => true),
  isTriggerAllowed: vi.fn(() => true),
  shouldDropMessage: vi.fn(() => false),
}));

vi.mock('../metrics.js', () => ({
  setGauge: vi.fn(),
  incCounter: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      existsSync: vi.fn(() => false),
    },
  };
});

import {
  _initTestDatabase,
  storeMessage,
  storeChatMetadata,
  getNewMessages,
  getMessagesSince,
} from '../db.js';
import { GroupQueue } from '../group-queue.js';
import {
  isRateLimitError,
  shouldNotifyError,
  markErrorNotified,
  resetErrorCooldown,
} from '../anti-spam.js';
import { findChannel } from '../router.js';
import { Channel, NewMessage } from '../types.js';

// --- Helpers ---

let msgCounter = 0;

function makeMessage(
  overrides: Partial<NewMessage> & { chat_jid: string },
): NewMessage {
  msgCounter++;
  return {
    id: overrides.id || `msg-${msgCounter}-${Date.now()}`,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender || 'user@s.whatsapp.net',
    sender_name: overrides.sender_name || 'Test User',
    content: overrides.content ?? `Test message ${msgCounter}`,
    timestamp:
      overrides.timestamp ||
      new Date(Date.now() + msgCounter).toISOString(),
    is_from_me: overrides.is_from_me ?? false,
    is_bot_message: overrides.is_bot_message ?? false,
  };
}

function makeChannel(
  name: string,
  jidPattern: (jid: string) => boolean,
): Channel {
  return {
    name,
    connect: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(jidPattern),
    disconnect: vi.fn(async () => {}),
    setTyping: vi.fn(async () => {}),
  };
}

/** Ensure the chat row exists before inserting messages (FK constraint). */
const ensuredChats = new Set<string>();
function ensureChat(jid: string): void {
  if (!ensuredChats.has(jid)) {
    storeChatMetadata(jid, new Date().toISOString(), jid, 'test', true);
    ensuredChats.add(jid);
  }
}

/** Store a message, auto-creating the parent chat row if needed. */
function storeMsg(msg: NewMessage): void {
  ensureChat(msg.chat_jid);
  storeMessage(msg);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  return delay(minMs + Math.random() * (maxMs - minMs));
}

// --- Test suites ---

describe('Stress tests', () => {
  beforeEach(() => {
    _initTestDatabase();
    msgCounter = 0;
    ensuredChats.clear();
  });

  // =========================================================================
  // 1. Concurrent message delivery (10 messages, 4 groups)
  // =========================================================================
  describe('1. Concurrent message delivery', () => {
    const groups = [
      'group-a@g.us',
      'group-b@g.us',
      'group-c@g.us',
      'group-d@g.us',
    ];

    it('stores 10 messages across 4 groups with no data loss', async () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        makeMessage({
          chat_jid: groups[i % groups.length],
          content: `Concurrent msg ${i}`,
          timestamp: new Date(Date.now() + i + 1).toISOString(),
        }),
      );

      await Promise.all(messages.map((m) => Promise.resolve(storeMsg(m))));

      for (const group of groups) {
        const stored = getMessagesSince(group, '', 'Andy');
        const expected = messages.filter((m) => m.chat_jid === group);
        expect(stored.length).toBe(expected.length);
      }
    });

    it('returns correct messages per group via getNewMessages', async () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        makeMessage({
          chat_jid: groups[i % groups.length],
          content: `New msg ${i}`,
          timestamp: new Date(Date.now() + i + 1).toISOString(),
        }),
      );

      messages.forEach((m) => storeMsg(m));

      const { messages: result } = getNewMessages(groups, '', 'Andy');
      expect(result.length).toBe(10);
    });

    it('has no cross-contamination between groups', async () => {
      const messages = Array.from({ length: 10 }, (_, i) =>
        makeMessage({
          chat_jid: groups[i % groups.length],
          content: `Isolated msg ${i}`,
          timestamp: new Date(Date.now() + i + 1).toISOString(),
        }),
      );

      messages.forEach((m) => storeMsg(m));

      for (const group of groups) {
        const stored = getMessagesSince(group, '', 'Andy');
        for (const msg of stored) {
          expect(msg.chat_jid).toBe(group);
        }
      }
    });
  });

  // =========================================================================
  // 2. GroupQueue concurrent container control
  // =========================================================================
  describe('2. GroupQueue concurrent container control', () => {
    let queue: GroupQueue;

    beforeEach(() => {
      vi.useFakeTimers();
      queue = new GroupQueue();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('enforces MAX_CONCURRENT_CONTAINERS=3 with 10 tasks across 3 groups', async () => {
      let activeCount = 0;
      let maxActive = 0;
      let completedCount = 0;
      const completionCallbacks: Array<() => void> = [];

      const processMessages = vi.fn(async () => {
        activeCount++;
        maxActive = Math.max(maxActive, activeCount);
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
        activeCount--;
        completedCount++;
        return true;
      });

      queue.setProcessMessagesFn(processMessages);

      // Enqueue 10 messages across 3 groups — each group gets multiple
      const groupJids = ['g1@g.us', 'g2@g.us', 'g3@g.us'];
      for (let i = 0; i < 10; i++) {
        queue.enqueueMessageCheck(groupJids[i % 3]);
      }

      await vi.advanceTimersByTimeAsync(10);

      // Only 3 should be running concurrently
      expect(maxActive).toBe(3);
      expect(activeCount).toBe(3);

      // Complete all tasks one by one and verify new ones start
      while (completionCallbacks.length > 0) {
        const cb = completionCallbacks.shift()!;
        cb();
        await vi.advanceTimersByTimeAsync(10);
      }

      // All groups processed (3 initial + drain cycles for pending)
      expect(completedCount).toBeGreaterThanOrEqual(3);
    });

    it('verifies all 10 enqueued tasks complete eventually', async () => {
      let completedCount = 0;

      queue.setProcessMessagesFn(
        vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          completedCount++;
          return true;
        }),
      );

      // Enqueue 10 tasks on 10 different groups (no same-group merging)
      for (let i = 0; i < 10; i++) {
        queue.enqueueTask(`g${i}@g.us`, `task-${i}`, async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
          completedCount++;
        });
      }

      // Let all timers flush (enough for all 10 to run in batches of 3)
      for (let t = 0; t < 20; t++) {
        await vi.advanceTimersByTimeAsync(100);
      }

      expect(completedCount).toBe(10);
    });

    it('preserves FIFO ordering within the same group', async () => {
      const executionOrder: string[] = [];
      const completionCallbacks: Array<() => void> = [];

      // First task blocks so subsequent ones queue up
      queue.enqueueTask('g1@g.us', 'task-0', async () => {
        executionOrder.push('task-0');
        await new Promise<void>((resolve) => completionCallbacks.push(resolve));
      });
      await vi.advanceTimersByTimeAsync(10);

      // Queue more tasks for the same group
      for (let i = 1; i <= 3; i++) {
        const taskId = `task-${i}`;
        queue.enqueueTask('g1@g.us', taskId, async () => {
          executionOrder.push(taskId);
          await new Promise<void>((resolve) =>
            completionCallbacks.push(resolve),
          );
        });
      }

      // Release tasks one by one
      for (let i = 0; i < 4; i++) {
        if (completionCallbacks.length > 0) {
          completionCallbacks.shift()!();
        }
        await vi.advanceTimersByTimeAsync(10);
      }

      expect(executionOrder).toEqual(['task-0', 'task-1', 'task-2', 'task-3']);
    });
  });

  // =========================================================================
  // 3. GroupQueue retry under failure
  // =========================================================================
  describe('3. GroupQueue retry under failure', () => {
    let queue: GroupQueue;

    beforeEach(() => {
      vi.useFakeTimers();
      queue = new GroupQueue();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries failed tasks with exponential backoff', async () => {
      let callCount = 0;

      queue.setProcessMessagesFn(
        vi.fn(async () => {
          callCount++;
          return false; // always fail
        }),
      );

      queue.enqueueMessageCheck('fail-group@g.us');
      await vi.advanceTimersByTimeAsync(10);
      expect(callCount).toBe(1);

      // Retry 1: 5000ms
      await vi.advanceTimersByTimeAsync(5010);
      expect(callCount).toBe(2);

      // Retry 2: 10000ms
      await vi.advanceTimersByTimeAsync(10010);
      expect(callCount).toBe(3);

      // Retry 3: 20000ms
      await vi.advanceTimersByTimeAsync(20010);
      expect(callCount).toBe(4);
    });

    it('drops messages after MAX_RETRIES (5)', async () => {
      let callCount = 0;

      queue.setProcessMessagesFn(
        vi.fn(async () => {
          callCount++;
          return false;
        }),
      );

      queue.enqueueMessageCheck('drop-group@g.us');

      // Initial + 5 retries = 6 calls
      const retryDelays = [10, 5010, 10010, 20010, 40010, 80010];
      for (const d of retryDelays) {
        await vi.advanceTimersByTimeAsync(d);
      }

      expect(callCount).toBe(6); // 1 initial + 5 retries

      // No more retries
      const countAfter = callCount;
      await vi.advanceTimersByTimeAsync(200000);
      expect(callCount).toBe(countAfter);
    });

    it('successful tasks are not affected by failing ones', async () => {
      const results: string[] = [];
      const completionCallbacks: Array<() => void> = [];

      queue.setProcessMessagesFn(
        vi.fn(async (groupJid: string) => {
          if (groupJid === 'fail@g.us') {
            results.push('fail');
            return false;
          }
          results.push('success');
          await new Promise<void>((resolve) =>
            completionCallbacks.push(resolve),
          );
          return true;
        }),
      );

      queue.enqueueMessageCheck('ok@g.us');
      queue.enqueueMessageCheck('fail@g.us');

      await vi.advanceTimersByTimeAsync(10);

      // Both should have been called
      expect(results).toContain('success');
      expect(results).toContain('fail');

      // Complete the successful one
      if (completionCallbacks.length > 0) completionCallbacks[0]();
      await vi.advanceTimersByTimeAsync(10);
    });
  });

  // =========================================================================
  // 4. Database under concurrent writes
  // =========================================================================
  describe('4. Database under concurrent writes', () => {
    it('stores all 50 concurrent messages without WAL conflicts', async () => {
      const messages = Array.from({ length: 50 }, (_, i) =>
        makeMessage({
          chat_jid: `db-stress@g.us`,
          content: `Concurrent write ${i}`,
          // Ensure unique timestamps
          timestamp: new Date(Date.now() + i + 1).toISOString(),
        }),
      );

      // Fire all 50 writes concurrently
      await Promise.all(messages.map((m) => Promise.resolve(storeMsg(m))));

      const stored = getMessagesSince('db-stress@g.us', '', 'Andy');
      expect(stored.length).toBe(50);
    });

    it('preserves message ordering by timestamp', async () => {
      const baseTime = Date.now();
      const messages = Array.from({ length: 50 }, (_, i) =>
        makeMessage({
          chat_jid: 'order-test@g.us',
          content: `Ordered msg ${i}`,
          timestamp: new Date(baseTime + i).toISOString(),
        }),
      );

      // Write in random order
      const shuffled = [...messages].sort(() => Math.random() - 0.5);
      shuffled.forEach((m) => storeMsg(m));

      const stored = getMessagesSince('order-test@g.us', '', 'Andy');
      expect(stored.length).toBe(50);

      // Verify ascending timestamp order
      for (let i = 1; i < stored.length; i++) {
        expect(stored[i].timestamp >= stored[i - 1].timestamp).toBe(true);
      }
    });

    it('handles duplicate message IDs via upsert', async () => {
      const msg = makeMessage({
        chat_jid: 'dup-test@g.us',
        content: 'original',
      });

      // Write same ID 10 times with different content
      for (let i = 0; i < 10; i++) {
        storeMsg({ ...msg, content: `version-${i}` });
      }

      const stored = getMessagesSince('dup-test@g.us', '', 'Andy');
      expect(stored.length).toBe(1);
      expect(stored[0].content).toBe('version-9'); // last write wins
    });
  });

  // =========================================================================
  // 5. Anti-spam under rapid fire
  // =========================================================================
  describe('5. Anti-spam under rapid fire', () => {
    it('only allows 1 notification during cooldown for 20 rapid errors', () => {
      const jid = 'spam-test@g.us';
      resetErrorCooldown(jid);

      let notificationCount = 0;
      for (let i = 0; i < 20; i++) {
        if (shouldNotifyError(jid)) {
          notificationCount++;
          markErrorNotified(jid);
        }
      }

      // Only the first should pass
      expect(notificationCount).toBe(1);
    });

    it('cooldown resets after resetErrorCooldown', () => {
      const jid = 'reset-test@g.us';

      // First notification
      expect(shouldNotifyError(jid)).toBe(true);
      markErrorNotified(jid);

      // Blocked
      expect(shouldNotifyError(jid)).toBe(false);

      // Reset
      resetErrorCooldown(jid);

      // Should be allowed again
      expect(shouldNotifyError(jid)).toBe(true);
    });

    it('detects rate limit patterns consistently', () => {
      const rateLimitTexts = [
        'You hit your limit for the day',
        'Error: rate limit exceeded',
        'rate_limit_error: too many requests',
        'The server is overloaded right now',
        'HTTP 429 Too Many Requests',
      ];

      for (const text of rateLimitTexts) {
        expect(isRateLimitError(text)).toBe(true);
      }

      expect(isRateLimitError('Hello world')).toBe(false);
      expect(isRateLimitError('Task completed successfully')).toBe(false);
    });

    it('handles multiple JIDs independently', () => {
      const jids = Array.from({ length: 10 }, (_, i) => `jid-${i}@g.us`);

      // All should be allowed initially
      for (const jid of jids) {
        resetErrorCooldown(jid);
        expect(shouldNotifyError(jid)).toBe(true);
      }

      // Mark half as notified
      for (let i = 0; i < 5; i++) {
        markErrorNotified(jids[i]);
      }

      // First 5 blocked, rest still allowed
      for (let i = 0; i < 5; i++) {
        expect(shouldNotifyError(jids[i])).toBe(false);
      }
      for (let i = 5; i < 10; i++) {
        expect(shouldNotifyError(jids[i])).toBe(true);
      }
    });
  });

  // =========================================================================
  // 6. Message loop poll cycle
  // =========================================================================
  describe('6. Message loop poll cycle', () => {
    it('cursor advances correctly across 3 poll cycles', () => {
      const jids = ['poll-a@g.us', 'poll-b@g.us'];
      let cursor = '';

      // Cycle 1: store 3 messages
      const batch1 = Array.from({ length: 3 }, (_, i) =>
        makeMessage({
          chat_jid: jids[i % 2],
          content: `Cycle 1 msg ${i}`,
          timestamp: new Date(Date.now() + i + 1).toISOString(),
        }),
      );
      batch1.forEach((m) => storeMsg(m));

      const result1 = getNewMessages(jids, cursor, 'Andy');
      expect(result1.messages.length).toBe(3);
      cursor = result1.newTimestamp;

      // Cycle 2: store 2 more
      const batch2 = Array.from({ length: 2 }, (_, i) =>
        makeMessage({
          chat_jid: jids[i % 2],
          content: `Cycle 2 msg ${i}`,
          timestamp: new Date(Date.now() + 100 + i).toISOString(),
        }),
      );
      batch2.forEach((m) => storeMsg(m));

      const result2 = getNewMessages(jids, cursor, 'Andy');
      expect(result2.messages.length).toBe(2);
      cursor = result2.newTimestamp;

      // Cycle 3: no new messages
      const result3 = getNewMessages(jids, cursor, 'Andy');
      expect(result3.messages.length).toBe(0);
    });

    it('does not process the same message twice', () => {
      const jid = 'no-dup@g.us';
      let cursor = '';

      const msg = makeMessage({
        chat_jid: jid,
        content: 'Unique message',
        timestamp: new Date(Date.now() + 1).toISOString(),
      });
      storeMsg(msg);

      const result1 = getNewMessages([jid], cursor, 'Andy');
      expect(result1.messages.length).toBe(1);
      cursor = result1.newTimestamp;

      // Same cursor - should get nothing
      const result2 = getNewMessages([jid], cursor, 'Andy');
      expect(result2.messages.length).toBe(0);
    });

    it('does not skip any messages between cycles', () => {
      const jid = 'no-skip@g.us';
      let cursor = '';
      const allIds: string[] = [];

      for (let cycle = 0; cycle < 5; cycle++) {
        const count = 2 + cycle; // varying batch sizes
        const batch = Array.from({ length: count }, (_, i) =>
          makeMessage({
            chat_jid: jid,
            content: `C${cycle} M${i}`,
            timestamp: new Date(
              Date.now() + cycle * 1000 + i + 1,
            ).toISOString(),
          }),
        );
        batch.forEach((m) => storeMsg(m));

        const result = getNewMessages([jid], cursor, 'Andy');
        expect(result.messages.length).toBe(count);
        allIds.push(...result.messages.map((m) => m.id));
        cursor = result.newTimestamp;
      }

      // Total: 2+3+4+5+6 = 20
      expect(allIds.length).toBe(20);
      // All unique
      expect(new Set(allIds).size).toBe(20);
    });

    it('filters bot messages from poll results', () => {
      const jid = 'bot-filter@g.us';

      storeMsg(
        makeMessage({
          chat_jid: jid,
          content: 'user message',
          timestamp: new Date(Date.now() + 1).toISOString(),
        }),
      );
      storeMsg(
        makeMessage({
          chat_jid: jid,
          content: 'Andy: bot response',
          is_bot_message: true,
          timestamp: new Date(Date.now() + 2).toISOString(),
        }),
      );
      storeMsg(
        makeMessage({
          chat_jid: jid,
          content: 'another user message',
          timestamp: new Date(Date.now() + 3).toISOString(),
        }),
      );

      const result = getNewMessages([jid], '', 'Andy');
      expect(result.messages.length).toBe(2);
      expect(result.messages.every((m) => !m.content.startsWith('Andy:'))).toBe(
        true,
      );
    });
  });

  // =========================================================================
  // 7. State consistency under concurrent access
  // =========================================================================
  describe('7. State consistency under concurrent access', () => {
    it('concurrent GroupQueue enqueues do not corrupt internal state', async () => {
      vi.useFakeTimers();
      const queue = new GroupQueue();
      let completedCount = 0;
      const completionCallbacks: Array<() => void> = [];

      queue.setProcessMessagesFn(
        vi.fn(async () => {
          await new Promise<void>((resolve) =>
            completionCallbacks.push(resolve),
          );
          completedCount++;
          return true;
        }),
      );

      // Rapidly enqueue 20 messages across 5 groups
      for (let i = 0; i < 20; i++) {
        queue.enqueueMessageCheck(`state-g${i % 5}@g.us`);
      }

      await vi.advanceTimersByTimeAsync(10);

      // Should have exactly 3 active (concurrency limit)
      expect(completionCallbacks.length).toBe(3);

      // Drain all
      while (completionCallbacks.length > 0) {
        completionCallbacks.shift()!();
        await vi.advanceTimersByTimeAsync(10);
      }

      // All 5 unique groups should have been processed at least once.
      // Groups with multiple enqueues may re-run due to pendingMessages draining.
      expect(completedCount).toBeGreaterThanOrEqual(5);

      vi.useRealTimers();
    });

    it('interleaved task and message enqueues maintain consistency', async () => {
      vi.useFakeTimers();
      const queue = new GroupQueue();
      const executionLog: string[] = [];
      const completionCallbacks: Array<() => void> = [];

      queue.setProcessMessagesFn(
        vi.fn(async (groupJid: string) => {
          executionLog.push(`msg:${groupJid}`);
          await new Promise<void>((resolve) =>
            completionCallbacks.push(resolve),
          );
          return true;
        }),
      );

      // Mix tasks and messages for same group
      queue.enqueueMessageCheck('mixed@g.us');
      await vi.advanceTimersByTimeAsync(10);

      queue.enqueueTask('mixed@g.us', 'task-1', async () => {
        executionLog.push('task:task-1');
        await new Promise<void>((resolve) =>
          completionCallbacks.push(resolve),
        );
      });
      queue.enqueueMessageCheck('mixed@g.us');

      // Release first message processing
      completionCallbacks.shift()!();
      await vi.advanceTimersByTimeAsync(10);

      // Task should run before pending messages (priority)
      expect(executionLog[0]).toBe('msg:mixed@g.us');
      expect(executionLog[1]).toBe('task:task-1');

      // Release task
      if (completionCallbacks.length > 0) {
        completionCallbacks.shift()!();
        await vi.advanceTimersByTimeAsync(10);
      }

      vi.useRealTimers();
    });

    it('cleanup removes only idle groups', async () => {
      vi.useFakeTimers();
      const queue = new GroupQueue();
      const completionCallbacks: Array<() => void> = [];

      queue.setProcessMessagesFn(
        vi.fn(async () => {
          await new Promise<void>((resolve) =>
            completionCallbacks.push(resolve),
          );
          return true;
        }),
      );

      // Start group1 (active), leave group2 idle
      queue.enqueueMessageCheck('active@g.us');
      queue.enqueueMessageCheck('idle@g.us');
      await vi.advanceTimersByTimeAsync(10);

      // Complete idle group
      if (completionCallbacks.length >= 2) {
        completionCallbacks[1]();
        await vi.advanceTimersByTimeAsync(10);
      }

      // Cleanup should keep active, can remove idle
      queue.cleanup(new Set(['active@g.us']));

      // active@g.us should still work
      completionCallbacks[0]();
      await vi.advanceTimersByTimeAsync(10);

      vi.useRealTimers();
    });
  });

  // =========================================================================
  // 8. Channel routing stress
  // =========================================================================
  describe('8. Channel routing stress', () => {
    const whatsappChannel = makeChannel('whatsapp', (jid) =>
      jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net'),
    );
    const gmailChannel = makeChannel('gmail', (jid) =>
      jid.startsWith('gmail:'),
    );
    const chatChannel = makeChannel('google-chat', (jid) =>
      jid.startsWith('gchat:'),
    );
    const channels: Channel[] = [whatsappChannel, gmailChannel, chatChannel];

    it('routes 20 messages to correct channel handlers', () => {
      const jids = [
        // WhatsApp
        'group1@g.us',
        'group2@g.us',
        'user1@s.whatsapp.net',
        'group3@g.us',
        'group4@g.us',
        'user2@s.whatsapp.net',
        'group5@g.us',
        // Gmail
        'gmail:inbox-1',
        'gmail:inbox-2',
        'gmail:inbox-3',
        'gmail:inbox-4',
        'gmail:inbox-5',
        'gmail:inbox-6',
        // Google Chat
        'gchat:space-1',
        'gchat:space-2',
        'gchat:space-3',
        'gchat:space-4',
        'gchat:space-5',
        'gchat:space-6',
        'gchat:space-7',
      ];

      expect(jids.length).toBe(20);

      for (const jid of jids) {
        const channel = findChannel(channels, jid);
        expect(channel).toBeDefined();

        if (jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net')) {
          expect(channel!.name).toBe('whatsapp');
        } else if (jid.startsWith('gmail:')) {
          expect(channel!.name).toBe('gmail');
        } else if (jid.startsWith('gchat:')) {
          expect(channel!.name).toBe('google-chat');
        }
      }
    });

    it('findChannel does not degrade with many lookups', () => {
      const start = performance.now();
      const iterations = 10000;

      for (let i = 0; i < iterations; i++) {
        const jid =
          i % 3 === 0
            ? `group${i}@g.us`
            : i % 3 === 1
              ? `gmail:inbox-${i}`
              : `gchat:space-${i}`;
        findChannel(channels, jid);
      }

      const elapsed = performance.now() - start;
      // 10000 lookups should complete in well under 1 second
      expect(elapsed).toBeLessThan(1000);
    });

    it('returns undefined for unknown JID patterns', () => {
      const unknownJids = [
        'unknown:123',
        'slack:channel-1',
        'dc:12345',
        'tg:67890',
      ];

      for (const jid of unknownJids) {
        const channel = findChannel(channels, jid);
        expect(channel).toBeUndefined();
      }
    });

    it('handles concurrent sendMessage calls across channels', async () => {
      const sendPromises: Promise<void>[] = [];

      for (let i = 0; i < 20; i++) {
        const jid =
          i % 3 === 0
            ? `group${i}@g.us`
            : i % 3 === 1
              ? `gmail:inbox-${i}`
              : `gchat:space-${i}`;

        const channel = findChannel(channels, jid);
        if (channel) {
          sendPromises.push(channel.sendMessage(jid, `Message ${i}`));
        }
      }

      await Promise.all(sendPromises);

      const totalCalls =
        (whatsappChannel.sendMessage as ReturnType<typeof vi.fn>).mock.calls
          .length +
        (gmailChannel.sendMessage as ReturnType<typeof vi.fn>).mock.calls
          .length +
        (chatChannel.sendMessage as ReturnType<typeof vi.fn>).mock.calls.length;

      expect(totalCalls).toBe(20);
    });
  });

  // =========================================================================
  // Additional edge cases
  // =========================================================================
  describe('Edge cases', () => {
    it('GroupQueue shutdown prevents all new enqueues', async () => {
      vi.useFakeTimers();
      const queue = new GroupQueue();
      const callCount = { value: 0 };

      queue.setProcessMessagesFn(
        vi.fn(async () => {
          callCount.value++;
          return true;
        }),
      );

      await queue.shutdown(1000);

      // Try all enqueue paths
      queue.enqueueMessageCheck('shutdown-1@g.us');
      queue.enqueueTask('shutdown-2@g.us', 'task-1', async () => {
        callCount.value++;
      });

      await vi.advanceTimersByTimeAsync(1000);
      expect(callCount.value).toBe(0);

      vi.useRealTimers();
    });

    it('empty content messages are filtered from query results', () => {
      const jid = 'empty-test@g.us';

      storeMsg(
        makeMessage({
          chat_jid: jid,
          content: '',
          timestamp: new Date(Date.now() + 1).toISOString(),
        }),
      );
      storeMsg(
        makeMessage({
          chat_jid: jid,
          content: 'real content',
          timestamp: new Date(Date.now() + 2).toISOString(),
        }),
      );

      const result = getNewMessages([jid], '', 'Andy');
      expect(result.messages.length).toBe(1);
      expect(result.messages[0].content).toBe('real content');
    });

    it('getMessagesSince with future cursor returns empty', () => {
      const jid = 'future-cursor@g.us';

      storeMsg(
        makeMessage({
          chat_jid: jid,
          content: 'old message',
          timestamp: new Date(Date.now() + 1).toISOString(),
        }),
      );

      const futureCursor = new Date(Date.now() + 999999).toISOString();
      const result = getMessagesSince(jid, futureCursor, 'Andy');
      expect(result.length).toBe(0);
    });
  });
});
