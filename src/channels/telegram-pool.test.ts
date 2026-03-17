import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock grammy (needed because telegram.ts imports it at top level)
vi.mock('grammy', () => ({
  Bot: class MockBot {
    constructor() {}
    command() {}
    on() {}
    catch() {}
    start() {}
    stop() {}
  },
  Api: class MockApi {
    constructor() {}
  },
}));

import { BotPool, BotPoolDeps } from './telegram.js';

// Shared mock Api factory — pass overrides for specific method captures
function createMockApi(
  overrides: {
    sendMessage?: (chatId: string | number, text: string, opts?: any) => any;
    setMyName?: (name: string) => any;
    getMe?: () => any;
  } = {},
) {
  return {
    getMe:
      overrides.getMe ??
      (async () => ({
        username: 'test_bot',
        id: 123,
        is_bot: true,
        first_name: 'test_bot',
      })),
    setMyName: overrides.setMyName ?? (async (_name: string) => true),
    sendMessage:
      overrides.sendMessage ??
      (async (_chatId: string | number, _text: string) =>
        ({ message_id: 1 }) as any),
  } as any;
}

function makeDeps(
  apiOverrides: Parameters<typeof createMockApi>[0] = {},
): BotPoolDeps {
  return {
    createApi: () => createMockApi(apiOverrides),
    renameDelayMs: 0,
  };
}

const testDeps = makeDeps();

describe('BotPool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // INVARIANT: Same sender+groupFolder always maps to same pool bot index
  test('stable sender assignment within a session', async () => {
    const pool = new BotPool(testDeps);
    await pool.init(['token1', 'token2', 'token3']);

    await pool.send('tg:123', 'hello', 'Researcher', 'main');
    const firstAssignment = pool.getAssignment('Researcher', 'main');

    await pool.send('tg:123', 'world', 'Researcher', 'main');
    const secondAssignment = pool.getAssignment('Researcher', 'main');

    expect(firstAssignment).toBe(secondAssignment);
  });

  // INVARIANT: Pool bots are assigned round-robin
  test('round-robin assignment across different senders', async () => {
    const pool = new BotPool(testDeps);
    await pool.init(['token1', 'token2', 'token3']);

    await pool.send('tg:123', 'hi', 'Researcher', 'main');
    await pool.send('tg:123', 'hi', 'Writer', 'main');
    await pool.send('tg:123', 'hi', 'Reviewer', 'main');

    expect(pool.getAssignment('Researcher', 'main')).toBe(0);
    expect(pool.getAssignment('Writer', 'main')).toBe(1);
    expect(pool.getAssignment('Reviewer', 'main')).toBe(2);
  });

  // INVARIANT: Round-robin wraps when pool exhausts
  test('assignment wraps around when pool is exhausted', async () => {
    const pool = new BotPool(testDeps);
    await pool.init(['token1', 'token2']);

    await pool.send('tg:123', 'hi', 'Agent1', 'main');
    await pool.send('tg:123', 'hi', 'Agent2', 'main');
    await pool.send('tg:123', 'hi', 'Agent3', 'main');

    expect(pool.getAssignment('Agent1', 'main')).toBe(0);
    expect(pool.getAssignment('Agent2', 'main')).toBe(1);
    expect(pool.getAssignment('Agent3', 'main')).toBe(0); // wraps
  });

  // INVARIANT: If pool is empty, send returns false (signals fallback needed)
  test('returns false when pool is empty', async () => {
    const pool = new BotPool(testDeps);
    // Don't init — pool stays empty

    const result = await pool.send('tg:123', 'hello', 'Researcher', 'main');
    expect(result).toBe(false);
  });

  // INVARIANT: Different groups get independent sender assignments
  test('sender assignments are independent per group', async () => {
    const pool = new BotPool(testDeps);
    await pool.init(['token1', 'token2']);

    await pool.send('tg:123', 'hi', 'Researcher', 'group-a');
    await pool.send('tg:456', 'hi', 'Researcher', 'group-b');

    expect(pool.getAssignment('Researcher', 'group-a')).toBe(0);
    expect(pool.getAssignment('Researcher', 'group-b')).toBe(1);
  });

  // INVARIANT: Messages over 4096 chars are split
  test('long messages are split at 4096 char boundary', async () => {
    const sentMessages: string[] = [];
    const deps = makeDeps({
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text);
        return { message_id: 1 } as any;
      },
    });

    const pool = new BotPool(deps);
    await pool.init(['token1']);

    const longText = 'x'.repeat(5000);
    await pool.send('tg:123', longText, 'Writer', 'main');

    expect(sentMessages.length).toBe(2);
    expect(sentMessages[0].length).toBe(4096);
    expect(sentMessages[1].length).toBe(904);
  });

  // INVARIANT: Message exactly at 4096 chars is sent as a single message
  test('exactly 4096 chars sends as single message', async () => {
    const sentMessages: string[] = [];
    const deps = makeDeps({
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text);
        return { message_id: 1 } as any;
      },
    });

    const pool = new BotPool(deps);
    await pool.init(['token1']);

    await pool.send('tg:123', 'x'.repeat(4096), 'Writer', 'main');

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].length).toBe(4096);
  });

  // INVARIANT: Empty string is sent as a single message (no split)
  test('empty string sends as single message', async () => {
    const sentMessages: string[] = [];
    const deps = makeDeps({
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text);
        return { message_id: 1 } as any;
      },
    });

    const pool = new BotPool(deps);
    await pool.init(['token1']);

    await pool.send('tg:123', '', 'Writer', 'main');

    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0]).toBe('');
  });

  // INVARIANT: Failed token init doesn't crash, just skips that bot
  test('gracefully handles failed token initialization', async () => {
    let callCount = 0;
    const failingDeps: BotPoolDeps = {
      createApi: () =>
        createMockApi({
          getMe: async () => {
            callCount++;
            if (callCount === 2) throw new Error('Invalid token');
            return {
              username: `bot${callCount}`,
              id: callCount,
              is_bot: true,
              first_name: `bot${callCount}`,
            };
          },
        }),
      renameDelayMs: 0,
    };

    const pool = new BotPool(failingDeps);
    await pool.init(['good1', 'bad', 'good3']);

    expect(pool.size).toBe(2); // Only 2 succeeded
  });

  // INVARIANT: reset clears all state
  test('reset clears pool state', async () => {
    const pool = new BotPool(testDeps);
    await pool.init(['token1']);
    await pool.send('tg:123', 'hi', 'Researcher', 'main');

    expect(pool.size).toBe(1);
    expect(pool.getAssignment('Researcher', 'main')).toBe(0);

    pool.reset();

    expect(pool.size).toBe(0);
    expect(pool.getAssignment('Researcher', 'main')).toBeUndefined();
  });

  // INVARIANT: send returns true when pool has bots and message is sent
  test('returns true when pool has bots and send succeeds', async () => {
    const pool = new BotPool(testDeps);
    await pool.init(['token1']);

    const result = await pool.send('tg:123', 'hello', 'Researcher', 'main');
    expect(result).toBe(true);
  });

  // INVARIANT: setMyName is called on first assignment, not on subsequent sends
  test('renames bot only on first assignment for a sender', async () => {
    const setMyNameCalls: string[] = [];
    const deps = makeDeps({
      setMyName: async (name: string) => {
        setMyNameCalls.push(name);
        return true;
      },
    });

    const pool = new BotPool(deps);
    await pool.init(['token1']);

    await pool.send('tg:123', 'first', 'Researcher', 'main');
    await pool.send('tg:123', 'second', 'Researcher', 'main');
    await pool.send('tg:123', 'third', 'Researcher', 'main');

    expect(setMyNameCalls).toEqual(['Researcher']); // Only once
  });

  // INVARIANT: Failed rename does not prevent message delivery
  test('sends message even when rename fails', async () => {
    const sentMessages: string[] = [];
    const deps = makeDeps({
      setMyName: async () => {
        throw new Error('Rename failed');
      },
      sendMessage: async (_chatId, text) => {
        sentMessages.push(text);
        return { message_id: 1 } as any;
      },
    });

    const pool = new BotPool(deps);
    await pool.init(['token1']);

    const result = await pool.send(
      'tg:123',
      'hello despite rename failure',
      'Researcher',
      'main',
    );

    expect(result).toBe(true);
    expect(sentMessages).toEqual(['hello despite rename failure']);
  });

  // INVARIANT: send returns false on Telegram API errors so caller can fall back
  // SUT: BotPool.send() error path
  test('returns false when sendMessage fails, enabling fallback', async () => {
    const deps = makeDeps({
      sendMessage: async () => {
        throw new Error('Telegram API: chat not found');
      },
    });

    const pool = new BotPool(deps);
    await pool.init(['token1']);

    const result = await pool.send('tg:999', 'hello', 'Researcher', 'main');
    expect(result).toBe(false);
  });

  // INVARIANT: For any pool size N, sender i always gets bot (i % N)
  // SUT: BotPool round-robin assignment property
  test('round-robin property holds for various pool sizes', async () => {
    for (const poolSize of [1, 2, 3, 5, 7]) {
      const pool = new BotPool(testDeps);
      await pool.init(Array.from({ length: poolSize }, (_, i) => `token${i}`));

      for (let sender = 0; sender < poolSize * 3; sender++) {
        await pool.send('tg:123', 'hi', `sender-${sender}`, 'main');
        expect(pool.getAssignment(`sender-${sender}`, 'main')).toBe(
          sender % poolSize,
        );
      }
    }
  });
});
