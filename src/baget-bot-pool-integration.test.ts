/**
 * Integration tests for the bot-pool ↔ bind handler ↔ deliver()
 * lifecycle introduced by the multi-company bot rollout.
 *
 * Coverage matrix (one `describe` per concern):
 *   - registerTelegramWebhook helper: happy + telegram-error + throw
 *   - setBotDisplayName helper: happy + 429 rate-limit graceful
 *   - bind-telegram pool path: assigned, webhook registered, response
 *     includes botUsername, welcome rides per-company token
 *   - bind-telegram pool exhaustion: 503
 *   - bind-telegram idempotent re-bind: same assignment reused, no
 *     fresh setWebhook
 *   - bind-telegram legacy path: no pool seeded, falls back to global
 *     cfg.telegramBotToken, response omits botUsername
 *   - per-bot webhook route: matching secret routes through, wrong
 *     secret returns 401, unknown username returns 401
 *   - disconnect releases the assigned bot back to the pool
 *   - by-tuple GET response includes botUsername when assigned
 *
 * A few cases (deliver outbound token resolution, per-bot route
 * auth flow) live as separate `describe` blocks at the bottom so a
 * regression in one area doesn't cause a cascade of unrelated test
 * failures.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBagetAdminServer } from './baget-admin-server.js';
import { buildPerBotWebhookUrl, registerTelegramWebhook, setBotDisplayName } from './channels/baget-telegram-bind.js';
import { _testBuildBagetTelegramAdapter } from './channels/baget-telegram.js';
import {
  countAvailableBots,
  getBotPoolEntryByAgentGroup,
  getBotPoolEntryByUsername,
  seedBotPoolEntry,
} from './db/baget-bot-pool.js';
import { closeDb, getDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import type { ChannelSetup, OutboundMessage } from './channels/adapter.js';

const ADMIN_TOKEN = 'test-admin-token-1234567890abcdef';
const PUBLIC_BASE_URL = 'https://nanoclaw.test.example';

interface BindTelegramResp {
  ok: boolean;
  error?: string;
  message?: string;
  agentGroupId?: string;
  folder?: string;
  messagingGroupCreated?: boolean;
  welcomeMessageDelivered?: boolean;
  founderActionRequired?: boolean;
  telegramOpenUrl?: string;
  botUsername?: string;
}

interface ByTupleResp {
  ok: boolean;
  paired: boolean;
  agentGroupId?: string;
  platformChatId?: string;
  botUsername?: string;
}

/**
 * Build a fetch impl that captures every call and dispatches based on
 * URL pattern. Each test wires its own routes; the default handler
 * returns 404 so an unexpected call surfaces loudly in assertions.
 */
type FetchCall = { url: string; method: string; body: unknown };
type FetchHandler = (call: FetchCall) => Response | Promise<Response>;
function buildFetchMock(routes: Array<{ match: (url: string) => boolean; handler: FetchHandler }>) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = undefined;
    if (init?.body) {
      const raw = String(init.body);
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const call: FetchCall = { url, method, body };
    calls.push(call);
    for (const route of routes) {
      if (route.match(url)) return route.handler(call);
    }
    return new Response('unhandled', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ───────────────────────────────────────────────────────────────────
// Helper unit tests
// ───────────────────────────────────────────────────────────────────

describe('buildPerBotWebhookUrl', () => {
  it('builds the canonical per-bot webhook URL', () => {
    expect(buildPerBotWebhookUrl({ publicBaseUrl: 'https://host.test', botUsername: 'foo_bot' })).toBe(
      'https://host.test/api/channels/telegram/bot/foo_bot/webhook',
    );
  });

  it('strips trailing slashes from publicBaseUrl', () => {
    // Operators paste with / without trailing slash. The route layer
    // doesn't tolerate `//api/...`, so we normalize at construction.
    expect(buildPerBotWebhookUrl({ publicBaseUrl: 'https://host.test/', botUsername: 'foo_bot' })).toBe(
      'https://host.test/api/channels/telegram/bot/foo_bot/webhook',
    );
  });

  it('encodes the username defensively', () => {
    // Telegram bot usernames are constrained to [A-Za-z0-9_], but we
    // encode anyway so a future char-set expansion (or operator junk)
    // can't break the route matcher with `?`/`#`.
    expect(buildPerBotWebhookUrl({ publicBaseUrl: 'https://h.t', botUsername: 'a/b?c' })).toBe(
      'https://h.t/api/channels/telegram/bot/a%2Fb%3Fc/webhook',
    );
  });
});

describe('registerTelegramWebhook', () => {
  it('returns ok:true on Telegram 200/{ok:true}', async () => {
    const { fetchImpl, calls } = buildFetchMock([
      {
        match: (u) => u.endsWith('/setWebhook'),
        handler: () => okResponse({ ok: true, result: true, description: 'Webhook was set' }),
      },
    ]);
    const result = await registerTelegramWebhook({
      botToken: 'tok-abc',
      webhookUrl: 'https://example.test/api/channels/telegram/bot/foo/webhook',
      webhookSecret: 'sec-1234',
      apiBaseUrl: 'https://api.telegram.test',
      fetchImpl,
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.telegram.test/bottok-abc/setWebhook');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      url: 'https://example.test/api/channels/telegram/bot/foo/webhook',
      secret_token: 'sec-1234',
      allowed_updates: ['message', 'edited_message', 'callback_query'],
    });
  });

  it('returns ok:false with reason on Telegram error response', async () => {
    const { fetchImpl } = buildFetchMock([
      {
        match: (u) => u.endsWith('/setWebhook'),
        handler: () => okResponse({ ok: false, description: 'Bad Request: invalid url' }, 400),
      },
    ]);
    const result = await registerTelegramWebhook({
      botToken: 'tok',
      webhookUrl: 'broken',
      webhookSecret: 'sec',
      apiBaseUrl: 'https://api.telegram.test',
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('telegram_setWebhook_failed');
      expect(result.telegramErrorCode).toBe(400);
      expect(result.telegramDescription).toContain('invalid url');
    }
  });

  it('returns ok:false on transport throw without propagating', async () => {
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;
    const result = await registerTelegramWebhook({
      botToken: 'tok',
      webhookUrl: 'x',
      webhookSecret: 'sec',
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('telegram_setWebhook_threw');
      expect(result.telegramDescription).toBe('connection refused');
    }
  });
});

describe('setBotDisplayName', () => {
  it('POSTs setMyName with the company name and returns ok on success', async () => {
    const { fetchImpl, calls } = buildFetchMock([
      {
        match: (u) => u.endsWith('/setMyName'),
        handler: () => okResponse({ ok: true, result: true }),
      },
    ]);
    const result = await setBotDisplayName({
      botToken: 'tok',
      displayName: 'Acme Team',
      apiBaseUrl: 'https://api.telegram.test',
      fetchImpl,
    });
    expect(result).toEqual({ ok: true });
    expect(calls[0]!.body).toEqual({ name: 'Acme Team' });
  });

  it('treats Telegram 429 as rate-limited (separate reason for callers to ignore)', async () => {
    // Telegram allows 1 setMyName per minute per bot. Re-binding the
    // same group within that window is normal; callers downgrade
    // 'telegram_rate_limited' to a no-op rather than warning. Pin
    // the reason string so a future helper rewrite doesn't quietly
    // drop the distinction.
    const { fetchImpl } = buildFetchMock([
      {
        match: (u) => u.endsWith('/setMyName'),
        handler: () => okResponse({ ok: false, description: 'Too Many Requests' }, 429),
      },
    ]);
    const result = await setBotDisplayName({
      botToken: 'tok',
      displayName: 'Acme Team',
      apiBaseUrl: 'https://api.telegram.test',
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('telegram_rate_limited');
      expect(result.telegramErrorCode).toBe(429);
    }
  });

  it('clamps a 100-char company name to 64 chars before sending', async () => {
    const { fetchImpl, calls } = buildFetchMock([
      {
        match: (u) => u.endsWith('/setMyName'),
        handler: () => okResponse({ ok: true }),
      },
    ]);
    const longName = 'a'.repeat(100);
    await setBotDisplayName({
      botToken: 'tok',
      displayName: longName,
      apiBaseUrl: 'https://api.telegram.test',
      fetchImpl,
    });
    expect((calls[0]!.body as { name: string }).name).toHaveLength(64);
  });
});

// ───────────────────────────────────────────────────────────────────
// Bind handler — pool ↔ legacy precedence + Telegram side-effects
// ───────────────────────────────────────────────────────────────────

interface BindServer {
  baseUrl: string;
  close: () => Promise<void>;
  fetchCalls: () => FetchCall[];
}

async function startBindServer(opts: {
  publicBaseUrl?: string;
  telegramBotToken?: string;
  telegramRoutes: Array<{ match: (url: string) => boolean; handler: FetchHandler }>;
  generateAgentGroupId?: () => string;
}): Promise<BindServer> {
  const port = 36000 + Math.floor(Math.random() * 1500);
  const baseUrl = `http://127.0.0.1:${port}`;
  const { fetchImpl, calls } = buildFetchMock(opts.telegramRoutes);
  const server = createBagetAdminServer({
    port,
    adminToken: ADMIN_TOKEN,
    telegramBotUsername: 'baget_global_bot',
    telegramBotToken: opts.telegramBotToken,
    publicBaseUrl: opts.publicBaseUrl,
    telegramApiBaseUrl: 'https://api.telegram.test',
    telegramFetchImpl: fetchImpl,
    generateAgentGroupId: opts.generateAgentGroupId ?? (() => `ag-${Math.random().toString(36).slice(2, 10)}`),
  });
  await server.listen();
  return {
    baseUrl,
    close: () => server.close(),
    fetchCalls: () => calls,
  };
}

const VALID_BIND_BODY = {
  userId: 'user-bind-1',
  companyId: 'company-bind-1',
  companyName: 'Acme',
  teamMembers: { cos: 'Louis' },
  channelTokenCredentialName: 'cred-bind-1',
  bagetApiBaseUrl: 'https://app.baget.ai',
  telegramUserId: 555000111,
  telegramFirstName: 'Sam',
};

async function postBind(
  baseUrl: string,
  body: unknown = VALID_BIND_BODY,
): Promise<{ status: number; json: BindTelegramResp }> {
  const resp = await fetch(`${baseUrl}/baget/agent-groups/bind-telegram`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, json: (await resp.json()) as BindTelegramResp };
}

describe('handleBindTelegram — pool path', () => {
  let server: BindServer | null = null;

  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });

  afterEach(async () => {
    await server?.close();
    closeDb();
    server = null;
  });

  it('assigns a pool bot, registers per-bot webhook + setMyName, sends welcome from the per-company token, and returns botUsername', async () => {
    seedBotPoolEntry({
      botUsername: 'acme_bot',
      botTokenValue: 'tok-acme-001',
      webhookSecret: 'sec-acme-001',
      createdAt: new Date().toISOString(),
    });

    server = await startBindServer({
      publicBaseUrl: PUBLIC_BASE_URL,
      // Intentionally NO global token — this confirms pool > global
      // and that the welcome rides the per-company token, not a
      // fall-through to a global default.
      telegramRoutes: [
        {
          match: (u) => u.endsWith('/setWebhook'),
          handler: () => okResponse({ ok: true, result: true }),
        },
        {
          match: (u) => u.endsWith('/setMyName'),
          handler: () => okResponse({ ok: true, result: true }),
        },
        {
          match: (u) => u.endsWith('/sendMessage'),
          handler: () => okResponse({ ok: true, result: { message_id: 9001 } }),
        },
      ],
      generateAgentGroupId: () => 'ag-pool-bind',
    });

    const { status, json } = await postBind(server.baseUrl);
    expect(status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      agentGroupId: 'ag-pool-bind',
      messagingGroupCreated: true,
      welcomeMessageDelivered: true,
      founderActionRequired: false,
      telegramOpenUrl: 'https://t.me/acme_bot',
      botUsername: 'acme_bot',
    });

    const calls = server.fetchCalls();
    // Order: setWebhook → setMyName → sendMessage. All routed through
    // the per-company token (tok-acme-001), NOT the (absent) global.
    const tokens = calls.map((c) => /\/bot([^/]+)\//.exec(c.url)?.[1]);
    expect(tokens).toEqual(['tok-acme-001', 'tok-acme-001', 'tok-acme-001']);
    expect(calls[0]!.url).toContain('/setWebhook');
    expect((calls[0]!.body as Record<string, unknown>).url).toBe(
      `${PUBLIC_BASE_URL}/api/channels/telegram/bot/acme_bot/webhook`,
    );
    expect((calls[0]!.body as Record<string, unknown>).secret_token).toBe('sec-acme-001');
    expect(calls[1]!.url).toContain('/setMyName');
    expect((calls[1]!.body as Record<string, unknown>).name).toBe('Acme Team');

    // DB state: assignment landed, webhook_registered_at stamped.
    const entry = getBotPoolEntryByAgentGroup('ag-pool-bind');
    expect(entry).toBeDefined();
    expect(entry?.bot_username).toBe('acme_bot');
    expect(entry?.assigned_agent_group_id).toBe('ag-pool-bind');
    expect(entry?.webhook_registered_at).toBeTruthy();
  });

  it('returns 503 pool_exhausted when the pool is empty AND no global token configured', async () => {
    server = await startBindServer({
      publicBaseUrl: PUBLIC_BASE_URL,
      telegramRoutes: [],
    });
    const { status, json } = await postBind(server.baseUrl);
    expect(status).toBe(503);
    expect(json.error).toBe('pool_exhausted');
    // The spec mandates a clear operator-actionable message so the
    // dashboard can surface "ask the operator to seed more bots"
    // rather than a generic 503.
    expect(json.message).toMatch(/seed/i);
  });

  it('idempotent re-bind reuses the existing pool assignment and skips setWebhook on the second bind', async () => {
    seedBotPoolEntry({
      botUsername: 'acme_bot_re',
      botTokenValue: 'tok-re-001',
      webhookSecret: 'sec-re-001',
      createdAt: new Date().toISOString(),
    });

    let setWebhookCalls = 0;
    let setMyNameCalls = 0;
    let sendMessageCalls = 0;

    server = await startBindServer({
      publicBaseUrl: PUBLIC_BASE_URL,
      telegramRoutes: [
        {
          match: (u) => u.endsWith('/setWebhook'),
          handler: () => {
            setWebhookCalls++;
            return okResponse({ ok: true });
          },
        },
        {
          match: (u) => u.endsWith('/setMyName'),
          handler: () => {
            setMyNameCalls++;
            return okResponse({ ok: true });
          },
        },
        {
          match: (u) => u.endsWith('/sendMessage'),
          handler: () => {
            sendMessageCalls++;
            return okResponse({ ok: true, result: { message_id: 1 } });
          },
        },
      ],
      generateAgentGroupId: () => 'ag-re-bind',
    });

    const r1 = await postBind(server.baseUrl);
    expect(r1.json.botUsername).toBe('acme_bot_re');
    expect(setWebhookCalls).toBe(1);

    const r2 = await postBind(server.baseUrl);
    expect(r2.json.botUsername).toBe('acme_bot_re');
    // Second bind: webhook_registered_at is now set, so setWebhook
    // is skipped. setMyName fires every bind (rate-limit handled
    // gracefully). sendMessage fires every bind (welcome).
    expect(setWebhookCalls).toBe(1);
    expect(setMyNameCalls).toBe(2);
    expect(sendMessageCalls).toBe(2);

    // The same bot still serves the same agent_group.
    expect(getBotPoolEntryByAgentGroup('ag-re-bind')?.bot_username).toBe('acme_bot_re');
    // No new bots were assigned.
    expect(countAvailableBots()).toBe(0);
  });

  it('does NOT roll back the bind on setWebhook failure — leaves webhook_registered_at NULL for retry', async () => {
    seedBotPoolEntry({
      botUsername: 'acme_bot_wf',
      botTokenValue: 'tok-wf-001',
      webhookSecret: 'sec-wf-001',
      createdAt: new Date().toISOString(),
    });

    server = await startBindServer({
      publicBaseUrl: PUBLIC_BASE_URL,
      telegramRoutes: [
        {
          match: (u) => u.endsWith('/setWebhook'),
          handler: () => okResponse({ ok: false, description: 'Internal server error' }, 500),
        },
        {
          match: (u) => u.endsWith('/setMyName'),
          handler: () => okResponse({ ok: true }),
        },
        {
          match: (u) => u.endsWith('/sendMessage'),
          handler: () => okResponse({ ok: true, result: { message_id: 1 } }),
        },
      ],
      generateAgentGroupId: () => 'ag-wf-bind',
    });

    const { json } = await postBind(server.baseUrl);
    // Bind STILL succeeds — pool assignment + chat wiring + welcome
    // all landed; only setWebhook failed best-effort.
    expect(json.ok).toBe(true);
    expect(json.botUsername).toBe('acme_bot_wf');
    expect(getBotPoolEntryByAgentGroup('ag-wf-bind')?.webhook_registered_at).toBeNull();
  });
});

describe('handleBindTelegram — legacy global-bot path', () => {
  let server: BindServer | null = null;

  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });

  afterEach(async () => {
    await server?.close();
    closeDb();
    server = null;
  });

  it('falls back to global token when pool is empty AND global token is configured; response omits botUsername', async () => {
    server = await startBindServer({
      publicBaseUrl: PUBLIC_BASE_URL,
      telegramBotToken: 'tok-global-legacy',
      telegramRoutes: [
        // No setWebhook / setMyName expected on legacy path — only
        // sendMessage for the welcome.
        {
          match: (u) => u.endsWith('/sendMessage'),
          handler: () => okResponse({ ok: true, result: { message_id: 42 } }),
        },
      ],
      generateAgentGroupId: () => 'ag-legacy-1',
    });

    const { status, json } = await postBind(server.baseUrl);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.botUsername).toBeUndefined();
    expect(json.telegramOpenUrl).toBe('https://t.me/baget_global_bot');

    const calls = server.fetchCalls();
    expect(calls).toHaveLength(1); // ONLY sendMessage, no setWebhook / setMyName
    expect(calls[0]!.url).toContain('/bottok-global-legacy/sendMessage');
    expect(getBotPoolEntryByAgentGroup('ag-legacy-1')).toBeUndefined();
  });

  it("skips per-bot setWebhook when publicBaseUrl is unset (operator hasn't opted into pool mode)", async () => {
    seedBotPoolEntry({
      botUsername: 'acme_bot_no_url',
      botTokenValue: 'tok-no-url',
      webhookSecret: 'sec-no-url',
      createdAt: new Date().toISOString(),
    });

    server = await startBindServer({
      // publicBaseUrl deliberately omitted — pool is seeded but the
      // operator hasn't set BAGET_PUBLIC_BASE_URL. Bind still uses
      // the per-company token (better than nothing) but skips
      // setWebhook because we don't know the URL to register.
      telegramRoutes: [
        {
          match: (u) => u.endsWith('/sendMessage'),
          handler: () => okResponse({ ok: true, result: { message_id: 7 } }),
        },
      ],
      generateAgentGroupId: () => 'ag-no-url',
    });

    const { json } = await postBind(server.baseUrl);
    expect(json.ok).toBe(true);
    expect(json.botUsername).toBe('acme_bot_no_url');

    // Only sendMessage fired — no setWebhook / setMyName because
    // publicBaseUrl is unset.
    const calls = server.fetchCalls();
    expect(calls.map((c) => c.url)).toEqual([expect.stringContaining('/sendMessage')]);
    // Pool assignment still landed (assign happens regardless of
    // publicBaseUrl; the side-effects skip).
    expect(getBotPoolEntryByAgentGroup('ag-no-url')?.bot_username).toBe('acme_bot_no_url');
    expect(getBotPoolEntryByAgentGroup('ag-no-url')?.webhook_registered_at).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────
// Disconnect releases the pool bot
// ───────────────────────────────────────────────────────────────────

describe('disconnect releases the assigned bot back to the pool', () => {
  let server: BindServer | null = null;

  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });

  afterEach(async () => {
    await server?.close();
    closeDb();
    server = null;
  });

  it('after a paired bind, DELETE by-tuple flips the bot to available + leaves webhook_registered_at intact', async () => {
    seedBotPoolEntry({
      botUsername: 'acme_bot_dc',
      botTokenValue: 'tok-dc-001',
      webhookSecret: 'sec-dc-001',
      createdAt: new Date().toISOString(),
    });

    server = await startBindServer({
      publicBaseUrl: PUBLIC_BASE_URL,
      telegramRoutes: [
        { match: (u) => u.endsWith('/setWebhook'), handler: () => okResponse({ ok: true }) },
        { match: (u) => u.endsWith('/setMyName'), handler: () => okResponse({ ok: true }) },
        {
          match: (u) => u.endsWith('/sendMessage'),
          handler: () => okResponse({ ok: true, result: { message_id: 1 } }),
        },
      ],
      generateAgentGroupId: () => 'ag-dc-bind',
    });

    await postBind(server.baseUrl);
    const before = getBotPoolEntryByAgentGroup('ag-dc-bind');
    expect(before?.status).toBe('assigned');
    expect(before?.webhook_registered_at).toBeTruthy();

    // Disconnect via tuple-style DELETE.
    const dc = await fetch(`${server.baseUrl}/baget/agent-groups`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: VALID_BIND_BODY.userId, companyId: VALID_BIND_BODY.companyId }),
    });
    expect(dc.status).toBe(200);
    const dcJson = (await dc.json()) as { releasedBot?: string };
    expect(dcJson.releasedBot).toBe('acme_bot_dc');

    // Bot is back to 'available'; webhook_registered_at PERSISTS so
    // the next assignment of this row doesn't burn another setWebhook
    // round-trip.
    const after = getBotPoolEntryByUsername('acme_bot_dc');
    expect(after?.status).toBe('available');
    expect(after?.assigned_agent_group_id).toBeNull();
    expect(after?.webhook_registered_at).toBe(before?.webhook_registered_at);
    expect(getBotPoolEntryByAgentGroup('ag-dc-bind')).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────
// by-tuple GET surfaces botUsername when assigned
// ───────────────────────────────────────────────────────────────────

describe('GET /baget/agent-groups/by-tuple — botUsername field', () => {
  let server: BindServer | null = null;

  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });

  afterEach(async () => {
    await server?.close();
    closeDb();
    server = null;
  });

  it('includes botUsername when this agent_group has a pool assignment', async () => {
    seedBotPoolEntry({
      botUsername: 'acme_bot_tuple',
      botTokenValue: 'tok-tuple-001',
      webhookSecret: 'sec-tuple-001',
      createdAt: new Date().toISOString(),
    });

    server = await startBindServer({
      publicBaseUrl: PUBLIC_BASE_URL,
      telegramRoutes: [
        { match: (u) => u.endsWith('/setWebhook'), handler: () => okResponse({ ok: true }) },
        { match: (u) => u.endsWith('/setMyName'), handler: () => okResponse({ ok: true }) },
        {
          match: (u) => u.endsWith('/sendMessage'),
          handler: () => okResponse({ ok: true, result: { message_id: 1 } }),
        },
      ],
      generateAgentGroupId: () => 'ag-tuple-bind',
    });

    await postBind(server.baseUrl);

    const resp = await fetch(
      `${server.baseUrl}/baget/agent-groups/by-tuple?userId=${VALID_BIND_BODY.userId}&companyId=${VALID_BIND_BODY.companyId}`,
      {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      },
    );
    const json = (await resp.json()) as ByTupleResp;
    expect(json).toMatchObject({
      ok: true,
      paired: true,
      agentGroupId: 'ag-tuple-bind',
      botUsername: 'acme_bot_tuple',
    });
  });

  it('omits botUsername on the legacy global-bot path', async () => {
    server = await startBindServer({
      publicBaseUrl: PUBLIC_BASE_URL,
      telegramBotToken: 'tok-global',
      telegramRoutes: [
        {
          match: (u) => u.endsWith('/sendMessage'),
          handler: () => okResponse({ ok: true, result: { message_id: 1 } }),
        },
      ],
      generateAgentGroupId: () => 'ag-tuple-legacy',
    });

    await postBind(server.baseUrl);
    const resp = await fetch(
      `${server.baseUrl}/baget/agent-groups/by-tuple?userId=${VALID_BIND_BODY.userId}&companyId=${VALID_BIND_BODY.companyId}`,
      {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      },
    );
    const json = (await resp.json()) as ByTupleResp;
    expect(json.paired).toBe(true);
    expect(json.botUsername).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────
// Per-bot webhook route auth
// ───────────────────────────────────────────────────────────────────

describe('per-bot webhook route — secret check', () => {
  let adapter: ReturnType<typeof _testBuildBagetTelegramAdapter> | null = null;
  let server: ReturnType<typeof createBagetAdminServer> | null = null;
  let baseUrl: string;
  let inboundEvents: Array<{ platformId: string; messageText: string }> = [];

  beforeEach(async () => {
    initTestDb();
    runMigrations(getDb());

    seedBotPoolEntry({
      botUsername: 'route_bot',
      botTokenValue: 'tok-route-001',
      webhookSecret: 'route-secret-1234',
      createdAt: new Date().toISOString(),
    });

    inboundEvents = [];
    const port = 37000 + Math.floor(Math.random() * 800);
    baseUrl = `http://127.0.0.1:${port}`;

    adapter = _testBuildBagetTelegramAdapter({
      botToken: 'global-bot-token',
      // Different from the per-bot row's secret — that's the point:
      // the per-bot route uses the row's secret, NOT this one.
      webhookSecret: 'global-secret-9999',
      adminToken: ADMIN_TOKEN,
      apiBaseUrl: 'https://api.telegram.test',
      inboundDebounceMs: 50,
      fetchImpl: (async () => okResponse({ ok: true, result: { message_id: 1 } })) as unknown as typeof fetch,
    });

    const setup: ChannelSetup = {
      onInbound(platformId, _threadId, message) {
        const text = (message.content as { text?: string })?.text ?? '';
        inboundEvents.push({ platformId, messageText: text });
      },
      onInboundEvent() {},
      onMetadata() {},
      onAction() {},
    };
    await adapter.setup(setup);

    server = createBagetAdminServer({
      port,
      adminToken: ADMIN_TOKEN,
      telegramBotUsername: 'baget_global_bot',
      telegramBotToken: 'global-bot-token',
      generateAgentGroupId: () => 'unused',
    });
    await server.listen();
  });

  afterEach(async () => {
    await adapter?.teardown();
    await server?.close();
    closeDb();
    adapter = null;
    server = null;
  });

  function makeUpdate(updateId: number, text: string) {
    return {
      update_id: updateId,
      message: {
        message_id: updateId + 100,
        from: { id: 1, first_name: 'Tester' },
        chat: { id: 555, type: 'private' as const },
        text,
        date: Math.floor(Date.now() / 1000),
      },
    };
  }

  async function waitFor(condition: () => boolean, timeoutMs = 1500): Promise<void> {
    const started = Date.now();
    while (!condition()) {
      if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for condition');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('routes through to processUpdate when the row secret matches', async () => {
    const resp = await fetch(`${baseUrl}/api/channels/telegram/bot/route_bot/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'route-secret-1234',
      },
      body: JSON.stringify(makeUpdate(2001, 'hello via per-bot route')),
    });
    expect(resp.status).toBe(200);
    await waitFor(() => inboundEvents.length === 1);
    expect(inboundEvents[0]!.messageText).toBe('hello via per-bot route');
  });

  it('returns 401 when the per-bot row secret does NOT match the header', async () => {
    const resp = await fetch(`${baseUrl}/api/channels/telegram/bot/route_bot/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret',
      },
      body: JSON.stringify(makeUpdate(2002, 'bad-secret payload')),
    });
    expect(resp.status).toBe(401);
    // Briefly wait — give the adapter time to NOT process the update.
    await new Promise((r) => setTimeout(r, 100));
    expect(inboundEvents).toHaveLength(0);
  });

  it('returns 401 when the username is not in the pool (does not leak pool membership)', async () => {
    const resp = await fetch(`${baseUrl}/api/channels/telegram/bot/unknown_bot/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'route-secret-1234',
      },
      body: JSON.stringify(makeUpdate(2003, 'unknown username')),
    });
    expect(resp.status).toBe(401);
  });

  it('global webhook still works on the global secret (back-compat with legacy pairings)', async () => {
    const resp = await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'global-secret-9999',
      },
      body: JSON.stringify(makeUpdate(2004, 'legacy global route')),
    });
    expect(resp.status).toBe(200);
    await waitFor(() => inboundEvents.length === 1);
    expect(inboundEvents[0]!.messageText).toBe('legacy global route');
  });
});

// ───────────────────────────────────────────────────────────────────
// deliver() outbound token resolution
// ───────────────────────────────────────────────────────────────────

describe('deliver() — outbound bot token resolution', () => {
  let adapter: ReturnType<typeof _testBuildBagetTelegramAdapter> | null = null;
  let outboundUrls: string[] = [];

  beforeEach(async () => {
    initTestDb();
    runMigrations(getDb());

    outboundUrls = [];
    adapter = _testBuildBagetTelegramAdapter({
      botToken: 'global-fallback-token',
      webhookSecret: 'sec',
      adminToken: ADMIN_TOKEN,
      apiBaseUrl: 'https://api.telegram.test',
      inboundDebounceMs: 50,
      fetchImpl: (async (url: string | URL | Request) => {
        outboundUrls.push(typeof url === 'string' ? url : (url as URL).toString());
        return okResponse({ ok: true, result: { message_id: outboundUrls.length } });
      }) as unknown as typeof fetch,
    });

    const setup: ChannelSetup = {
      onInbound() {},
      onInboundEvent() {},
      onMetadata() {},
      onAction() {},
    };
    await adapter.setup(setup);
  });

  afterEach(async () => {
    await adapter?.teardown();
    closeDb();
    adapter = null;
  });

  it('uses the assigned pool bot token when the agent_group has an assignment', async () => {
    // Seed + bind by hand so we exercise deliver directly.
    seedBotPoolEntry({
      botUsername: 'deliver_bot',
      botTokenValue: 'tok-deliver-per-company',
      webhookSecret: 'sec-deliver',
      createdAt: new Date().toISOString(),
    });
    // Wire the chat → agent_group manually.
    const { bindBagetTelegramChat } = await import('./channels/baget-telegram-bind.js');
    const { createBagetAgentGroup } = await import('./db/baget-agent-groups.js');
    createBagetAgentGroup({
      id: 'ag-deliver-pool',
      name: 'Deliver Co',
      folder: 'baget-deliver',
      user_id: 'u',
      company_id: 'c',
      baget_team_members: JSON.stringify({ cos: 'Louis' }),
      created_at: new Date().toISOString(),
    });
    bindBagetTelegramChat({ chatId: 9999, agentGroupId: 'ag-deliver-pool', firstName: 'Sam' });
    // Manually link this agent_group to the pool bot.
    const { assignNextAvailableBot } = await import('./db/baget-bot-pool.js');
    assignNextAvailableBot('ag-deliver-pool');

    const messageId = await adapter!.deliver('baget-telegram:9999', null, {
      kind: 'chat',
      content: { text: 'cos: hi' },
    } satisfies OutboundMessage);

    expect(messageId).toBe('1');
    // Token is the per-company one, NOT 'global-fallback-token'.
    expect(outboundUrls).toHaveLength(1);
    expect(outboundUrls[0]).toContain('/bottok-deliver-per-company/sendMessage');
  });

  it('falls back to global cfg.botToken when the agent_group has NO pool assignment (legacy / Vela)', async () => {
    // Wire chat → agent_group, but DO NOT assign a pool bot.
    const { bindBagetTelegramChat } = await import('./channels/baget-telegram-bind.js');
    const { createBagetAgentGroup } = await import('./db/baget-agent-groups.js');
    createBagetAgentGroup({
      id: 'ag-deliver-legacy',
      name: 'Vela',
      folder: 'baget-vela',
      user_id: 'u',
      company_id: 'c',
      baget_team_members: JSON.stringify({ cos: 'Louis' }),
      created_at: new Date().toISOString(),
    });
    bindBagetTelegramChat({ chatId: 8888, agentGroupId: 'ag-deliver-legacy', firstName: 'Sam' });

    const messageId = await adapter!.deliver('baget-telegram:8888', null, {
      kind: 'chat',
      content: { text: 'cos: legacy hi' },
    } satisfies OutboundMessage);

    expect(messageId).toBe('1');
    expect(outboundUrls[0]).toContain('/botglobal-fallback-token/sendMessage');
  });
});
