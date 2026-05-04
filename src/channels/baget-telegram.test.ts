import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBagetAdminServer } from '../baget-admin-server.js';
import { log } from '../log.js';
import {
  createBagetAgentGroup,
  getBagetAgentGroupById,
  normalizeBoundBagetTelegramFounderChannels,
} from '../db/baget-agent-groups.js';
import {
  closeDb,
  createMessagingGroup,
  getDb,
  getMessagingGroupAgents,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
  initTestDb,
  runMigrations,
} from '../db/index.js';
import { insertPairingToken } from '../db/baget-pairing-tokens.js';
import { bindBagetTelegramChat } from './baget-telegram-bind.js';
import {
  _testBuildBagetTelegramAdapter,
  _testCoalesceInboundMessages,
  _testParseTeamMembers,
  BAGET_TELEGRAM_CHANNEL_TYPE,
} from './baget-telegram.js';
import type { ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';

const ADMIN_TOKEN = 'test-admin-token-1234567890abcdef';
const WEBHOOK_SECRET = 'test-webhook-secret-1234567890';
const RAW_TOKEN = '0123456789abcdef0123456789abcdef';
const AGENT_GROUP_ID = 'ag-baget-1';
const CHAT_ID = 424242;

type TelegramSend = {
  url: string;
  body: { chat_id: string | number; text?: string; action?: string };
};

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeUpdate(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1000,
      from: { id: 9001, first_name: 'Sam' },
      chat: { id: CHAT_ID, type: 'private' },
      text,
      date: Math.floor(Date.now() / 1000),
    },
  };
}

function makeEditedUpdate(updateId: number, text: string) {
  return {
    update_id: updateId,
    edited_message: {
      message_id: updateId + 1000,
      from: { id: 9001, first_name: 'Sam' },
      chat: { id: CHAT_ID, type: 'private' },
      text,
      date: Math.floor(Date.now() / 1000),
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('Baget Telegram adapter', () => {
  let port: number;
  let baseUrl: string;
  let outbound: TelegramSend[];
  let inboundEvents: Array<{ platformId: string; threadId: string | null; message: InboundMessage }>;
  let telegramSendStatus: number;
  let telegramSendJson: unknown;
  let telegramSendError: Error | null;
  let adapter: ReturnType<typeof _testBuildBagetTelegramAdapter> | null = null;
  let server: ReturnType<typeof createBagetAdminServer> | null = null;

  beforeEach(async () => {
    initTestDb();
    runMigrations(getDb());

    createBagetAgentGroup({
      id: AGENT_GROUP_ID,
      name: 'Baget Team',
      folder: 'baget-test-team',
      user_id: 'user-1',
      company_id: 'company-1',
      baget_team_members: JSON.stringify({
        cos: 'Louis',
        developer: 'Valentin',
        marketing: 'Chloe',
        analyst: 'Theo',
        design: 'Nicolas',
        ops: 'Marie',
      }),
      created_at: nowIso(),
    });

    insertPairingToken({
      rawToken: RAW_TOKEN,
      userId: 'user-1',
      companyId: 'company-1',
      agentGroupId: AGENT_GROUP_ID,
      expiresAt: nowIso(5 * 60 * 1000),
      createdAt: nowIso(),
    });

    outbound = [];
    inboundEvents = [];
    telegramSendStatus = 200;
    telegramSendJson = null;
    telegramSendError = null;
    port = 33000 + Math.floor(Math.random() * 1000);
    baseUrl = `http://127.0.0.1:${port}`;

    adapter = _testBuildBagetTelegramAdapter({
      botToken: 'bot-token',
      webhookSecret: WEBHOOK_SECRET,
      adminToken: ADMIN_TOKEN,
      apiBaseUrl: 'https://api.telegram.test',
      // Tight debounce keeps the suite snappy. The default (1500ms) is
      // a wall-clock cost we don't want compounding across CI runs;
      // 100ms is plenty long enough to coalesce three webhook fetches
      // when we want to test rapid-fire behavior, and small enough to
      // be a no-op for single-message tests.
      inboundDebounceMs: 100,
      fetchImpl: async (url, init) => {
        outbound.push({
          url: String(url),
          body: JSON.parse(String(init?.body ?? '{}')) as TelegramSend['body'],
        });

        if (telegramSendError) {
          throw telegramSendError;
        }

        const json =
          telegramSendJson ??
          (telegramSendStatus >= 200 && telegramSendStatus < 300
            ? { ok: true, result: { message_id: outbound.length } }
            : { ok: false });

        return new Response(JSON.stringify(json), {
          status: telegramSendStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const setup: ChannelSetup = {
      onInbound(platformId, threadId, message) {
        inboundEvents.push({ platformId, threadId, message });
      },
      onInboundEvent() {},
      onMetadata() {},
      onAction() {},
    };

    await adapter.setup(setup);

    server = createBagetAdminServer({
      port,
      adminToken: ADMIN_TOKEN,
      telegramBotUsername: 'baget_team_staging_bot',
      telegramBotToken: 'bot-token',
      telegramApiBaseUrl: 'https://api.telegram.test',
      telegramFetchImpl: async (url, init) => {
        outbound.push({
          url: String(url),
          body: JSON.parse(String(init?.body ?? '{}')) as TelegramSend['body'],
        });

        if (telegramSendError) {
          throw telegramSendError;
        }

        const json =
          telegramSendJson ??
          (telegramSendStatus >= 200 && telegramSendStatus < 300
            ? { ok: true, result: { message_id: outbound.length } }
            : { ok: false });

        return new Response(JSON.stringify(json), {
          status: telegramSendStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      generateAgentGroupId: () => 'unused-in-this-test',
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

  it('pairs /start, routes founder DMs, and applies persona prefixes on outbound replies', async () => {
    const startResp = await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body: JSON.stringify(makeUpdate(101, `/start ${RAW_TOKEN}`)),
    });

    expect(startResp.status).toBe(200);
    expect(await startResp.json()).toEqual({ ok: true });

    await waitFor(() => outbound.length === 1);

    const messagingGroup = getMessagingGroupByPlatform(BAGET_TELEGRAM_CHANNEL_TYPE, `baget-telegram:${CHAT_ID}`);
    expect(messagingGroup).toBeDefined();
    expect(getMessagingGroupAgentByPair(messagingGroup!.id, AGENT_GROUP_ID)).toBeDefined();
    expect(getBagetAgentGroupById(AGENT_GROUP_ID)?.archived_at ?? null).toBeNull();

    const statusResp = await fetch(
      `${baseUrl}/baget/agent-groups/by-tuple?userId=${encodeURIComponent('user-1')}&companyId=${encodeURIComponent('company-1')}`,
      {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      },
    );

    expect(statusResp.status).toBe(200);
    expect(await statusResp.json()).toEqual({
      ok: true,
      paired: true,
      agentGroupId: AGENT_GROUP_ID,
      platformChatId: String(CHAT_ID),
    });

    expect(outbound[0]?.url).toBe('https://api.telegram.test/botbot-token/sendMessage');
    expect(outbound[0]?.body.chat_id).toBe(CHAT_ID);
    expect(outbound[0]?.body.text).toContain('Louis');
    expect(outbound[0]?.body.text).toContain("What's on your mind?");
    // Company name surfaces in the welcome so a founder running multiple
    // Baget companies can tell which chat they're in. agent_groups.name
    // is seeded to 'Baget Team' above; the welcome reads it via
    // getBagetAgentGroupById in the /start handler.
    expect(outbound[0]?.body.text).toContain('Baget Team');

    const dmResp = await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body: JSON.stringify(makeUpdate(102, 'Need a founder update')),
    });

    expect(dmResp.status).toBe(200);
    expect(await dmResp.json()).toEqual({ ok: true });

    await waitFor(() => inboundEvents.length === 1);

    expect(inboundEvents[0]).toMatchObject({
      platformId: `baget-telegram:${CHAT_ID}`,
      threadId: null,
      message: {
        id: 'tg-102',
        kind: 'chat',
        isMention: true,
        isGroup: false,
      },
    });
    expect((inboundEvents[0]!.message.content as { text: string; sender: string }).text).toBe('Need a founder update');
    expect((inboundEvents[0]!.message.content as { text: string; sender: string }).sender).toBe('Sam');

    const messageId = await adapter!.deliver(`baget-telegram:${CHAT_ID}`, null, {
      kind: 'chat',
      content: { text: 'cos: We are on track.' },
    } satisfies OutboundMessage);

    expect(messageId).toBe('2');
    expect(outbound[1]?.body.chat_id).toBe(String(CHAT_ID));
    expect(outbound[1]?.body.text).toBe('🧭 Louis: We are on track.');
  });

  it('direct-bind reports when Telegram cannot deliver the welcome DM yet', async () => {
    telegramSendStatus = 403;
    telegramSendJson = {
      ok: false,
      description: "Forbidden: bot can't initiate conversation with a user",
    };

    const resp = await fetch(`${baseUrl}/baget/agent-groups/bind-telegram`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userId: 'user-direct-bind',
        companyId: 'company-direct-bind',
        companyName: 'Direct Bind Co',
        teamMembers: {
          cos: 'Louis',
          developer: 'Valentin',
          marketing: 'Chloe',
          analyst: 'Theo',
          design: 'Nicolas',
          ops: 'Marie',
        },
        channelTokenCredentialName: 'cred-direct-bind',
        bagetApiBaseUrl: 'https://app.baget.ai',
        telegramUserId: CHAT_ID,
        telegramFirstName: 'Sam',
      }),
    });

    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({
      ok: true,
      agentGroupId: 'unused-in-this-test',
      folder: 'baget-userdire-companyd',
      messagingGroupCreated: true,
      welcomeMessageDelivered: false,
      founderActionRequired: true,
      telegramOpenUrl: 'https://t.me/baget_team_staging_bot',
    });

    const messagingGroup = getMessagingGroupByPlatform(BAGET_TELEGRAM_CHANNEL_TYPE, `baget-telegram:${CHAT_ID}`);
    expect(messagingGroup).toBeDefined();
    expect(getMessagingGroupAgentByPair(messagingGroup!.id, 'unused-in-this-test')).toBeDefined();
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.body.chat_id).toBe(CHAT_ID);
  });

  it('failure-msg includes a deeplink to the team-settings page (default app.baget.ai)', async () => {
    // Token that passes the regex ([a-f0-9]{32}) but has no DB row →
    // exercises the consume-failure path. The shape-check failure path
    // (non-hex token) emits the same message; we exercise consume-failure
    // because it doesn't depend on a different code path.
    const fakeToken = 'deadbeefdeadbeefdeadbeefdeadbeef';
    const startResp = await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body: JSON.stringify(makeUpdate(701, `/start ${fakeToken}`)),
    });

    expect(startResp.status).toBe(200);
    await waitFor(() => outbound.length === 1);

    expect(outbound[0]?.body.text).toContain('https://app.baget.ai/team');
    // Message preserves the user-facing copy contract.
    expect(outbound[0]?.body.text?.toLowerCase()).toContain('expired');
  });

  it('deliver() plumbs the resolved agentGroupId into the structured delivery_failure log on transport error', async () => {
    // Pair the chat first so wired.length === 1 and the resolved
    // agentGroupId is the real id.
    expect(bindBagetTelegramChat({ chatId: CHAT_ID, agentGroupId: AGENT_GROUP_ID, firstName: 'Sam' }).ok).toBe(true);

    // Force the next send to fail with a 500. The delivery_failure
    // log MUST carry the bound agentGroupId — a regression that drops
    // the parameter would silently log `agentGroupId: null` and the
    // dashboard receipt UI would lose the team association.
    telegramSendStatus = 500;
    telegramSendJson = { ok: false, description: 'Internal server error' };
    const warnSpy = vi.spyOn(log, 'warn');

    const messageId = await adapter!.deliver(`baget-telegram:${CHAT_ID}`, null, {
      kind: 'chat',
      content: { text: 'cos: hello' },
    } satisfies OutboundMessage);

    expect(messageId).toBeUndefined();
    const failureCalls = warnSpy.mock.calls.filter((c: unknown[]) => c[0] === 'Baget channel delivery_failure');
    expect(failureCalls.length).toBeGreaterThanOrEqual(1);
    // chatId is a string here because deliver() resolves it via
    // chatIdFromPlatformId, which returns the post-prefix slice as a
    // string. The bind module accepts `number | string` and writes
    // through verbatim. Pin the string form so a future refactor that
    // accidentally coerces back to a number gets caught.
    expect(failureCalls[0]![1]).toMatchObject({
      kind: 'delivery_failure',
      channelType: 'baget-telegram',
      agentGroupId: AGENT_GROUP_ID,
      chatId: String(CHAT_ID),
      telegramErrorCode: 500,
    });

    warnSpy.mockRestore();
  });

  it('failure-msg honors the BAGET_DASHBOARD_URL env override', async () => {
    const previous = process.env.BAGET_DASHBOARD_URL;
    process.env.BAGET_DASHBOARD_URL = 'https://staging.dashboard.baget.test';
    try {
      const fakeToken = 'cafebabecafebabecafebabecafebabe';
      const startResp = await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
        },
        body: JSON.stringify(makeUpdate(702, `/start ${fakeToken}`)),
      });

      expect(startResp.status).toBe(200);
      await waitFor(() => outbound.length === 1);

      expect(outbound[0]?.body.text).toContain('https://staging.dashboard.baget.test/team');
      // Default must NOT leak through when env is set.
      expect(outbound[0]?.body.text).not.toContain('app.baget.ai');
    } finally {
      if (previous === undefined) delete process.env.BAGET_DASHBOARD_URL;
      else process.env.BAGET_DASHBOARD_URL = previous;
    }
  });

  it('upgrades a pre-pair DM row to a public founder channel on /start', async () => {
    createMessagingGroup({
      id: 'mg-preexisting',
      channel_type: BAGET_TELEGRAM_CHANNEL_TYPE,
      platform_id: `baget-telegram:${CHAT_ID}`,
      name: 'Old Name',
      is_group: 1,
      unknown_sender_policy: 'request_approval',
      created_at: nowIso(-60_000),
      denied_at: null,
    });

    const startResp = await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body: JSON.stringify(makeUpdate(201, `/start ${RAW_TOKEN}`)),
    });

    expect(startResp.status).toBe(200);
    expect(await startResp.json()).toEqual({ ok: true });

    await waitFor(() => outbound.length === 1);

    const messagingGroup = getMessagingGroupByPlatform(BAGET_TELEGRAM_CHANNEL_TYPE, `baget-telegram:${CHAT_ID}`);
    expect(messagingGroup).toMatchObject({
      id: 'mg-preexisting',
      name: 'Sam',
      is_group: 0,
      unknown_sender_policy: 'public',
      denied_at: null,
    });
    expect(getMessagingGroupAgentByPair('mg-preexisting', AGENT_GROUP_ID)).toBeDefined();
  });

  it('rebinding the same founder chat replaces the previous agent_group wiring', async () => {
    createBagetAgentGroup({
      id: 'ag-baget-2',
      name: 'Second Team',
      folder: 'baget-second-team',
      user_id: 'user-2',
      company_id: 'company-2',
      baget_team_members: JSON.stringify({
        cos: 'Ava',
        developer: 'Devon',
        marketing: 'Mira',
        analyst: 'Noah',
        design: 'Iris',
        ops: 'Kai',
      }),
      created_at: nowIso(),
    });

    expect(bindBagetTelegramChat({ chatId: CHAT_ID, agentGroupId: AGENT_GROUP_ID, firstName: 'Sam' }).ok).toBe(true);
    expect(bindBagetTelegramChat({ chatId: CHAT_ID, agentGroupId: 'ag-baget-2', firstName: 'Sam' }).ok).toBe(true);

    const messagingGroup = getMessagingGroupByPlatform(BAGET_TELEGRAM_CHANNEL_TYPE, `baget-telegram:${CHAT_ID}`);
    expect(messagingGroup).toBeDefined();

    const wired = getMessagingGroupAgents(messagingGroup!.id);
    expect(wired).toHaveLength(1);
    expect(wired[0]?.agent_group_id).toBe('ag-baget-2');
    expect(getMessagingGroupAgentByPair(messagingGroup!.id, AGENT_GROUP_ID)).toBeUndefined();
    expect(getMessagingGroupAgentByPair(messagingGroup!.id, 'ag-baget-2')).toBeDefined();

    const messageId = await adapter!.deliver(`baget-telegram:${CHAT_ID}`, null, {
      kind: 'chat',
      content: { text: 'cos: The new company is active.' },
    } satisfies OutboundMessage);

    expect(messageId).toBe('1');
    expect(outbound[0]?.body.text).toBe('🧭 Ava: The new company is active.');
  });

  it('normalizes already-bound founder telegram chats back to public DMs', () => {
    createMessagingGroup({
      id: 'mg-existing-bound',
      channel_type: BAGET_TELEGRAM_CHANNEL_TYPE,
      platform_id: `baget-telegram:${CHAT_ID + 1}`,
      name: 'Founder',
      is_group: 1,
      unknown_sender_policy: 'request_approval',
      created_at: nowIso(-120_000),
      denied_at: nowIso(-60_000),
    });

    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO agent_groups
             (id, name, folder, agent_provider, user_id, company_id, baget_team_members, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('ag-other', 'Non-Baget', 'other-test-group', null, null, null, null, nowIso(-120_000)),
    ).not.toThrow();

    expect(() =>
      createMessagingGroup({
        id: 'mg-unrelated',
        channel_type: BAGET_TELEGRAM_CHANNEL_TYPE,
        platform_id: `baget-telegram:${CHAT_ID + 2}`,
        name: 'Unrelated',
        is_group: 1,
        unknown_sender_policy: 'request_approval',
        created_at: nowIso(-120_000),
        denied_at: nowIso(-60_000),
      }),
    ).not.toThrow();

    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO messaging_group_agents
             (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          'mga-existing-bound',
          'mg-existing-bound',
          AGENT_GROUP_ID,
          'mention-sticky',
          null,
          'known',
          'accumulate',
          'shared',
          9,
          nowIso(-120_000),
        ),
    ).not.toThrow();

    expect(() =>
      getDb()
        .prepare(
          `INSERT INTO messaging_group_agents
             (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, sender_scope, ignored_message_policy, session_mode, priority, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('mga-unrelated', 'mg-unrelated', 'ag-other', 'pattern', '.', 'all', 'drop', 'shared', 0, nowIso(-120_000)),
    ).not.toThrow();

    expect(normalizeBoundBagetTelegramFounderChannels()).toBe(2);

    expect(getMessagingGroupByPlatform(BAGET_TELEGRAM_CHANNEL_TYPE, `baget-telegram:${CHAT_ID + 1}`)).toMatchObject({
      unknown_sender_policy: 'public',
      is_group: 0,
      denied_at: null,
    });
    expect(getMessagingGroupAgentByPair('mg-existing-bound', AGENT_GROUP_ID)).toMatchObject({
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      priority: 0,
    });
    expect(getMessagingGroupByPlatform(BAGET_TELEGRAM_CHANNEL_TYPE, `baget-telegram:${CHAT_ID + 2}`)).toMatchObject({
      unknown_sender_policy: 'request_approval',
      is_group: 1,
    });
  });

  it('debounces rapid-fire DMs from the same chat into a single onInbound call (newline-joined)', async () => {
    // Three messages in fast succession — the nervous-founder pattern
    // we're explicitly building this util to absorb. Webhook ACKs are
    // synchronous; the actual debouncer push fires off a setImmediate
    // chain. With inboundDebounceMs=100 (set in beforeEach) all three
    // pushes land before the timer fires.
    await Promise.all([
      fetch(`${baseUrl}/api/channels/telegram/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
        body: JSON.stringify(makeUpdate(301, 'hey')),
      }),
      fetch(`${baseUrl}/api/channels/telegram/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
        body: JSON.stringify(makeUpdate(302, 'hello')),
      }),
      fetch(`${baseUrl}/api/channels/telegram/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
        body: JSON.stringify(makeUpdate(303, 'are you there?')),
      }),
    ]);

    await waitFor(() => inboundEvents.length === 1);

    // Single coalesced event — nothing else flushes after.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(inboundEvents).toHaveLength(1);

    expect(inboundEvents[0]).toMatchObject({
      platformId: `baget-telegram:${CHAT_ID}`,
      threadId: null,
      message: {
        // Carry-from-latest: id and timestamp come from the LAST
        // message in the burst.
        id: 'tg-303',
        kind: 'chat',
        isMention: true,
        isGroup: false,
      },
    });
    const content = inboundEvents[0]!.message.content as { text: string; sender: string; senderId: string };
    expect(content.text).toBe('hey\nhello\nare you there?');
    expect(content.sender).toBe('Sam');
    expect(content.senderId).toBe('telegram:9001');
  });

  it('does not coalesce DMs separated by more than the debounce window', async () => {
    // Sanity check: the timer is a real timer, not a "process all
    // messages in one batch forever" trap. Two messages well outside
    // the 100ms window should produce two separate inbound events.
    await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
      body: JSON.stringify(makeUpdate(401, 'first')),
    });
    await waitFor(() => inboundEvents.length === 1);

    await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
      body: JSON.stringify(makeUpdate(402, 'second')),
    });
    await waitFor(() => inboundEvents.length === 2);

    expect((inboundEvents[0]!.message.content as { text: string }).text).toBe('first');
    expect((inboundEvents[1]!.message.content as { text: string }).text).toBe('second');
  });

  it('edited messages bypass the debouncer — they replace, not append', async () => {
    // Edits coalesced with their original would produce garbled
    // "hello\nhellow" output. Route them immediately so the agent
    // sees the edited version as its own event.
    await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
      body: JSON.stringify(makeEditedUpdate(601, 'I meant: investor update by EOD')),
    });

    // No debounce wait — the edit should land immediately.
    await waitFor(() => inboundEvents.length === 1, 90);
    expect((inboundEvents[0]!.message.content as { text: string }).text).toBe('I meant: investor update by EOD');
  });

  it('/start <token> bypasses the debouncer — pairing fires immediately even with a buffered regular message', async () => {
    // Buffer a regular message first (it will sit in the debouncer for
    // up to 100ms). Then send /start <token> on the same chat. The
    // command must NOT wait for the debouncer to flush — pairing is a
    // protocol action that needs to land instantly.
    await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
      body: JSON.stringify(makeUpdate(501, 'wait what was the link again')),
    });

    // Send /start before the debounce window elapses.
    await fetch(`${baseUrl}/api/channels/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET },
      body: JSON.stringify(makeUpdate(502, `/start ${RAW_TOKEN}`)),
    });

    // Pairing welcome should land within ~25ms (no debounce on /start).
    // We poll for the welcome BEFORE the buffered "wait what" flushes
    // (which would take ~100ms from the time of THAT push).
    await waitFor(() => outbound.length === 1, 90);
    expect(outbound[0]?.body.text).toContain('Louis');

    // Eventually the buffered regular message DOES flush (the debouncer
    // doesn't drop pending items just because a command came in).
    await waitFor(() => inboundEvents.length === 1);
    expect((inboundEvents[0]!.message.content as { text: string }).text).toBe('wait what was the link again');
  });
});

// Direct unit test for the coalesce helper. Validates the text-join +
// carry-from-latest behavior independently of the webhook plumbing —
// catches regressions to the merge logic without spinning up the
// full describe('Baget Telegram adapter') fixture.
describe('coalesceInboundMessages (debouncer hook)', () => {
  it('joins texts with newlines and keeps the latest message metadata', () => {
    const a = {
      id: 'tg-1',
      kind: 'chat' as const,
      timestamp: '2026-05-04T10:00:00.000Z',
      content: { text: 'hey', sender: 'Sam', senderId: 'telegram:9001' },
      isMention: true,
      isGroup: false,
    };
    const b = {
      id: 'tg-2',
      kind: 'chat' as const,
      timestamp: '2026-05-04T10:00:00.500Z',
      content: { text: 'are you there?', sender: 'Sam', senderId: 'telegram:9001' },
      isMention: true,
      isGroup: false,
    };
    const merged = _testCoalesceInboundMessages([a, b]);
    expect(merged.id).toBe('tg-2');
    expect(merged.timestamp).toBe('2026-05-04T10:00:00.500Z');
    expect(merged.isMention).toBe(true);
    expect(merged.isGroup).toBe(false);
    expect((merged.content as { text: string }).text).toBe('hey\nare you there?');
    expect((merged.content as { sender: string }).sender).toBe('Sam');
  });

  it('skips empty-string content entries when joining', () => {
    const a = {
      id: 'tg-1',
      kind: 'chat' as const,
      timestamp: '2026-05-04T10:00:00.000Z',
      content: { text: '', sender: 'Sam', senderId: 'telegram:9001' },
    };
    const b = {
      id: 'tg-2',
      kind: 'chat' as const,
      timestamp: '2026-05-04T10:00:00.500Z',
      content: { text: 'real message', sender: 'Sam', senderId: 'telegram:9001' },
    };
    const merged = _testCoalesceInboundMessages([a, b]);
    expect((merged.content as { text: string }).text).toBe('real message');
  });

  it('passes a single buffered item through unchanged shape', () => {
    const a = {
      id: 'tg-7',
      kind: 'chat' as const,
      timestamp: '2026-05-04T10:00:07.000Z',
      content: { text: 'just one', sender: 'Sam', senderId: 'telegram:9001' },
      isMention: false,
      isGroup: true,
    };
    const merged = _testCoalesceInboundMessages([a]);
    expect(merged).toMatchObject({
      id: 'tg-7',
      timestamp: '2026-05-04T10:00:07.000Z',
      isMention: false,
      isGroup: true,
    });
    expect((merged.content as { text: string }).text).toBe('just one');
  });

  it('throws on empty buffer (defensive — debouncer never calls with []), surfacing the bug instead of crashing in a timer', () => {
    expect(() => _testCoalesceInboundMessages([])).toThrow('empty buffer');
  });

  it('truncates the joined text when it exceeds the 16k cap (paste-storm guard)', () => {
    // 50 messages of 500 chars each = 25KB raw — well over the cap.
    // The agent should see a truncation marker so it knows to ask
    // for a re-send if the truncation cut something important.
    const items = Array.from({ length: 50 }, (_, i) => ({
      id: `tg-${i}`,
      kind: 'chat' as const,
      timestamp: `2026-05-04T10:00:${String(i).padStart(2, '0')}.000Z`,
      content: { text: 'x'.repeat(500), sender: 'Sam', senderId: 'telegram:9001' },
    }));
    const merged = _testCoalesceInboundMessages(items);
    const text = (merged.content as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(16000);
    expect(text).toMatch(/\[truncated by debouncer\]$/);
  });

  it('does not split a UTF-16 surrogate pair when truncating (emoji-safe)', () => {
    // 🔥 (U+1F525, FIRE) is a non-BMP codepoint encoded as a surrogate
    // pair `🔥` (2 code units). A naive slice that lands
    // between the two units orphans the high surrogate, producing a
    // lone `\uD83D` that crashes JSON consumers downstream or renders
    // as `�`. Feed a 3-message buffer where the cut would otherwise
    // land mid-emoji; assert the truncated text contains no orphan
    // high-surrogate code units.
    //
    // Build a single message that, after joining, would force the cut
    // to land at exactly the high-surrogate boundary of an emoji.
    // Cut position = 16000 - SUFFIX_LEN. We size the prefix so the cut
    // falls on a high surrogate (the FIRST code unit of an emoji).
    const SUFFIX = '\n…[truncated by debouncer]';
    const cutAt = 16000 - SUFFIX.length;
    // Place the emoji starting exactly at index `cutAt - 1` so that
    // index `cutAt` would be the LOW half of the pair — the naive
    // slice would keep the high half and orphan it.
    const padding = 'a'.repeat(cutAt - 1);
    const trailingFill = '🔥'.repeat(200); // plenty of trailing material
    const items = [
      {
        id: 'tg-1',
        kind: 'chat' as const,
        timestamp: '2026-05-04T10:00:00.000Z',
        content: { text: padding + trailingFill, sender: 'Sam', senderId: 'telegram:9001' },
      },
    ];
    const merged = _testCoalesceInboundMessages(items);
    const text = (merged.content as { text: string }).text;
    // No orphan high surrogate (0xD800..0xDBFF) without a paired low
    // surrogate (0xDC00..0xDFFF) immediately after it.
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
        i++; // skip the low surrogate
      } else {
        // Conversely, no orphan low surrogate either.
        expect(code < 0xdc00 || code > 0xdfff).toBe(true);
      }
    }
    expect(text).toMatch(/\[truncated by debouncer\]$/);
  });
});

// `parseTeamMembers` is the JSON-roundtrip gate between the
// `agent_groups.baget_team_members` column and `applyPersonaPrefix`.
// Before partial-team support, this gate required ALL six roles to be
// present-as-strings — which silently broke the entire delivery
// persona-prefix path for apprenti / artisan founders.
describe('parseTeamMembers (JSON-roundtrip gate)', () => {
  it('accepts the full six-role payload (older baget.ai builds, atelier+)', () => {
    const json = JSON.stringify({
      cos: 'Louis',
      developer: 'Valentin',
      marketing: 'Chloé',
      analyst: 'Théo',
      design: 'Nicolas',
      ops: 'Tristan',
    });
    const parsed = _testParseTeamMembers(json);
    expect(parsed).toEqual({
      cos: 'Louis',
      developer: 'Valentin',
      marketing: 'Chloé',
      analyst: 'Théo',
      design: 'Nicolas',
      ops: 'Tristan',
    });
  });

  it('accepts apprenti-shaped payload (cos only)', () => {
    expect(_testParseTeamMembers(JSON.stringify({ cos: 'Raphaël' }))).toEqual({ cos: 'Raphaël' });
  });

  it('accepts artisan-shaped payload (cos + 2 specialists)', () => {
    const parsed = _testParseTeamMembers(JSON.stringify({ cos: 'Raphaël', developer: 'Valentin', marketing: 'Chloé' }));
    expect(parsed).toEqual({ cos: 'Raphaël', developer: 'Valentin', marketing: 'Chloé' });
  });

  it('accepts payload with explicit-null specialist (treated as absent)', () => {
    // Some serializers emit `null` for absent JSON fields. We treat
    // null the same as missing — keep cos, drop the null entry.
    const parsed = _testParseTeamMembers(JSON.stringify({ cos: 'Raphaël', analyst: null }));
    expect(parsed).toEqual({ cos: 'Raphaël', analyst: null });
  });

  it('rejects payload missing cos', () => {
    expect(_testParseTeamMembers(JSON.stringify({ developer: 'V' }))).toBeNull();
  });

  it('rejects payload with empty-string cos', () => {
    expect(_testParseTeamMembers(JSON.stringify({ cos: '' }))).toBeNull();
  });

  it('rejects payload with whitespace-only cos', () => {
    expect(_testParseTeamMembers(JSON.stringify({ cos: '   ' }))).toBeNull();
  });

  it('rejects payload with non-string specialist value (dashboard write bug)', () => {
    expect(_testParseTeamMembers(JSON.stringify({ cos: 'Raphaël', analyst: 12345 }))).toBeNull();
  });

  it('rejects payload with empty-string specialist value', () => {
    expect(_testParseTeamMembers(JSON.stringify({ cos: 'Raphaël', developer: '' }))).toBeNull();
  });

  it('rejects malformed JSON', () => {
    expect(_testParseTeamMembers('{not json}')).toBeNull();
  });

  it('rejects JSON arrays (must be an object)', () => {
    expect(_testParseTeamMembers('["Raphaël"]')).toBeNull();
  });

  it('rejects null and empty inputs', () => {
    expect(_testParseTeamMembers(null)).toBeNull();
    expect(_testParseTeamMembers(undefined)).toBeNull();
    expect(_testParseTeamMembers('')).toBeNull();
  });
});
