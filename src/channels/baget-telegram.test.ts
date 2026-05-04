import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createBagetAdminServer } from '../baget-admin-server.js';
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
