/**
 * Targeted tests for the silent-task / lie-by-omission fix.
 *
 * Scenarios:
 *   1. SDK terminal result with subtype='error_*' → markFailed + DM the
 *      originating channel.
 *   2. SDK stream ends without any terminal result → markFailed + DM.
 *   3. SDK terminal result with subtype='success' but empty text →
 *      markCompleted (legitimate "no chat reply needed" turn). No DM.
 *   4. Synthetic mid-turn result (subtype undefined) followed by terminal
 *      success → text dispatched, terminal success acks the turn. No DM.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertChat(id: string, text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'chan-1', 'discord', 'thread-1', ?)`,
    )
    .run(id, JSON.stringify({ sender: 'Tester', text }));
}

function getAckStatus(messageId: string): string | undefined {
  const row = getOutboundDb()
    .prepare("SELECT status FROM processing_ack WHERE message_id = ?")
    .get(messageId) as { status: string } | undefined;
  return row?.status;
}

/** Programmable provider — yields a sequence of events then closes the stream. */
class ScriptedProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  constructor(private events: ProviderEvent[]) {}
  isSessionInvalid(): boolean { return false; }
  query(_input: QueryInput): AgentQuery {
    const events = this.events;
    const iter: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        for (const ev of events) yield ev;
      },
    };
    return {
      push() {},
      end() {},
      events: iter,
      abort() {},
    };
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Runs the poll loop in the background and returns a controller. Tests
 * must call `controller.stop()` after assertions to prevent the loop
 * from cross-contaminating the next test's DB (the connection module's
 * DB singleton is reset in beforeEach, so a still-running loop would
 * point at the next test's DB).
 */
function startLoop(provider: AgentProvider): { stop: () => Promise<void> } {
  const controller = new AbortController();
  const promise = runPollLoop({
    provider,
    providerName: 'mock',
    cwd: '/tmp',
    stopSignal: controller.signal,
  }).catch(() => {});
  return {
    stop: async () => {
      controller.abort();
      await promise;
    },
  };
}

describe('silent-failure detection in processQuery', () => {
  it('marks message FAILED and DMs the channel when SDK returns an error subtype', async () => {
    insertChat('m1', 'hello');
    const loop = startLoop(new ScriptedProvider([
      { type: 'init', continuation: 'sess-1' },
      { type: 'result', text: null, subtype: 'error_during_execution' },
    ]));

    await waitFor(() => getAckStatus('m1') !== undefined);
    await loop.stop();

    expect(getAckStatus('m1')).toBe('failed');
    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);
    const failureNote = out.find((m) => JSON.parse(m.content).text?.includes('did not complete'));
    expect(failureNote).toBeTruthy();
    expect(JSON.parse(failureNote!.content).text).toContain('error_during_execution');
    expect(failureNote!.platform_id).toBe('chan-1');
    expect(failureNote!.channel_type).toBe('discord');
  });

  it('marks message FAILED and DMs the channel when stream ends with no terminal result', async () => {
    insertChat('m1', 'hello');
    const loop = startLoop(new ScriptedProvider([
      { type: 'init', continuation: 'sess-1' },
      { type: 'activity' },
      // No 'result' event — stream just ends.
    ]));

    await waitFor(() => getAckStatus('m1') !== undefined);
    await loop.stop();

    expect(getAckStatus('m1')).toBe('failed');
    const out = getUndeliveredMessages();
    const failureNote = out.find((m) => JSON.parse(m.content).text?.includes('did not complete'));
    expect(failureNote).toBeTruthy();
    expect(JSON.parse(failureNote!.content).text).toContain('SDK stream ended without terminal result');
  });

  it('captures last in-stream error event and surfaces it in the failure DM', async () => {
    insertChat('m1', 'hello');
    const loop = startLoop(new ScriptedProvider([
      { type: 'init', continuation: 'sess-1' },
      { type: 'error', message: 'Rate limit', retryable: false, classification: 'quota' },
      // Stream ends without terminal result after the error.
    ]));

    await waitFor(() => getAckStatus('m1') !== undefined);
    await loop.stop();

    expect(getAckStatus('m1')).toBe('failed');
    const out = getUndeliveredMessages();
    const failureNote = out.find((m) => JSON.parse(m.content).text?.includes('did not complete'));
    expect(failureNote).toBeTruthy();
    expect(JSON.parse(failureNote!.content).text).toContain('Rate limit');
    expect(JSON.parse(failureNote!.content).text).toContain('quota');
  });

  it('marks COMPLETED for a clean success terminal even when text is empty (no chat reply needed)', async () => {
    insertChat('m1', 'hello');
    const loop = startLoop(new ScriptedProvider([
      { type: 'init', continuation: 'sess-1' },
      { type: 'result', text: null, subtype: 'success' },
    ]));

    await waitFor(() => getAckStatus('m1') !== undefined);
    await loop.stop();

    expect(getAckStatus('m1')).toBe('completed');
    const out = getUndeliveredMessages();
    // No failure DM should have been written.
    const failureNote = out.find((m) => JSON.parse(m.content).text?.includes('did not complete'));
    expect(failureNote).toBeUndefined();
  });

  it('treats subtype-undefined result as synthetic mid-turn (compact_boundary): dispatches text without acking the turn', async () => {
    insertChat('m1', 'hello');
    const loop = startLoop(new ScriptedProvider([
      { type: 'init', continuation: 'sess-1' },
      // Synthetic mid-turn signal — text gets dispatched, turn not acked yet.
      { type: 'result', text: 'Context compacted.' },
      // Real terminal result follows.
      { type: 'result', text: '<message to="x">all done</message>', subtype: 'success' },
    ]));

    await waitFor(() => getAckStatus('m1') === 'completed');
    await loop.stop();

    expect(getAckStatus('m1')).toBe('completed');
    const out = getUndeliveredMessages();
    // The compact-boundary text was dispatched mid-turn via the single-channel
    // shortcut to the originating chan-1/discord.
    const compactNote = out.find((m) => JSON.parse(m.content).text === 'Context compacted.');
    expect(compactNote).toBeTruthy();
    // No failure DM should be present.
    const failureNote = out.find((m) => JSON.parse(m.content).text?.includes('did not complete'));
    expect(failureNote).toBeUndefined();
  });
});
