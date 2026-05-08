import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a destination so output parsing can resolve "discord-test" → routing
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(id: string, content: object, opts?: { platformId?: string; channelType?: string; threadId?: string }) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, opts?.platformId ?? null, opts?.channelType ?? null, opts?.threadId ?? null, JSON.stringify(content));
}

describe('poll loop integration', () => {
  it('should pick up a message, process it, and write a response', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'What is the meaning of life?' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' });

    const provider = new MockProvider({}, () => '<message to="discord-test">42</message>');

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('42');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].in_reply_to).toBe('m1');

    // Input message should be acked (not pending)
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('should process multiple messages in a batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });
    insertMessage('m2', { sender: 'Bob', text: 'World' });

    const provider = new MockProvider({}, () => '<message to="discord-test">Got both messages</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Got both messages');

    await loopPromise.catch(() => {});
  });

  it('should resolve thread_id per-destination, not from global routing', async () => {
    // Seed a second destination
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();

    // Insert messages from each destination with distinct thread IDs
    insertMessage('m-discord', { sender: 'Alice', text: 'from discord' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread-1' });
    insertMessage('m-slack', { sender: 'Bob', text: 'from slack' }, { platformId: 'chan-2', channelType: 'slack', threadId: 'slack-thread-99' });

    // Agent replies to both destinations
    const provider = new MockProvider({}, () =>
      '<message to="discord-test">reply-d</message><message to="slack-test">reply-s</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    const discordOut = out.find((m) => m.platform_id === 'chan-1');
    const slackOut = out.find((m) => m.platform_id === 'chan-2');

    expect(discordOut).toBeDefined();
    expect(discordOut!.thread_id).toBe('discord-thread-1');
    expect(discordOut!.in_reply_to).toBe('m-discord');

    expect(slackOut).toBeDefined();
    expect(slackOut!.thread_id).toBe('slack-thread-99');
    expect(slackOut!.in_reply_to).toBe('m-slack');

    await loopPromise.catch(() => {});
  });

  it('should process messages arriving after loop starts', async () => {
    const provider = new MockProvider({}, () => '<message to="discord-test">Processed</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    // Insert message after loop has started
    await sleep(200);
    insertMessage('m-late', { sender: 'Charlie', text: 'Late arrival' });

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);

    await loopPromise.catch(() => {});
  });

  it('should inject destination reminder after a compacted event', async () => {
    // Two destinations — required for the reminder to fire (single-destination
    // groups have a fallback path that works without <message to="…"> wrapping).
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('discord-second', 'Discord Second', 'channel', 'discord', 'chan-2', NULL)`,
      )
      .run();

    insertMessage('m1', { sender: 'Alice', text: 'First message' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new CompactingProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2500);

    await waitFor(() => getUndeliveredMessages().length > 0, 2500);
    controller.abort();

    expect(provider.pushes.length).toBeGreaterThanOrEqual(1);
    const reminder = provider.pushes.find((p) => p.includes('Context was just compacted'));
    expect(reminder).toBeDefined();
    expect(reminder).toContain('2 destinations');
    expect(reminder).toContain('discord-test');
    expect(reminder).toContain('discord-second');
    expect(reminder).toContain('<message to="name">');

    await loopPromise.catch(() => {});
  });

  it('should NOT inject destination reminder with a single destination', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'First message' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new CompactingProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2500);

    await waitFor(() => getUndeliveredMessages().length > 0, 2500);
    controller.abort();

    // Only the original prompt push (if any) — no reminder, since beforeEach
    // seeds exactly one destination.
    const reminders = provider.pushes.filter((p) => p.includes('Context was just compacted'));
    expect(reminders).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

/**
 * Provider that emits a single compacted event mid-stream, then returns a
 * result. Captures every push() call so tests can assert on the injected
 * reminder content.
 */
class CompactingProvider {
  readonly supportsNativeSlashCommands = false;
  readonly pushes: string[] = [];

  isSessionInvalid(): boolean {
    return false;
  }

  query(_input: { prompt: string; cwd: string }) {
    const pushes = this.pushes;
    let ended = false;
    let aborted = false;
    let resolveWaiter: (() => void) | null = null;

    async function* events() {
      yield { type: 'activity' as const };
      yield { type: 'init' as const, continuation: 'compaction-test-session' };
      yield { type: 'activity' as const };
      yield { type: 'compacted' as const, text: 'Context compacted (50,000 tokens compacted).' };

      // Wait for poll-loop to push the reminder (or end / abort)
      await new Promise<void>((resolve) => {
        resolveWaiter = resolve;
        // Belt-and-braces: don't hang forever if the reminder never arrives
        setTimeout(resolve, 200);
      });

      yield { type: 'activity' as const };
      yield { type: 'result' as const, text: '<message to="discord-test">ack</message>' };
      while (!ended && !aborted) {
        await new Promise<void>((resolve) => {
          resolveWaiter = resolve;
          setTimeout(resolve, 50);
        });
      }
    }

    return {
      push(message: string) {
        pushes.push(message);
        resolveWaiter?.();
      },
      end() {
        ended = true;
        resolveWaiter?.();
      },
      abort() {
        aborted = true;
        resolveWaiter?.();
      },
      events: events(),
    };
  }
}

// Helper: run poll loop until aborted or timeout
async function runPollLoopWithTimeout(provider: MockProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return Promise.race([
    runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/tmp',
    }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
