/**
 * Tests for the channel-completion polling loop.
 *
 * Exercises `runIteration` (one poll cycle) and `composeCompletionText`
 * directly — the long-running `runChannelCompletionLoop` is covered by
 * a single happy-path integration test that drives one tick via a
 * mocked fetch + interval.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { closeSessionDb, getOutboundDb, initTestSessionDb } from './db/connection.js';
import {
  composeCompletionText,
  pollOnce,
  runIteration,
  runChannelCompletionLoop,
} from './channel-completion-loop.js';
import {
  getChannelCompletionCursor,
  setChannelCompletionCursor,
} from './db/channel-completion-cursor.js';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_BASE = process.env.BAGET_API_BASE_URL;
const ORIGINAL_TOKEN = process.env.BAGET_CHANNEL_TOKEN;
const ORIGINAL_COMPANY = process.env.BAGET_COMPANY_ID;
const ORIGINAL_APP = process.env.BAGET_PUBLIC_APP_URL;

interface FetchCall {
  url: string;
  authHeader: string | null;
}

let fetchCalls: FetchCall[] = [];
let fetchResponder: () => Response = () =>
  new Response(JSON.stringify({ events: [], cursor: '2026-05-05T00:00:00.000Z' }), { status: 200 });

function installFetchSpy(): typeof fetch {
  fetchCalls = [];
  const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    fetchCalls.push({ url, authHeader: headers['Authorization'] ?? null });
    return fetchResponder();
  }) as typeof fetch;
  globalThis.fetch = spy;
  return spy;
}

beforeEach(() => {
  initTestSessionDb();
  process.env.BAGET_API_BASE_URL = 'https://stg-app.baget.ai';
  process.env.BAGET_CHANNEL_TOKEN = 'test-bearer';
  process.env.BAGET_COMPANY_ID = 'company-uuid-123';
  process.env.BAGET_PUBLIC_APP_URL = 'https://stg-app.baget.ai';
  installFetchSpy();
});

afterEach(() => {
  closeSessionDb();
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_BASE === undefined) delete process.env.BAGET_API_BASE_URL;
  else process.env.BAGET_API_BASE_URL = ORIGINAL_BASE;
  if (ORIGINAL_TOKEN === undefined) delete process.env.BAGET_CHANNEL_TOKEN;
  else process.env.BAGET_CHANNEL_TOKEN = ORIGINAL_TOKEN;
  if (ORIGINAL_COMPANY === undefined) delete process.env.BAGET_COMPANY_ID;
  else process.env.BAGET_COMPANY_ID = ORIGINAL_COMPANY;
  if (ORIGINAL_APP === undefined) delete process.env.BAGET_PUBLIC_APP_URL;
  else process.env.BAGET_PUBLIC_APP_URL = ORIGINAL_APP;
});

const TG_ROUTING = {
  channel_type: 'telegram' as const,
  platform_id: 'telegram:42',
  thread_id: null,
};

const ENV = {
  baseUrl: 'https://stg-app.baget.ai',
  token: 'test-bearer',
  companyId: 'company-uuid-123',
  appUrl: 'https://stg-app.baget.ai',
};

function makeEvent(overrides: Partial<{ id: string; createdAt: string; channelAction: string; taskId: string; taskOutcomeSummary: string }> = {}) {
  return {
    id: 'evt-1',
    createdAt: '2026-05-05T10:00:00.000Z',
    channelAction: 'edit-document',
    taskId: 'task-1',
    taskOutcomeSummary: "Done — rewrote 'Pitch Deck'",
    ...overrides,
  };
}

describe('composeCompletionText', () => {
  it('appends a dashboard link footer', () => {
    const text = composeCompletionText(makeEvent(), 'https://stg-app.baget.ai/dashboard/c-1');
    expect(text).toContain("Done — rewrote 'Pitch Deck'");
    expect(text).toContain('Open: https://stg-app.baget.ai/dashboard/c-1');
  });
});

describe('pollOnce', () => {
  it('calls the right URL with bearer auth', async () => {
    fetchResponder = () =>
      new Response(JSON.stringify({ events: [], cursor: '2026-05-05T00:00:00.000Z' }), {
        status: 200,
      });
    const result = await pollOnce({
      baseUrl: 'https://stg-app.baget.ai',
      token: 'test-bearer',
      companyId: 'c-1',
      cursorIso: '2026-05-05T00:00:00.000Z',
      fetchImpl: globalThis.fetch,
    });
    expect(result).not.toBeNull();
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(
      'https://stg-app.baget.ai/api/companies/c-1/channel-completions?since=2026-05-05T00%3A00%3A00.000Z&limit=20',
    );
    expect(fetchCalls[0]!.authHeader).toBe('Bearer test-bearer');
  });

  it('returns null on non-2xx', async () => {
    fetchResponder = () => new Response('unauthorized', { status: 401 });
    const result = await pollOnce({
      baseUrl: 'https://stg-app.baget.ai',
      token: 'bad',
      companyId: 'c-1',
      cursorIso: '2026-05-05T00:00:00.000Z',
      fetchImpl: globalThis.fetch,
    });
    expect(result).toBeNull();
  });

  it('returns null on bad JSON', async () => {
    fetchResponder = () => new Response('not json', { status: 200 });
    const result = await pollOnce({
      baseUrl: 'https://stg-app.baget.ai',
      token: 'test',
      companyId: 'c-1',
      cursorIso: '2026-05-05T00:00:00.000Z',
      fetchImpl: globalThis.fetch,
    });
    expect(result).toBeNull();
  });

  it('returns null on bad shape', async () => {
    fetchResponder = () => new Response(JSON.stringify({ events: 'oops' }), { status: 200 });
    const result = await pollOnce({
      baseUrl: 'https://stg-app.baget.ai',
      token: 'test',
      companyId: 'c-1',
      cursorIso: '2026-05-05T00:00:00.000Z',
      fetchImpl: globalThis.fetch,
    });
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    const failing: typeof fetch = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    const result = await pollOnce({
      baseUrl: 'https://stg-app.baget.ai',
      token: 'test',
      companyId: 'c-1',
      cursorIso: '2026-05-05T00:00:00.000Z',
      fetchImpl: failing,
    });
    expect(result).toBeNull();
  });
});

describe('runIteration', () => {
  it('skips polling and keeps cursor when routing is not telegram', async () => {
    let fetched = false;
    const fetchImpl: typeof fetch = async () => {
      fetched = true;
      return new Response('{}', { status: 200 });
    };
    const next = await runIteration({
      cursorIso: '2026-05-05T00:00:00.000Z',
      routing: { channel_type: null, platform_id: null, thread_id: null },
      env: ENV,
      fetchImpl,
    });
    expect(fetched).toBe(false);
    expect(next).toBe('2026-05-05T00:00:00.000Z');
  });

  it('skips polling when routing has no platform_id', async () => {
    let fetched = false;
    const fetchImpl: typeof fetch = async () => {
      fetched = true;
      return new Response('{}', { status: 200 });
    };
    const next = await runIteration({
      cursorIso: '2026-05-05T00:00:00.000Z',
      routing: { channel_type: 'telegram', platform_id: null, thread_id: null },
      env: ENV,
      fetchImpl,
    });
    expect(fetched).toBe(false);
    expect(next).toBe('2026-05-05T00:00:00.000Z');
  });

  it('runs on the production-shape channel_type "baget-telegram" (Bug #4 root cause guard)', async () => {
    // 2026-05-06: the real Baget Telegram adapter publishes
    // channel_type='baget-telegram' (BAGET_TELEGRAM_CHANNEL_TYPE), not
    // plain 'telegram'. The earlier `=== 'telegram'` guard ALWAYS
    // skipped on production routing, which is why no completion ping
    // ever fired despite worker enrichment + endpoint flag both being
    // green. Make sure the loop now runs on the production value.
    fetchResponder = () =>
      new Response(
        JSON.stringify({
          events: [makeEvent({ createdAt: '2026-05-05T09:00:00.000Z' })],
          cursor: '2026-05-05T09:00:00.000Z',
        }),
        { status: 200 },
      );

    const next = await runIteration({
      cursorIso: '2026-05-05T08:00:00.000Z',
      routing: { channel_type: 'baget-telegram', platform_id: 'baget-telegram:42', thread_id: null },
      env: ENV,
      fetchImpl: globalThis.fetch,
    });

    expect(next).toBe('2026-05-05T09:00:00.000Z');
    const rows = getOutboundDb()
      .prepare('SELECT COUNT(*) AS n FROM messages_out')
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('writes one outbound message per event and advances cursor', async () => {
    fetchResponder = () =>
      new Response(
        JSON.stringify({
          events: [
            makeEvent({ id: 'evt-A', createdAt: '2026-05-05T10:00:00.000Z' }),
            makeEvent({ id: 'evt-B', createdAt: '2026-05-05T10:05:00.000Z' }),
          ],
          cursor: '2026-05-05T10:05:00.000Z',
        }),
        { status: 200 },
      );

    const next = await runIteration({
      cursorIso: '2026-05-05T09:00:00.000Z',
      routing: TG_ROUTING,
      env: ENV,
      fetchImpl: globalThis.fetch,
    });

    expect(next).toBe('2026-05-05T10:05:00.000Z');

    const rows = getOutboundDb()
      .prepare('SELECT kind, platform_id, channel_type, content FROM messages_out ORDER BY seq ASC')
      .all() as Array<{ kind: string; platform_id: string; channel_type: string; content: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.kind).toBe('chat');
      expect(row.platform_id).toBe('telegram:42');
      expect(row.channel_type).toBe('telegram');
      const parsed = JSON.parse(row.content) as { text: string };
      expect(parsed.text).toContain("Done — rewrote 'Pitch Deck'");
      expect(parsed.text).toContain('Open: https://stg-app.baget.ai/dashboard/company-uuid-123');
    }
  });

  it('keeps cursor unchanged on poll failure (replays safely on next tick)', async () => {
    fetchResponder = () => new Response('boom', { status: 500 });
    const before = '2026-05-05T09:00:00.000Z';
    const next = await runIteration({
      cursorIso: before,
      routing: TG_ROUTING,
      env: ENV,
      fetchImpl: globalThis.fetch,
    });
    expect(next).toBe(before);
    const rows = getOutboundDb()
      .prepare('SELECT COUNT(*) AS n FROM messages_out')
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('advances cursor per-event so a mid-page abort does not skip undelivered events', async () => {
    // Codex P1 + Gemini High on PR #34: previously the loop returned
    // either the original `cursorIso` (rewind, → duplicate notifications
    // on retry because writeMessageOut generates fresh ids) or
    // `result.cursor` (advance past undelivered events on abort).
    // Per-event cursor advance returns the LAST SUCCESSFULLY DELIVERED
    // event's createdAt — server uses strict `>` so the next poll
    // resumes from the first undelivered event with no replays.
    fetchResponder = () =>
      new Response(
        JSON.stringify({
          events: [
            makeEvent({ id: 'A', createdAt: '2026-05-05T09:00:00.000Z' }),
            makeEvent({ id: 'B', createdAt: '2026-05-05T09:30:00.000Z' }),
            makeEvent({ id: 'C', createdAt: '2026-05-05T10:00:00.000Z' }),
          ],
          cursor: '2026-05-05T10:00:00.000Z',
        }),
        { status: 200 },
      );

    // Abort before iteration starts — full page returns the input cursor.
    const ac = new AbortController();
    ac.abort();
    const next = await runIteration({
      cursorIso: '2026-05-05T08:00:00.000Z',
      routing: TG_ROUTING,
      env: ENV,
      fetchImpl: globalThis.fetch,
      signal: ac.signal,
    });
    // pollOnce respects the abort and returns null → cursor unchanged.
    expect(next).toBe('2026-05-05T08:00:00.000Z');
  });

  it('URL-encodes companyId in the dashboard link footer (defensive)', async () => {
    fetchResponder = () =>
      new Response(
        JSON.stringify({
          events: [makeEvent({ createdAt: '2026-05-05T09:00:00.000Z' })],
          cursor: '2026-05-05T09:00:00.000Z',
        }),
        { status: 200 },
      );

    await runIteration({
      cursorIso: '2026-05-05T08:00:00.000Z',
      routing: TG_ROUTING,
      env: { ...ENV, companyId: 'co/with spaces' },
      fetchImpl: globalThis.fetch,
    });

    const row = getOutboundDb()
      .prepare('SELECT content FROM messages_out')
      .get() as { content: string };
    const parsed = JSON.parse(row.content) as { text: string };
    expect(parsed.text).toContain('/dashboard/co%2Fwith%20spaces');
  });

  it('URL-encodes companyId in the API URL (defensive)', async () => {
    fetchResponder = () =>
      new Response(JSON.stringify({ events: [], cursor: '2026-05-05T00:00:00.000Z' }), {
        status: 200,
      });
    await pollOnce({
      baseUrl: 'https://stg-app.baget.ai',
      token: 'test-bearer',
      companyId: 'co/with spaces',
      cursorIso: '2026-05-05T00:00:00.000Z',
      fetchImpl: globalThis.fetch,
    });
    expect(fetchCalls[0]!.url).toContain('/api/companies/co%2Fwith%20spaces/channel-completions');
  });

  it('writes events in the order returned (oldest-first per server contract)', async () => {
    fetchResponder = () =>
      new Response(
        JSON.stringify({
          events: [
            makeEvent({ id: 'old', createdAt: '2026-05-05T09:00:00.000Z' }),
            makeEvent({ id: 'new', createdAt: '2026-05-05T10:00:00.000Z' }),
          ],
          cursor: '2026-05-05T10:00:00.000Z',
        }),
        { status: 200 },
      );

    await runIteration({
      cursorIso: '2026-05-05T08:00:00.000Z',
      routing: TG_ROUTING,
      env: ENV,
      fetchImpl: globalThis.fetch,
    });

    // Outbound seq values are odd and monotonically increasing; reading
    // by ASC seq gives delivery order, which must match the order the
    // server returned (oldest-first).
    const rows = getOutboundDb()
      .prepare('SELECT seq FROM messages_out ORDER BY seq ASC')
      .all() as Array<{ seq: number }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq);
  });
});

describe('runChannelCompletionLoop', () => {
  it('returns immediately when env not configured', async () => {
    delete process.env.BAGET_CHANNEL_TOKEN;
    // Should resolve, not block
    await runChannelCompletionLoop();
  });

  it('seeds the cursor on first run', async () => {
    expect(getChannelCompletionCursor()).toBeUndefined();

    const ac = new AbortController();
    const fixedNow = new Date('2026-05-05T12:00:00.000Z');
    fetchResponder = () =>
      new Response(JSON.stringify({ events: [], cursor: fixedNow.toISOString() }), { status: 200 });

    // Abort before the first sleep completes — but after the seed.
    setTimeout(() => ac.abort(), 50);

    await runChannelCompletionLoop({
      signal: ac.signal,
      routingProvider: () => TG_ROUTING,
      fetchImpl: globalThis.fetch,
      intervalMs: 1_000_000, // long enough that the abort fires first
      nowProvider: () => fixedNow,
    });

    expect(getChannelCompletionCursor()).toBe(fixedNow.toISOString());
  });

  it('respects an existing cursor (no re-seed)', async () => {
    setChannelCompletionCursor('2026-05-04T00:00:00.000Z');

    const ac = new AbortController();
    fetchResponder = () =>
      new Response(JSON.stringify({ events: [], cursor: '2026-05-04T00:00:00.000Z' }), {
        status: 200,
      });

    setTimeout(() => ac.abort(), 50);

    await runChannelCompletionLoop({
      signal: ac.signal,
      routingProvider: () => TG_ROUTING,
      fetchImpl: globalThis.fetch,
      intervalMs: 1_000_000,
      nowProvider: () => new Date('2099-01-01T00:00:00.000Z'),
    });

    expect(getChannelCompletionCursor()).toBe('2026-05-04T00:00:00.000Z');
  });

  it('persists an advanced cursor after a successful tick', async () => {
    setChannelCompletionCursor('2026-05-05T08:00:00.000Z');

    fetchResponder = () =>
      new Response(
        JSON.stringify({
          events: [makeEvent({ createdAt: '2026-05-05T09:00:00.000Z' })],
          cursor: '2026-05-05T09:00:00.000Z',
        }),
        { status: 200 },
      );

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);

    await runChannelCompletionLoop({
      signal: ac.signal,
      routingProvider: () => TG_ROUTING,
      fetchImpl: globalThis.fetch,
      intervalMs: 1_000_000,
    });

    expect(getChannelCompletionCursor()).toBe('2026-05-05T09:00:00.000Z');
    const rows = getOutboundDb()
      .prepare('SELECT COUNT(*) AS n FROM messages_out')
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });
});
