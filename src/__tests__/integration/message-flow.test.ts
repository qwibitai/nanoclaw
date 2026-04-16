/**
 * Integration: message arrival → DB storage → group queue → mocked agent
 * → response routed back to channel.
 *
 * Wires together real db, GroupQueue, and router modules with a fake
 * channel and a fake "agent" implementation to verify the inbound →
 * outbound flow without spawning actual containers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GroupQueue } from '../../group-queue.js';
import {
  getNewMessages,
  storeChatMetadata,
  storeMessage,
} from '../../db.js';
import { formatMessages, routeOutbound } from '../../router.js';
import type { RegisteredGroup } from '../../types.js';

import {
  createMessage,
  createStubChannel,
  resetTestDatabase,
  seedRegisteredGroup,
} from './harness.js';

// Wait until GroupQueue reports no active containers and no pending work.
async function waitIdle(queue: GroupQueue, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (queue.getStatus().activeContainers === 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('queue did not become idle within timeout');
}

describe('integration: message-to-response flow', () => {
  beforeEach(() => {
    resetTestDatabase();
  });

  it('stores message, queue picks it up, agent replies, outbound routed', async () => {
    const groupJid = 'group1@g.us';
    const folder = 'group1';
    const channel = createStubChannel({ ownedJids: [groupJid] });
    const group = seedRegisteredGroup({
      name: 'Group 1',
      folder,
      jid: groupJid,
      isMain: false,
      requiresTrigger: false,
    });
    storeChatMetadata(groupJid, '2026-01-01T00:00:00.000Z', 'Group 1', 'stub', true);

    // Seed an inbound message (as if a channel stored it)
    const msg = createMessage({
      chat_jid: groupJid,
      content: 'hello andy',
      timestamp: '2026-01-01T00:00:01.000Z',
    });
    storeMessage(msg, 'stub');

    // Wire a fake processMessagesFn that mirrors the real orchestrator:
    // read new messages, format, invoke "agent", route result outbound.
    const queue = new GroupQueue();
    const agent = vi.fn(async (prompt: string) => `reply to: ${prompt}`);

    queue.setProcessMessagesFn(async (jid) => {
      const { messages } = getNewMessages([jid], '', 'nanoclaw-bot');
      const prompt = formatMessages(messages, 'UTC', group as RegisteredGroup);
      const reply = await agent(prompt);
      await routeOutbound([channel], jid, reply);
      queue.markResponseSent(jid);
      return true;
    });

    queue.enqueueMessageCheck(groupJid);
    await waitIdle(queue);

    expect(agent).toHaveBeenCalledTimes(1);
    expect(agent.mock.calls[0][0]).toContain('hello andy');
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0].jid).toBe(groupJid);
    expect(channel.sent[0].text).toContain('reply to:');
  });

  it('multiple messages queued while container active are drained', async () => {
    const groupJid = 'group-drain@g.us';
    const channel = createStubChannel({ ownedJids: [groupJid] });
    seedRegisteredGroup({
      name: 'Drain',
      folder: 'drain',
      jid: groupJid,
      requiresTrigger: false,
    });
    storeChatMetadata(
      groupJid,
      '2026-01-01T00:00:00.000Z',
      'Drain',
      'stub',
      true,
    );
    storeMessage(
      createMessage({
        chat_jid: groupJid,
        content: 'first',
        timestamp: '2026-01-01T00:00:01.000Z',
      }),
      'stub',
    );

    const queue = new GroupQueue();
    let runs = 0;
    queue.setProcessMessagesFn(async (jid) => {
      runs++;
      if (runs === 1) {
        // Simulate another message arriving mid-processing
        storeMessage(
          createMessage({
            chat_jid: jid,
            content: 'second',
            timestamp: '2026-01-01T00:00:02.000Z',
          }),
          'stub',
        );
        queue.enqueueMessageCheck(jid);
      }
      await channel.sendMessage(jid, `run #${runs}`);
      return true;
    });

    queue.enqueueMessageCheck(groupJid);
    await waitIdle(queue);

    expect(runs).toBe(2);
    expect(channel.sent.map((s) => s.text)).toEqual(['run #1', 'run #2']);
  });

  it('retry with backoff when processing fails', async () => {
    const groupJid = 'group-retry@g.us';
    const channel = createStubChannel({ ownedJids: [groupJid] });
    seedRegisteredGroup({
      name: 'Retry',
      folder: 'retry',
      jid: groupJid,
      requiresTrigger: false,
    });
    storeChatMetadata(
      groupJid,
      '2026-01-01T00:00:00.000Z',
      'Retry',
      'stub',
      true,
    );
    storeMessage(
      createMessage({
        chat_jid: groupJid,
        content: 'failing',
        timestamp: '2026-01-01T00:00:01.000Z',
      }),
      'stub',
    );

    const queue = new GroupQueue();
    let attempts = 0;
    queue.setProcessMessagesFn(async (jid) => {
      attempts++;
      if (attempts < 3) return false; // fail twice
      await channel.sendMessage(jid, 'ok');
      return true;
    });

    // Use fake timers only for this retry/backoff test so we can fast-forward
    // through the scheduled 5s / 10s backoff waits.
    vi.useFakeTimers();
    try {
      queue.enqueueMessageCheck(groupJid);
      // Allow the first failed attempt to settle, then advance through backoff.
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5000);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(10000);
      await Promise.resolve();
      // Allow final run to complete.
      await vi.advanceTimersByTimeAsync(10);
    } finally {
      vi.useRealTimers();
    }

    // Let any queued microtasks finish on real timers.
    await waitIdle(queue);

    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(channel.sent.length).toBeGreaterThanOrEqual(1);
    expect(channel.sent.at(-1)?.text).toBe('ok');
  });
});
