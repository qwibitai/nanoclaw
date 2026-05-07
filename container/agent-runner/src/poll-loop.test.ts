import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getPendingMessages, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { formatMessages, extractRouting } from './formatter.js';
import { isAdmissibleTrigger, selectInTurnFollowUps } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(id: string, kind: string, content: object, opts?: { processAfter?: string; trigger?: 0 | 1 }) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
    )
    .run(id, kind, opts?.processAfter ?? null, opts?.trigger ?? 1, JSON.stringify(content));
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as XML block', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<messages>');
    expect(prompt).toContain('</messages>');
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('[SCHEDULED TASK]');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('[WEBHOOK: github/push]');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('[SYSTEM RESPONSE]');
    expect(prompt).toContain('register_group');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('[SYSTEM RESPONSE]');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('selectInTurnFollowUps: pure trigger=0 batch defers (no push)', () => {
    // The agent is mid-stream on an earlier turn — a non-mention shouldn't
    // interrupt thinking-blocks with content the bot wasn't addressed in.
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise during active turn' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'C', text: 'more noise' }, { trigger: 0 });
    expect(selectInTurnFollowUps(getPendingMessages())).toEqual([]);
  });

  it('selectInTurnFollowUps: trigger=0 chat rides along when batch contains a chat trigger=1', () => {
    // Warm-container regression: prior implementation dropped trigger=0
    // unconditionally in the in-turn filter, stranding accumulated context
    // whenever the next mention also arrived in-turn (long-lived container
    // that never cold-restarts). Agent saw the mention but lost prior context.
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier non-mention' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'mid-turn mention' }, { trigger: 1 });
    const ids = selectInTurnFollowUps(getPendingMessages())
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['m1', 'm2']);
  });

  it('selectInTurnFollowUps: /clear is not a real trigger — does not unlock trigger=0 ride-along', () => {
    // /clear is trigger=1 but excluded later in the loop (resets the
    // session). It must not gate trigger=0 context into the prompt — the
    // prompt would render only the context block and the /clear would be
    // handled separately. Defer until a real trigger arrives.
    insertMessage('m1', 'chat', { sender: 'A', text: 'old non-mention' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: '/clear' }, { trigger: 1 });
    expect(selectInTurnFollowUps(getPendingMessages())).toEqual([]);
  });

  it('selectInTurnFollowUps: non-recall system row trigger=1 does not unlock trigger=0', () => {
    // System rows (other than recall_context) are dropped by the filter —
    // they should not gate trigger=0 ride-along either.
    insertMessage('m1', 'chat', { sender: 'A', text: 'context' }, { trigger: 0 });
    insertMessage('s1', 'system', { subtype: 'something_else' }, { trigger: 1 });
    expect(selectInTurnFollowUps(getPendingMessages())).toEqual([]);
  });

  it('selectInTurnFollowUps: trigger=0 task rows do NOT ride along — only chat/chat-sdk do', () => {
    // The original `m.trigger !== 1` guard rejected trigger=0 of any kind.
    // The new ride-along is restricted to chat/chat-sdk; tasks and webhooks
    // still gate on their own trigger=1.
    insertMessage('m1', 'chat', { sender: 'B', text: 'mention' }, { trigger: 1 });
    insertMessage('t1', 'task', { script: 'noop', wakeAgent: false }, { trigger: 0 });
    const ids = selectInTurnFollowUps(getPendingMessages()).map((m) => m.id);
    expect(ids).toEqual(['m1']);
  });

  it('selectInTurnFollowUps: chat-sdk parity — trigger=0 chat-sdk rides along like chat', () => {
    insertMessage('m1', 'chat-sdk', { sender: 'A', text: 'context' }, { trigger: 0 });
    insertMessage('m2', 'chat-sdk', { sender: 'B', text: 'mention' }, { trigger: 1 });
    const ids = selectInTurnFollowUps(getPendingMessages())
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['m1', 'm2']);
  });

  it('selectInTurnFollowUps: trigger=0 webhook does NOT ride — only chat/chat-sdk do', () => {
    insertMessage('m1', 'chat', { sender: 'B', text: 'mention' }, { trigger: 1 });
    insertMessage('w1', 'webhook', { url: '/x' }, { trigger: 0 });
    const ids = selectInTurnFollowUps(getPendingMessages()).map((m) => m.id);
    expect(ids).toEqual(['m1']);
  });

  it('selectInTurnFollowUps: malformed recall content/id is dropped, not crashed on', () => {
    insertMessage('m1', 'chat', { sender: 'B', text: 'mention' }, { trigger: 1 });
    // Not JSON
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
         VALUES ('s-bad', 'system', datetime('now'), 'pending', 0, 'not-json')`,
      )
      .run();
    // Recall-shaped but no recall- prefix
    insertMessage('s-noprefix', 'system', { subtype: 'recall_context', text: 'x' }, { trigger: 0 });
    const ids = selectInTurnFollowUps(getPendingMessages()).map((m) => m.id);
    expect(ids).toEqual(['m1']);
  });

  it('selectInTurnFollowUps: /clear alongside a real mention — /clear excluded, real batch admitted', () => {
    insertMessage('clr', 'chat', { sender: 'A', text: '/clear' }, { trigger: 1 });
    insertMessage('ctx', 'chat', { sender: 'B', text: 'old context' }, { trigger: 0 });
    insertMessage('real', 'chat', { sender: 'C', text: 'hey @bot' }, { trigger: 1 });
    const ids = selectInTurnFollowUps(getPendingMessages())
      .map((m) => m.id)
      .sort();
    // /clear stays out; the real batch (real + ctx) goes through.
    expect(ids).toEqual(['ctx', 'real']);
  });

  it('isAdmissibleTrigger: returns true only for non-system, non-/clear, trigger=1 rows', () => {
    insertMessage('a', 'chat', { sender: 'A', text: 'hi' }, { trigger: 1 });
    insertMessage('b', 'chat', { sender: 'A', text: '/clear' }, { trigger: 1 });
    insertMessage('c', 'chat', { sender: 'A', text: 'ctx' }, { trigger: 0 });
    insertMessage('d', 'system', { subtype: 'something' }, { trigger: 1 });
    insertMessage('e', 'task', { name: 'cron' }, { trigger: 1 });
    const byId = Object.fromEntries(getPendingMessages().map((m) => [m.id, m]));
    expect(isAdmissibleTrigger(byId.a)).toBe(true);
    expect(isAdmissibleTrigger(byId.b)).toBe(false);
    expect(isAdmissibleTrigger(byId.c)).toBe(false);
    expect(isAdmissibleTrigger(byId.d)).toBe(false);
    expect(isAdmissibleTrigger(byId.e)).toBe(true);
  });

  it('selectInTurnFollowUps: recall_context only rides when paired trigger is admitted', () => {
    // Pair admission must be checked against the post-filter trigger set,
    // not the raw snapshot. /clear's id should NOT satisfy a recall pair.
    insertMessage('clear-id', 'chat', { sender: 'B', text: '/clear' }, { trigger: 1 });
    insertMessage('recall-clear-id', 'system', { subtype: 'recall_context', text: 'facts' }, {
      trigger: 0,
    });
    expect(selectInTurnFollowUps(getPendingMessages())).toEqual([]);

    // But a recall paired with a real trigger does ride along.
    insertMessage('real-mention', 'chat', { sender: 'B', text: 'hey @bot' }, { trigger: 1 });
    insertMessage('recall-real-mention', 'system', { subtype: 'recall_context', text: 'facts' }, {
      trigger: 0,
    });
    const ids = selectInTurnFollowUps(getPendingMessages())
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['real-mention', 'recall-real-mention']);
  });

  it('getPendingMessages: orphan recall-X is dropped when paired trigger X is in processing_ack', () => {
    // The host writes recall-X paired to inbound row X. If X is a /clear
    // (handled and markCompleted'd inline by the runner) or a task gated
    // by pre-task script, X gets a 'completed' processing_ack but recall-X
    // never does. Without the orphan drain, recall-X would surface as a
    // standalone "[Recalled context]" prompt with no user message on the
    // next cold-start iteration.
    insertMessage('X', 'chat', { sender: 'A', text: '/clear' }, { trigger: 1 });
    insertMessage('recall-X', 'system', { subtype: 'recall_context', text: 'facts' }, { trigger: 0 });
    insertMessage('Y', 'chat', { sender: 'B', text: 'hey @bot' }, { trigger: 1 });
    // Simulate X being completed (as the /clear handler would do).
    markCompleted(['X']);
    const ids = getPendingMessages()
      .map((m) => m.id)
      .sort();
    // recall-X must be gone; Y is still pending.
    expect(ids).toEqual(['Y']);
  });

  it('getPendingMessages: orphan recall-X is dropped when paired trigger X has a messages_out reply', () => {
    // The respondedIds idempotency guard treats X as completed if the
    // agent already wrote a reply. recall-X must drain on this signal too.
    insertMessage('X', 'chat', { sender: 'A', text: 'old mention' }, { trigger: 1 });
    insertMessage('recall-X', 'system', { subtype: 'recall_context', text: 'facts' }, { trigger: 0 });
    getInboundDb()
      // Use raw INSERT so we don't trigger the markCompleted helper here.
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, content)
         VALUES ('Y', 'chat', datetime('now'), 'pending', 1, '{"text":"hi"}')`,
      )
      .run();
    // Simulate the agent having replied to X already.
    getOutboundDb()
      .prepare(
        `INSERT INTO messages_out (id, kind, timestamp, in_reply_to, content)
         VALUES ('out-1', 'chat', datetime('now'), 'X', '{"text":"replied"}')`,
      )
      .run();
    const ids = getPendingMessages()
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['Y']);
  });

  it('getPendingMessages: legitimate paired recall-X + X both still returned (no false positive drain)', () => {
    // The drain only fires when X is acked or replied-to. A normal pair
    // with both rows still pending must come through untouched.
    insertMessage('X', 'chat', { sender: 'B', text: 'hey @bot' }, { trigger: 1 });
    insertMessage('recall-X', 'system', { subtype: 'recall_context', text: 'facts' }, { trigger: 0 });
    const ids = getPendingMessages()
      .map((m) => m.id)
      .sort();
    expect(ids).toEqual(['X', 'recall-X']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });

  it('skips system rows (recall_context) when picking the routing anchor', () => {
    // recall_context is inserted before its paired inbound message and would
    // otherwise hijack inReplyTo, making outbound replies attach to recall-X
    // instead of the real user message X.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('recall-m1', 'system', datetime('now', '-1 second'), 'pending', NULL, NULL, NULL,
               '{"subtype":"recall_context","facts":[]}')`,
      )
      .run();
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.inReplyTo).toBe('m1');
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
  });

  it('treats platform_id-set + thread_id-null as authoritative (no session_routing fallback)', () => {
    // Daily background tasks (wiki-synthesise) are scheduled with
    // destination={platformId, channelType, threadId:null} so the report
    // posts to the channel root. A wake triggered by a thread chat earlier
    // populates session_routing with that thread, but the task's explicit
    // null thread_id MUST NOT be overridden by the session's thread.
    // (Real-world manifestation: madison-reed synth on 2026-05-01 scheduled
    // for discord channel root, landed in a stale session thread because
    // the prior `??` fallback treated null as "missing".)
    const db = getInboundDb();
    // session_routing isn't part of initTestSessionDb's schema; create it
    // inline with the same structure src/session-manager.ts writes in
    // production (CREATE TABLE happens on first writeSessionRouting call).
    db.prepare(
      `CREATE TABLE IF NOT EXISTS session_routing (
         id INTEGER PRIMARY KEY,
         channel_type TEXT,
         platform_id TEXT,
         thread_id TEXT
       )`,
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id)
       VALUES (1, 'slack', 'slack:C123', 'slack:C123:thread-from-prior-wake')`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('synth-1', 'task', datetime('now'), 'pending', 'discord:G:C', 'discord', NULL,
               '{"prompt":"synth","quietStatus":true}')`,
    ).run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('discord:G:C');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBeNull(); // NOT 'slack:C123:thread-from-prior-wake'
  });

  it('falls back to session_routing per-field when message has no platform_id (a-to-a case)', () => {
    // Agent-to-agent inbounds carry channel_type='agent' but no platform_id
    // (the message originates from another agent, not a Slack/Discord
    // channel). The reply still needs to route to the session's home
    // channel/thread, so fall back to session_routing for all three fields.
    const db = getInboundDb();
    db.prepare(
      `CREATE TABLE IF NOT EXISTS session_routing (
         id INTEGER PRIMARY KEY,
         channel_type TEXT,
         platform_id TEXT,
         thread_id TEXT
       )`,
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id)
       VALUES (1, 'slack', 'slack:C123', 'slack:C123:home-thread')`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('a2a-1', 'chat', datetime('now'), 'pending', NULL, 'agent', NULL,
               '{"sender":"sibling-agent","text":"hi"}')`,
    ).run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('slack:C123');
    expect(routing.channelType).toBe('slack');
    expect(routing.threadId).toBe('slack:C123:home-thread');
  });

  it('task in batch dominates routing — chat-row thread does not hijack', () => {
    // A scheduled task fires while an older chat row from a thread is still
    // pending in the batch (host hadn't synced processing_ack yet, or the
    // container restarted and clearStaleProcessingAcks wiped its claim, and
    // the prior turn's outbound didn't set in_reply_to so respondedIds didn't
    // catch the chat). Without task-row priority, extractRouting picks the
    // older chat row as `first` and the task's reply lands in that thread
    // instead of the channel root.
    //
    // Real-world manifestation: 2026-05-07, illyse Slack agent — every */15
    // task fired into the originating thread instead of #agents-xzo root.
    const db = getInboundDb();
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('chat-old', 2, 'chat-sdk', datetime('now', '-1 hour'), 'pending',
               'slack:C0AJA89MN2E', 'slack-illysium',
               'slack:C0AJA89MN2E:1778100372.246009',
               '{"text":"original user request that opened the thread"}')`,
    ).run();
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('task-new', 4, 'task', datetime('now'), 'pending',
               'slack:C0AJA89MN2E', 'slack-illysium', NULL,
               '{"prompt":"poll inbox"}')`,
    ).run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.inReplyTo).toBe('task-new');
    expect(routing.threadId).toBeNull();
    expect(routing.platformId).toBe('slack:C0AJA89MN2E');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

describe('processQuery done-flag invariant (codex F4 regression guard)', () => {
  it('result handler does NOT flip done — provider stream stays open across turns', async () => {
    // Codex F4 (2026-05-05): a prior commit set `done = true` synchronously
    // inside the `event.type === 'result'` branch. The polling interval
    // gates on `done`, so flipping it after the first result starved every
    // follow-up trigger=1 row in the session — the host wouldn't wake a
    // second container (this one was still running) and there was no
    // processing claim, so recovery fell back to the 30-min absolute
    // heartbeat ceiling. The provider's events generator stays open until
    // explicit `query.end()`/abort (see container/agent-runner/src/providers/
    // claude.ts:1080); only the outer for-await returning should flip
    // `done`. This guard catches re-introduction of the synchronous flip.
    const fs = await import('fs');
    const src = fs.readFileSync(new URL('./poll-loop.ts', import.meta.url), 'utf8');
    const lines = src.split('\n');
    // Anchor on `markCompleted(initialBatchIds);` — the only call site is
    // inside the result handler (other completion paths use `markCompleted(skipped)`
    // or `markCompleted(keptIds)`). The 20 lines BEFORE this anchor are
    // the result-handler body up to the `} else if (event.type === 'result') {`
    // line. Anywhere in that window flipping `done` is the regression.
    const anchorIdx = lines.findIndex((l) => l.includes('markCompleted(initialBatchIds)'));
    expect(anchorIdx).toBeGreaterThan(-1);
    const handlerWindow = lines.slice(Math.max(0, anchorIdx - 20), anchorIdx + 1).join('\n');
    // Strip line comments before the regression check so the explanatory
    // comment naming the prohibited code doesn't itself trip the assertion.
    const codeOnly = handlerWindow
      .split('\n')
      .map((l) => {
        const i = l.indexOf('//');
        return i >= 0 ? l.slice(0, i) : l;
      })
      .join('\n');
    expect(codeOnly).not.toContain('done = true');
  });
});
