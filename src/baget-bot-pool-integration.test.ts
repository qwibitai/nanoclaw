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
      generateAgentGroupId: () => 'ag-exhausted-clean',
    });
    const { status, json } = await postBind(server.baseUrl);
    expect(status).toBe(503);
    expect(json.error).toBe('pool_exhausted');
    // The spec mandates a clear operator-actionable message so the
    // dashboard can surface "ask the operator to seed more bots"
    // rather than a generic 503.
    expect(json.message).toMatch(/seed/i);

    // Codex P1 (re-review of 1e41ac9): pool_exhausted MUST NOT
    // leave the system in a mutated-but-failed state. Specifically:
    // no chat-bind, no channel-token persist, no by-tuple "paired"
    // false-positive. The agent_groups row is allowed to exist
    // (idempotent across retries) but no Telegram-side wiring.
    const byTupleResp = await fetch(
      `${server.baseUrl}/baget/agent-groups/by-tuple?userId=${VALID_BIND_BODY.userId}&companyId=${VALID_BIND_BODY.companyId}`,
      { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
    );
    const byTuple = (await byTupleResp.json()) as { paired: boolean; platformChatId?: string };
    expect(byTuple.paired).toBe(false);
    expect(byTuple.platformChatId).toBeUndefined();
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
    // is skipped. setMyName is ALSO skipped — we gate it on the
    // first-bind flag (webhook_registered_at being null) to avoid
    // burning Telegram's per-bot daily quota for setMyName on a
    // re-pair storm. sendMessage fires every bind (welcome).
    expect(setWebhookCalls).toBe(1);
    expect(setMyNameCalls).toBe(1);
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

  it('mixed deployment: re-binding a pre-existing legacy agent_group keeps it on the global bot (does NOT re-home to pool)', async () => {
    // Vela scenario: operator has BOTH a global telegramBotToken AND
    // a pool seeded. Vela's agent_group exists from before the pool
    // migration, paired against the global bot. A re-bind for Vela
    // through the bind-telegram endpoint MUST NOT silently grab a
    // fresh pool bot — that would break the founder's chat (the new
    // bot is a different Telegram account, the founder hasn't DMed
    // it). Pin the legacy preservation contract.
    seedBotPoolEntry({
      botUsername: 'fresh_pool_bot',
      botTokenValue: 'tok-fresh-pool',
      webhookSecret: 'sec-fresh-pool',
      createdAt: new Date().toISOString(),
    });

    // Pre-existing legacy agent_group + chat-bind (simulates a Vela
    // company that completed a global-bot pairing before the pool
    // migration). Both rows are required for the legacy detection
    // to fire — `agent_group` row alone (without chat-binds) is
    // the partial-failure-retry shape, which intentionally gets
    // pool-assigned. Codex P2.
    const { createBagetAgentGroup } = await import('./db/baget-agent-groups.js');
    const { bindBagetTelegramChat } = await import('./channels/baget-telegram-bind.js');
    createBagetAgentGroup({
      id: 'ag-vela-legacy',
      name: 'Vela',
      folder: 'baget-vela',
      user_id: VALID_BIND_BODY.userId,
      company_id: VALID_BIND_BODY.companyId,
      baget_team_members: JSON.stringify({ cos: 'Louis' }),
      created_at: new Date().toISOString(),
    });
    // Pre-existing chat-bind to the global bot (the Vela founder
    // already paired before the pool migration).
    bindBagetTelegramChat({
      chatId: VALID_BIND_BODY.telegramUserId,
      agentGroupId: 'ag-vela-legacy',
      firstName: VALID_BIND_BODY.telegramFirstName,
    });

    server = await startBindServer({
      publicBaseUrl: PUBLIC_BASE_URL,
      telegramBotToken: 'tok-vela-global',
      telegramRoutes: [
        // No setWebhook / setMyName expected — we should land on the
        // global path, not auto-assign.
        {
          match: (u) => u.endsWith('/sendMessage'),
          handler: () => okResponse({ ok: true, result: { message_id: 1 } }),
        },
      ],
      generateAgentGroupId: () => 'unused-already-exists',
    });

    const { status, json } = await postBind(server.baseUrl);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.agentGroupId).toBe('ag-vela-legacy');
    // Critical: legacy preservation. No botUsername in response,
    // because no pool entry was assigned. The deeplink falls back
    // to the global cfg.telegramBotUsername.
    expect(json.botUsername).toBeUndefined();
    expect(json.telegramOpenUrl).toBe('https://t.me/baget_global_bot');

    // Pool depth unchanged — fresh_pool_bot is still available.
    expect(countAvailableBots()).toBe(1);
    expect(getBotPoolEntryByAgentGroup('ag-vela-legacy')).toBeUndefined();

    // Welcome went out on the GLOBAL token, not the pool token.
    const calls = server.fetchCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/bottok-vela-global/sendMessage');
  });

  it('publicBaseUrl unset + global token configured → falls back to global; pool NOT auto-assigned (Codex re-review P1)', async () => {
    // Codex re-review on ec1c742 caught that the previous behavior
    // (auto-assign a pool bot when publicBaseUrl is unset) created
    // a one-way-broken chat: outbound rode the per-company token
    // but inbound was never registered (no URL → no setWebhook).
    // The fix: when we can't register the webhook, refuse to make
    // a fresh assignment and fall back to the global token instead.
    //
    // This pins the corrected behavior — pool stays untouched, the
    // founder lands on the global bot via cfg.telegramBotToken,
    // botUsername is omitted from the response (legacy shape).
    seedBotPoolEntry({
      botUsername: 'reserved_bot_no_url',
      botTokenValue: 'tok-reserved-no-url',
      webhookSecret: 'sec-reserved-no-url',
      createdAt: new Date().toISOString(),
    });

    server = await startBindServer({
      // publicBaseUrl deliberately omitted.
      telegramBotToken: 'tok-global-fallback',
      telegramRoutes: [
        {
          match: (u) => u.endsWith('/sendMessage'),
          handler: () => okResponse({ ok: true, result: { message_id: 7 } }),
        },
      ],
      generateAgentGroupId: () => 'ag-no-url',
    });

    const { status, json } = await postBind(server.baseUrl);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    // Legacy shape — no botUsername in response, default deeplink.
    expect(json.botUsername).toBeUndefined();
    expect(json.telegramOpenUrl).toBe('https://t.me/baget_global_bot');

    // Only sendMessage fired, on the GLOBAL token. No pool
    // assignment took place — `reserved_bot_no_url` is still
    // available for a properly-configured later deployment.
    const calls = server.fetchCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/bottok-global-fallback/sendMessage');
    expect(getBotPoolEntryByAgentGroup('ag-no-url')).toBeUndefined();
    expect(countAvailableBots()).toBe(1);
  });

  it('publicBaseUrl unset + NO global token + pool seeded → 503 pool_exhausted (no silent half-broken bind, Codex re-review P1)', async () => {
    // Same condition as the previous test, but without a global
    // fallback. The bind handler must surface the misconfiguration
    // (no setWebhook URL, no global bot) rather than silently
    // pool-assign a bot whose webhook can't be registered.
    seedBotPoolEntry({
      botUsername: 'untouched_bot',
      botTokenValue: 'tok-untouched',
      webhookSecret: 'sec-untouched',
      createdAt: new Date().toISOString(),
    });

    server = await startBindServer({
      // publicBaseUrl unset, no global token either.
      telegramRoutes: [],
      generateAgentGroupId: () => 'ag-half-broken',
    });

    const { status, json } = await postBind(server.baseUrl);
    expect(status).toBe(503);
    expect(json.error).toBe('pool_exhausted');
    // Pool stays untouched — operator didn't lose a bot to a
    // malformed deployment.
    expect(getBotPoolEntryByAgentGroup('ag-half-broken')).toBeUndefined();
    expect(countAvailableBots()).toBe(1);
  });

  it('publicBaseUrl unset + EXISTING pool assignment → still works (no side-effects, but token still resolves)', async () => {
    // Idempotency: if a previous bind (when publicBaseUrl WAS set)
    // assigned a pool bot and registered its webhook, a later
    // re-bind with publicBaseUrl now unset must still return that
    // existing assignment. The webhook is already registered; no
    // setWebhook call needed; sendMessage rides the per-company
    // token. Don't punish operators who had a temporary env-var
    // misconfiguration.
    seedBotPoolEntry({
      botUsername: 'already_bound_bot',
      botTokenValue: 'tok-already-bound',
      webhookSecret: 'sec-already-bound',
      createdAt: new Date().toISOString(),
    });
    // Simulate prior assignment + webhook registration.
    const { assignNextAvailableBot, markWebhookRegistered } = await import('./db/baget-bot-pool.js');
    const { createBagetAgentGroup } = await import('./db/baget-agent-groups.js');
    createBagetAgentGroup({
      id: 'ag-already-bound',
      name: 'Already Bound Co',
      folder: 'baget-already-bound',
      user_id: VALID_BIND_BODY.userId,
      company_id: VALID_BIND_BODY.companyId,
      baget_team_members: JSON.stringify({ cos: 'Louis' }),
      created_at: new Date().toISOString(),
    });
    assignNextAvailableBot('ag-already-bound');
    markWebhookRegistered('already_bound_bot', new Date().toISOString());

    server = await startBindServer({
      // publicBaseUrl now unset.
      telegramRoutes: [
        {
          match: (u) => u.endsWith('/sendMessage'),
          handler: () => okResponse({ ok: true, result: { message_id: 1 } }),
        },
      ],
      generateAgentGroupId: () => 'unused',
    });

    const { json } = await postBind(server.baseUrl);
    expect(json.ok).toBe(true);
    // Existing assignment preserved.
    expect(json.botUsername).toBe('already_bound_bot');
    // Sends used the per-company token (existing assignment),
    // not the unset-global path.
    const calls = server.fetchCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/bottok-already-bound/sendMessage');
  });

  it('partial-failure retry: pre-existing agent_group with NO chat-binds gets pool-assigned (Codex P2)', async () => {
    // Codex P2: when the first bind creates `agent_groups` but
    // crashes before the chat-bind landed (token persist failed,
    // network blip, etc.), the founder retries. The retry MUST get
    // a pool bot — the previous version of this code keyed legacy
    // detection on "agent_group existed" and would have starved the
    // founder on the global bot forever. The fixed signal keys on
    // pre-existing chat-binds, which a partial-failure retry has
    // none of.
    seedBotPoolEntry({
      botUsername: 'retry_bot',
      botTokenValue: 'tok-retry',
      webhookSecret: 'sec-retry',
      createdAt: new Date().toISOString(),
    });

    // Simulate the partial-failure state: agent_groups row exists
    // (committed by the failed first bind), no messaging_group_agents
    // row (the chat-bind didn't run or rolled back).
    const { createBagetAgentGroup } = await import('./db/baget-agent-groups.js');
    createBagetAgentGroup({
      id: 'ag-retry-stub',
      name: 'Retry Co',
      folder: 'baget-retry',
      user_id: VALID_BIND_BODY.userId,
      company_id: VALID_BIND_BODY.companyId,
      baget_team_members: JSON.stringify({ cos: 'Louis' }),
      created_at: new Date().toISOString(),
    });

    server = await startBindServer({
      publicBaseUrl: PUBLIC_BASE_URL,
      // Mixed deployment: global token IS set. Without the chat-bind
      // signal, the previous logic would have picked legacy here.
      telegramBotToken: 'tok-mixed-global',
      telegramRoutes: [
        { match: (u) => u.endsWith('/setWebhook'), handler: () => okResponse({ ok: true }) },
        { match: (u) => u.endsWith('/setMyName'), handler: () => okResponse({ ok: true }) },
        {
          match: (u) => u.endsWith('/sendMessage'),
          handler: () => okResponse({ ok: true, result: { message_id: 1 } }),
        },
      ],
      generateAgentGroupId: () => 'unused',
    });

    const { status, json } = await postBind(server.baseUrl);
    expect(status).toBe(200);
    expect(json.agentGroupId).toBe('ag-retry-stub');
    // The retry succeeds and the founder gets a pool bot, NOT the
    // legacy global fallback.
    expect(json.botUsername).toBe('retry_bot');
    expect(getBotPoolEntryByAgentGroup('ag-retry-stub')?.bot_username).toBe('retry_bot');
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

  it('disconnect on a legacy global-bot pairing returns releasedBot:null without erroring', async () => {
    // The performDisconnectCleanup transaction calls releaseBot
    // unconditionally. For a legacy pairing (no pool assignment ever
    // made), releaseBot returns null — that needs to surface cleanly
    // through the DELETE response as releasedBot:null, NOT a 500 or
    // a missing field. Pin the contract so a refactor that adds an
    // "if (poolEntry) releaseBot(...)" guard around the call doesn't
    // silently regress: the unconditional call is intentional, and
    // null is the legitimate response shape.
    server = await startBindServer({
      publicBaseUrl: PUBLIC_BASE_URL,
      telegramBotToken: 'tok-global-dc',
      telegramRoutes: [
        // Welcome on bind, farewell on disconnect — both via global.
        {
          match: (u) => u.endsWith('/sendMessage'),
          handler: () => okResponse({ ok: true, result: { message_id: 1 } }),
        },
      ],
      generateAgentGroupId: () => 'ag-legacy-dc',
    });

    // Bind via the legacy global path (no pool seeded).
    const bind = await postBind(server.baseUrl);
    expect(bind.status).toBe(200);
    expect(bind.json.botUsername).toBeUndefined();
    expect(getBotPoolEntryByAgentGroup('ag-legacy-dc')).toBeUndefined();

    // Disconnect.
    const dc = await fetch(`${server.baseUrl}/baget/agent-groups`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: VALID_BIND_BODY.userId, companyId: VALID_BIND_BODY.companyId }),
    });
    expect(dc.status).toBe(200);
    const dcJson = (await dc.json()) as { ok: boolean; archived: boolean; releasedBot: string | null };
    expect(dcJson.ok).toBe(true);
    expect(dcJson.archived).toBe(true);
    // Pin: legacy path returns releasedBot:null, not undefined or
    // an error.
    expect(dcJson.releasedBot).toBeNull();
  });

  it('recycled bot reassignment re-fires setMyName for the new founder (Codex P1)', async () => {
    // Codex P1: when a bot is released back to the pool,
    // `webhook_registered_at` intentionally stays set (so the next
    // assignment skips the redundant setWebhook). The previous gate
    // on `!webhook_registered_at` for setMyName ALSO would have
    // skipped — leaving the recycled bot showing the previous
    // founder's company name in the new founder's chat. Cross-tenant
    // identity leak in the Telegram UI. Pin the contract that a
    // FRESH assignment (regardless of webhook state) DOES fire
    // setMyName.
    seedBotPoolEntry({
      botUsername: 'recycle_bot',
      botTokenValue: 'tok-recycle',
      webhookSecret: 'sec-recycle',
      createdAt: new Date().toISOString(),
    });

    const setMyNameCalls: Array<{ name: string }> = [];
    server = await startBindServer({
      publicBaseUrl: PUBLIC_BASE_URL,
      telegramRoutes: [
        { match: (u) => u.endsWith('/setWebhook'), handler: () => okResponse({ ok: true }) },
        {
          match: (u) => u.endsWith('/setMyName'),
          handler: (call) => {
            setMyNameCalls.push({ name: (call.body as { name: string }).name });
            return okResponse({ ok: true });
          },
        },
        {
          match: (u) => u.endsWith('/sendMessage'),
          handler: () => okResponse({ ok: true, result: { message_id: 1 } }),
        },
      ],
      generateAgentGroupId: () => `ag-${setMyNameCalls.length}-${Math.random().toString(36).slice(2, 8)}`,
    });

    // Founder A pairs Acme Co.
    const r1 = await postBind(server.baseUrl, {
      ...VALID_BIND_BODY,
      userId: 'u-acme',
      companyId: 'c-acme',
      companyName: 'Acme',
    });
    expect(r1.status).toBe(200);
    expect(r1.json.botUsername).toBe('recycle_bot');
    expect(setMyNameCalls).toEqual([{ name: 'Acme Team' }]);

    // Founder A disconnects → bot returns to the pool with
    // `webhook_registered_at` PRESERVED (intentional optimization
    // for re-registration skipping).
    await fetch(`${server.baseUrl}/baget/agent-groups`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u-acme', companyId: 'c-acme' }),
    });
    const recycled = getBotPoolEntryByUsername('recycle_bot');
    expect(recycled?.status).toBe('available');
    expect(recycled?.webhook_registered_at).toBeTruthy(); // preserved

    // Founder B pairs Bolt Co — gets the SAME (recycled) bot row.
    const r2 = await postBind(server.baseUrl, {
      ...VALID_BIND_BODY,
      userId: 'u-bolt',
      companyId: 'c-bolt',
      companyName: 'Bolt',
      telegramUserId: 999000111, // different chat
    });
    expect(r2.status).toBe(200);
    expect(r2.json.botUsername).toBe('recycle_bot'); // same bot

    // Critical: setMyName fires AGAIN for the new company. The
    // `webhook_registered_at`-based gate would have suppressed this.
    // The fix gates on "freshly assigned" instead, which is true
    // here (bot was released, then this bind picked it up).
    expect(setMyNameCalls).toEqual([{ name: 'Acme Team' }, { name: 'Bolt Team' }]);
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

  it('returns 401 (not 500) for malformed %-encoding in the bot-username path segment (Codex re-review P2)', async () => {
    // `decodeURIComponent('%XX')` throws URIError. Without the
    // try/catch added in this PR, an attacker (or a buggy probe)
    // hitting `/api/channels/telegram/bot/%XX/webhook` would crash
    // the route handler → 500 + a noisy stack trace in logs.
    // The fix maps URIError to the same opaque 401 we return for
    // any other unauthenticated/unknown bot, keeping the route's
    // failure shape uniform and the logs clean.
    const resp = await fetch(`${baseUrl}/api/channels/telegram/bot/%XX/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': 'whatever',
      },
      body: JSON.stringify(makeUpdate(2005, 'malformed encoding')),
    });
    expect(resp.status).toBe(401);
    // Crucially NOT 500 — verifies the route doesn't 500 on
    // malformed URIs.
    expect(resp.status).not.toBe(500);
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
