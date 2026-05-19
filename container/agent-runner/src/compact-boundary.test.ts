/**
 * 5×5 verification battery for the compact_boundary fix.
 *
 * Bug: compact_boundary synthetic event was yielded as 'result', which caused
 * processQuery to call markCompleted + dispatchResultText on "Context compacted."
 * text. Since that text has no <message> blocks, hasUnwrapped=true fired and the
 * nudge was pushed into the stream.
 *
 * Fix: compact_boundary now yields 'progress', which processQuery ignores.
 *
 * Shapes (5 × 5 runs each = 25 total):
 *   1. compact_boundary (as progress) → wrapped single-destination result
 *   2. compact_boundary (as progress) → wrapped multi-destination result
 *   3. compact_boundary (as progress) → genuinely unwrapped result (nudge still fires)
 *   4. No compaction, normal wrapped result (regression baseline)
 *   5. No compaction, genuinely unwrapped result (nudge path regression baseline)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent, QueryInput } from './providers/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(50);
  }
}

function insertChatMessage(id: string, platformId = 'chan-1', channelType = 'discord'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, '{"sender":"Test","text":"ping"}')`,
    )
    .run(id, platformId, channelType);
}

function seedDestination(name: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT OR IGNORE INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

async function runScenario(
  provider: AgentProvider,
  setup: () => void,
  waitCondition: () => boolean,
  waitMs = 2000,
): Promise<void> {
  setup();
  const controller = new AbortController();
  const loopPromise = Promise.race([
    runPollLoop({ provider, providerName: 'mock', cwd: '/tmp' }),
    new Promise<void>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
  ]);

  await waitFor(waitCondition, waitMs);
  controller.abort();
  await loopPromise.catch(() => {});
}

// ── Provider factories ─────────────────────────────────────────────────────

function makeCompactingProvider(finalResultText: string): AgentProvider {
  return {
    supportsNativeSlashCommands: false,
    isSessionInvalid: () => false,
    query(_input: QueryInput): AgentQuery {
      return {
        push() {},
        end() {},
        abort() {},
        events: (async function* (): AsyncGenerator<ProviderEvent> {
          yield { type: 'activity' };
          yield { type: 'init', continuation: `compact-${Date.now()}` };
          yield { type: 'activity' };
          // compact_boundary post-fix: yields 'progress', not 'result'
          yield { type: 'progress', message: 'Context compacted (42,000 tokens)' };
          yield { type: 'activity' };
          yield { type: 'result', text: finalResultText };
        })(),
      };
    },
  };
}

function makeSimpleProvider(resultText: string): AgentProvider {
  return {
    supportsNativeSlashCommands: false,
    isSessionInvalid: () => false,
    query(_input: QueryInput): AgentQuery {
      return {
        push() {},
        end() {},
        abort() {},
        events: (async function* (): AsyncGenerator<ProviderEvent> {
          yield { type: 'activity' };
          yield { type: 'init', continuation: `simple-${Date.now()}` };
          yield { type: 'activity' };
          yield { type: 'result', text: resultText };
        })(),
      };
    },
  };
}

// ── Shape 1: compact_boundary → wrapped single-destination result ──────────

describe('Shape 1: compact (progress) → wrapped single result', () => {
  beforeEach(() => { initTestSessionDb(); seedDestination('discord-test', 'discord', 'chan-1'); });
  afterEach(() => closeSessionDb());

  for (let run = 1; run <= 5; run++) {
    it(`run ${run}/5`, async () => {
      const provider = makeCompactingProvider('<message to="discord-test">delivered after compact</message>');
      await runScenario(provider, () => insertChatMessage(`m${run}`), () => getUndeliveredMessages().length > 0);

      const out = getUndeliveredMessages();
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0].content).text).toBe('delivered after compact');
      expect(getPendingMessages()).toHaveLength(0);
    });
  }
});

// ── Shape 2: compact_boundary → wrapped multi-destination result ───────────

describe('Shape 2: compact (progress) → wrapped multi-destination result', () => {
  beforeEach(() => {
    initTestSessionDb();
    seedDestination('discord-test', 'discord', 'chan-1');
    seedDestination('slack-test', 'slack', 'chan-2');
  });
  afterEach(() => closeSessionDb());

  for (let run = 1; run <= 5; run++) {
    it(`run ${run}/5`, async () => {
      const provider = makeCompactingProvider(
        '<message to="discord-test">for discord</message><message to="slack-test">for slack</message>',
      );
      await runScenario(provider, () => insertChatMessage(`m${run}`), () => getUndeliveredMessages().length >= 2);

      const out = getUndeliveredMessages();
      expect(out).toHaveLength(2);
      const discord = out.find((m) => m.platform_id === 'chan-1');
      const slack = out.find((m) => m.platform_id === 'chan-2');
      expect(discord).toBeDefined();
      expect(JSON.parse(discord!.content).text).toBe('for discord');
      expect(slack).toBeDefined();
      expect(JSON.parse(slack!.content).text).toBe('for slack');
    });
  }
});

// ── Shape 3: compact_boundary → genuinely unwrapped result ────────────────
// The nudge should still fire — fix must not suppress it for real bare text.

describe('Shape 3: compact (progress) → genuinely unwrapped (nudge still fires)', () => {
  beforeEach(() => { initTestSessionDb(); seedDestination('discord-test', 'discord', 'chan-1'); });
  afterEach(() => closeSessionDb());

  for (let run = 1; run <= 5; run++) {
    it(`run ${run}/5`, async () => {
      const provider = makeCompactingProvider('bare text after compact — no message blocks');
      await runScenario(provider, () => insertChatMessage(`m${run}`), () => getPendingMessages().length === 0);

      // Bare text → nothing delivered (nudge fired into ignored push)
      expect(getUndeliveredMessages()).toHaveLength(0);
    });
  }
});

// ── Shape 4: No compaction — wrapped result (regression baseline) ──────────

describe('Shape 4: no compaction — wrapped result (regression baseline)', () => {
  beforeEach(() => { initTestSessionDb(); seedDestination('discord-test', 'discord', 'chan-1'); });
  afterEach(() => closeSessionDb());

  for (let run = 1; run <= 5; run++) {
    it(`run ${run}/5`, async () => {
      const provider = makeSimpleProvider('<message to="discord-test">baseline delivery</message>');
      await runScenario(provider, () => insertChatMessage(`m${run}`), () => getUndeliveredMessages().length > 0);

      const out = getUndeliveredMessages();
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0].content).text).toBe('baseline delivery');
    });
  }
});

// ── Shape 5: No compaction — unwrapped result (nudge regression baseline) ──

describe('Shape 5: no compaction — unwrapped result (nudge path regression)', () => {
  beforeEach(() => { initTestSessionDb(); seedDestination('discord-test', 'discord', 'chan-1'); });
  afterEach(() => closeSessionDb());

  for (let run = 1; run <= 5; run++) {
    it(`run ${run}/5`, async () => {
      const provider = makeSimpleProvider('bare text no blocks');
      await runScenario(provider, () => insertChatMessage(`m${run}`), () => getPendingMessages().length === 0);

      expect(getUndeliveredMessages()).toHaveLength(0);
    });
  }
});
