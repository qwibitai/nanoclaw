/**
 * Tests for the structured delivery_failure log contract and the pairing
 * failure deeplink added in PR baget/sentry-and-delivery-receipts.
 *
 * These cover two of the three observable changes:
 *   1. Every non-OK Telegram response from sendBagetBotMessage produces a
 *      log line matching { kind: 'delivery_failure', channelType: 'baget-telegram', … }.
 *   2. The pairing FAILURE_MSG contains the dashboard regenerate URL.
 *
 * Sentry init is covered in src/sentry.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Delivery-failure log contract ───────────────────────────────────────────

import { log } from '../log.js';
import { sendBagetBotMessage } from './baget-telegram-bind.js';

describe('sendBagetBotMessage delivery_failure log contract', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  function makeFetch(status: number, body: unknown): typeof fetch {
    return vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  }

  it('emits delivery_failure shape on non-OK Telegram response', async () => {
    const fetchImpl = makeFetch(403, {
      ok: false,
      description: "Forbidden: bot can't initiate conversation with a user",
    });

    await sendBagetBotMessage({
      botToken: 'bot-stub',
      chatId: 42,
      text: 'hello',
      agentGroupId: 'ag-test-123',
      fetchImpl,
    });

    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg, meta] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe('Baget channel delivery_failure');
    expect(meta).toMatchObject({
      kind: 'delivery_failure',
      channelType: 'baget-telegram',
      agentGroupId: 'ag-test-123',
      chatId: 42,
      telegramErrorCode: 403,
      telegramDescription: "Forbidden: bot can't initiate conversation with a user",
      founderActionRequired: true,
      attempt: 1,
    });
  });

  it('emits delivery_failure shape on non-OK without description', async () => {
    const fetchImpl = makeFetch(500, { ok: false });

    await sendBagetBotMessage({
      botToken: 'bot-stub',
      chatId: 99,
      text: 'hi',
      agentGroupId: 'ag-other',
      fetchImpl,
    });

    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg, meta] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe('Baget channel delivery_failure');
    expect(meta).toMatchObject({
      kind: 'delivery_failure',
      channelType: 'baget-telegram',
      agentGroupId: 'ag-other',
      chatId: 99,
      telegramErrorCode: 500,
      telegramDescription: undefined,
      founderActionRequired: false,
      attempt: 1,
    });
  });

  it('emits delivery_failure shape on network throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    await sendBagetBotMessage({
      botToken: 'bot-stub',
      chatId: 77,
      text: 'oops',
      agentGroupId: 'ag-throw-test',
      fetchImpl,
    });

    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg, meta] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toBe('Baget channel delivery_failure');
    expect(meta).toMatchObject({
      kind: 'delivery_failure',
      channelType: 'baget-telegram',
      agentGroupId: 'ag-throw-test',
      chatId: 77,
      telegramErrorCode: undefined,
      founderActionRequired: false,
      attempt: 1,
    });
    expect(typeof meta.telegramDescription).toBe('string');
  });

  it('includes agentGroupId:undefined when caller omits it', async () => {
    const fetchImpl = makeFetch(400, { ok: false, description: 'Bad Request' });

    await sendBagetBotMessage({
      botToken: 'bot-stub',
      chatId: 11,
      text: 'system msg',
      fetchImpl,
      // agentGroupId intentionally omitted — system-initiated send
    });

    expect(warnSpy).toHaveBeenCalledOnce();
    const [, meta] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta.agentGroupId).toBeUndefined();
  });

  it('does NOT log warn on successful delivery', async () => {
    const fetchImpl = makeFetch(200, { ok: true, result: { message_id: 1 } });

    const result = await sendBagetBotMessage({
      botToken: 'bot-stub',
      chatId: 55,
      text: 'all good',
      agentGroupId: 'ag-ok',
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, messageId: '1' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // ── founderActionRequired detection ────────────────────────────────────────

  it('sets founderActionRequired:true when description is "chat not found"', async () => {
    // The second trigger phrase that the existing tests never exercise.
    const fetchImpl = makeFetch(400, { ok: false, description: 'Bad Request: chat not found' });

    await sendBagetBotMessage({
      botToken: 'bot-stub',
      chatId: 22,
      text: 'hello',
      agentGroupId: 'ag-cnf',
      fetchImpl,
    });

    expect(warnSpy).toHaveBeenCalledOnce();
    const [, meta] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(meta.founderActionRequired).toBe(true);
  });

  it('returns { ok:false, founderActionRequired:true } on "chat not found" error', async () => {
    const fetchImpl = makeFetch(400, { ok: false, description: 'Bad Request: chat not found' });

    const result = await sendBagetBotMessage({
      botToken: 'bot-stub',
      chatId: 33,
      text: 'hello',
      agentGroupId: 'ag-ret-cnf',
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, founderActionRequired: true });
  });

  it('returns { ok:false, founderActionRequired:false } on generic HTTP error', async () => {
    const fetchImpl = makeFetch(500, { ok: false });

    const result = await sendBagetBotMessage({
      botToken: 'bot-stub',
      chatId: 44,
      text: 'hello',
      agentGroupId: 'ag-ret-500',
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, founderActionRequired: false });
  });

  it('returns { ok:false, founderActionRequired:false } on network throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    const result = await sendBagetBotMessage({
      botToken: 'bot-stub',
      chatId: 66,
      text: 'oops',
      agentGroupId: 'ag-ret-throw',
      fetchImpl,
    });

    expect(result).toEqual({ ok: false, founderActionRequired: false });
  });

  // ── 200 OK with ok:false body ───────────────────────────────────────────────
  // Telegram returns HTTP 200 on rate-limit / permission errors in some edge
  // cases but sets `ok: false` in the JSON body. This silent-failure path
  // must NOT emit a delivery_failure log (there is no description to surface),
  // but it MUST return ok:false to the caller so they know the send failed.

  it('returns { ok:false, founderActionRequired:false } on HTTP-200 with ok:false body', async () => {
    const fetchImpl = makeFetch(200, { ok: false });

    const result = await sendBagetBotMessage({
      botToken: 'bot-stub',
      chatId: 77,
      text: 'odd',
      agentGroupId: 'ag-200-false',
      fetchImpl,
    });

    // No log.warn should fire — HTTP 200 takes the non-error branch.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, founderActionRequired: false });
  });

  it('returns { ok:false, founderActionRequired:false } on HTTP-200 with non-numeric message_id', async () => {
    const fetchImpl = makeFetch(200, { ok: true, result: { message_id: 'not-a-number' } });

    const result = await sendBagetBotMessage({
      botToken: 'bot-stub',
      chatId: 88,
      text: 'weird',
      agentGroupId: 'ag-200-bad-id',
      fetchImpl,
    });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, founderActionRequired: false });
  });
});

// ── Pairing failure deeplink ─────────────────────────────────────────────────

import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';
import { createBagetAdminServer } from '../baget-admin-server.js';
import { createBagetAgentGroup } from '../db/baget-agent-groups.js';
import { _testBuildBagetTelegramAdapter } from './baget-telegram.js';
import type { ChannelSetup } from './adapter.js';

const WEBHOOK_SECRET = 'test-secret-1234567890abcdef';
const ADMIN_TOKEN = 'test-admin-1234567890abcdef';

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

describe('FAILURE_MSG deeplink', () => {
  let port: number;
  let baseUrl: string;
  let outbound: Array<{ url: string; body: { chat_id: number | string; text?: string } }>;
  let adapter: ReturnType<typeof _testBuildBagetTelegramAdapter> | null = null;
  let server: ReturnType<typeof createBagetAdminServer> | null = null;

  beforeEach(async () => {
    initTestDb();
    runMigrations(getDb());

    createBagetAgentGroup({
      id: 'ag-fail-test',
      name: 'Fail Team',
      folder: 'fail-test',
      user_id: 'user-fail',
      company_id: 'company-fail',
      baget_team_members: JSON.stringify({ cos: 'Louis' }),
      created_at: nowIso(),
    });

    outbound = [];
    port = 34000 + Math.floor(Math.random() * 1000);
    baseUrl = `http://127.0.0.1:${port}`;

    adapter = _testBuildBagetTelegramAdapter({
      botToken: 'bot-token',
      webhookSecret: WEBHOOK_SECRET,
      adminToken: ADMIN_TOKEN,
      apiBaseUrl: 'https://api.telegram.test',
      fetchImpl: async (url, init) => {
        outbound.push({
          url: String(url),
          body: JSON.parse(String(init?.body ?? '{}')) as { chat_id: number | string; text?: string },
        });
        return new Response(JSON.stringify({ ok: true, result: { message_id: outbound.length } }), { status: 200 });
      },
    });

    const setup: ChannelSetup = {
      onInbound() {},
      onInboundEvent() {},
      onMetadata() {},
      onAction() {},
    };
    await adapter.setup(setup);

    server = createBagetAdminServer({
      port,
      adminToken: ADMIN_TOKEN,
      telegramBotUsername: 'baget_test_bot',
      telegramBotToken: 'bot-token',
      telegramApiBaseUrl: 'https://api.telegram.test',
      telegramFetchImpl: async (url, init) => {
        outbound.push({
          url: String(url),
          body: JSON.parse(String(init?.body ?? '{}')) as { chat_id: number | string; text?: string },
        });
        return new Response(JSON.stringify({ ok: true, result: { message_id: outbound.length } }), { status: 200 });
      },
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
    delete process.env.BAGET_DASHBOARD_URL;
  });

  async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > ms) throw new Error('Timed out');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('sends FAILURE_MSG with app.baget.ai/team link on invalid /start token', async () => {
    const resp = await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 9001,
        message: {
          message_id: 9002,
          from: { id: 1234, first_name: 'Sam' },
          chat: { id: 1234, type: 'private' },
          text: '/start invalidtokenxxx',
          date: Math.floor(Date.now() / 1000),
        },
      }),
    });

    expect(resp.status).toBe(200);
    await waitFor(() => outbound.length === 1);

    const replyText = outbound[0]?.body.text ?? '';
    expect(replyText).toMatch(/app\.baget\.ai\/team/);
    expect(replyText).toMatch(/regenerate=1/);
  });

  it('uses BAGET_DASHBOARD_URL env var when set', async () => {
    process.env.BAGET_DASHBOARD_URL = 'https://stg-app.baget.ai';

    const resp = await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 9003,
        message: {
          message_id: 9004,
          from: { id: 1234, first_name: 'Sam' },
          chat: { id: 1234, type: 'private' },
          text: '/start anotherInvalidToken',
          date: Math.floor(Date.now() / 1000),
        },
      }),
    });

    expect(resp.status).toBe(200);
    await waitFor(() => outbound.length === 1);

    const replyText = outbound[0]?.body.text ?? '';
    expect(replyText).toMatch(/stg-app\.baget\.ai\/team/);
  });

  it('sends FAILURE_MSG for a well-formed hex token not present in the DB', async () => {
    // This token passes the /^[a-f0-9]{32}$/ regex but has no DB row,
    // so consumePairingToken returns { ok: false, reason: 'unknown' }.
    // The third FAILURE_MSG path in handleStartCommand is exercised here.
    const validHexNotInDb = 'deadbeefcafebabe0123456789abcdef';

    const resp = await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 9005,
        message: {
          message_id: 9006,
          from: { id: 5678, first_name: 'Bob' },
          chat: { id: 5678, type: 'private' },
          text: `/start ${validHexNotInDb}`,
          date: Math.floor(Date.now() / 1000),
        },
      }),
    });

    expect(resp.status).toBe(200);
    await waitFor(() => outbound.length === 1);

    const replyText = outbound[0]?.body.text ?? '';
    expect(replyText).toMatch(/app\.baget\.ai\/team/);
    expect(replyText).toMatch(/regenerate=1/);
  });
});
