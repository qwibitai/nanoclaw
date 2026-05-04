/**
 * Tests for POST /baget/agent-groups/:id/celebrate.
 *
 * Covers:
 *   - Valid payload delivers to all bound messaging groups
 *   - 404 on unknown / archived agent group
 *   - 400 on invalid body shapes
 *   - Adapter not found → graceful skip
 *   - Adapter deliver throws → warn + continue
 *   - streakDays and deliverables passed through
 *   - Multi-group delivery
 *   - Auth required (401 without bearer)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from './db/index.js';
import { createBagetAdminServer } from './baget-admin-server.js';
import { archiveBagetAgentGroup, createBagetAgentGroup } from './db/baget-agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from './db/messaging-groups.js';
import type { ChannelAdapter, OutboundMessage } from './channels/adapter.js';
import { log } from './log.js';

const ADMIN_TOKEN = 'test-admin-celebrate-abc12345';

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeAdapter(
  deliverFn: (platformId: string, threadId: string | null, msg: OutboundMessage) => Promise<string | undefined>,
): ChannelAdapter {
  return {
    name: 'mock',
    channelType: 'baget-telegram',
    supportsThreads: false,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: deliverFn,
  };
}

describe('POST /baget/agent-groups/:id/celebrate', () => {
  let port: number;
  let baseUrl: string;
  let server: ReturnType<typeof createBagetAdminServer> | null = null;
  let deliveredMessages: Array<{ platformId: string; threadId: string | null; msg: OutboundMessage }> = [];
  let mockAdapter: ChannelAdapter;

  beforeEach(async () => {
    initTestDb();
    runMigrations(getDb());

    deliveredMessages = [];
    mockAdapter = makeAdapter(async (platformId, threadId, msg) => {
      deliveredMessages.push({ platformId, threadId, msg });
      return 'msg-1';
    });

    createBagetAgentGroup({
      id: 'ag-celebrate',
      name: 'Celebrate Co',
      folder: 'celebrate-co',
      user_id: 'user-cel',
      company_id: 'co-cel',
      baget_team_members: JSON.stringify({ cos: 'Louis' }),
      created_at: nowIso(),
    });

    // Wire a messaging group for the agent
    createMessagingGroup({
      id: 'mg-cel-1',
      channel_type: 'baget-telegram',
      platform_id: 'baget-telegram:11111',
      name: 'Sam',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: nowIso(),
    });
    createMessagingGroupAgent({
      id: 'mga-cel-1',
      messaging_group_id: 'mg-cel-1',
      agent_group_id: 'ag-celebrate',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: nowIso(),
    });

    port = 35000 + Math.floor(Math.random() * 1000);
    baseUrl = `http://127.0.0.1:${port}`;
    server = createBagetAdminServer({
      port,
      adminToken: ADMIN_TOKEN,
      telegramBotUsername: 'baget_test_bot',
      generateAgentGroupId: () => 'unused',
      getChannelAdapterFn: () => mockAdapter,
    });
    await server.listen();
  });

  afterEach(async () => {
    await server?.close();
    closeDb();
    server = null;
  });

  async function celebrate(agentGroupId: string, body: unknown, token = ADMIN_TOKEN) {
    return fetch(`${baseUrl}/baget/agent-groups/${agentGroupId}/celebrate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  it('delivers celebration to bound messaging group', async () => {
    const resp = await celebrate('ag-celebrate', { batchNumber: 3, summary: 'Shipped MVP.' });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { ok: boolean; delivered: unknown[] };
    expect(json.ok).toBe(true);
    expect(json.delivered).toHaveLength(1);

    expect(deliveredMessages).toHaveLength(1);
    const { platformId, threadId, msg } = deliveredMessages[0]!;
    expect(platformId).toBe('baget-telegram:11111');
    expect(threadId).toBeNull();
    expect(msg.kind).toBe('celebration');
    expect((msg.content as { batchNumber: number }).batchNumber).toBe(3);
    expect((msg.content as { summary: string }).summary).toBe('Shipped MVP.');
  });

  it('passes streakDays and deliverables through to the adapter', async () => {
    const resp = await celebrate('ag-celebrate', {
      batchNumber: 7,
      summary: 'Landing page live.',
      streakDays: 5,
      deliverables: [{ label: 'Landing page', href: 'https://baget.ai' }],
    });
    expect(resp.status).toBe(200);
    const content = deliveredMessages[0]!.msg.content as {
      batchNumber: number;
      streakDays: number;
      deliverables: { label: string; href: string }[];
    };
    expect(content.streakDays).toBe(5);
    expect(content.deliverables).toHaveLength(1);
    expect(content.deliverables[0]!.label).toBe('Landing page');
  });

  it('delivers to all bound messaging groups in a multi-group setup', async () => {
    createMessagingGroup({
      id: 'mg-cel-2',
      channel_type: 'baget-telegram',
      platform_id: 'baget-telegram:22222',
      name: 'Other',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: nowIso(),
    });
    createMessagingGroupAgent({
      id: 'mga-cel-2',
      messaging_group_id: 'mg-cel-2',
      agent_group_id: 'ag-celebrate',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: nowIso(),
    });

    const resp = await celebrate('ag-celebrate', { batchNumber: 1, summary: 'First!' });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { ok: boolean; delivered: unknown[] };
    expect(json.delivered).toHaveLength(2);
    expect(deliveredMessages).toHaveLength(2);
    const platformIds = deliveredMessages.map((m) => m.platformId).sort();
    expect(platformIds).toEqual(['baget-telegram:11111', 'baget-telegram:22222']);
  });

  it('returns 404 for unknown agent group', async () => {
    const resp = await celebrate('ag-nonexistent', { batchNumber: 1, summary: 'x' });
    expect(resp.status).toBe(404);
    const json = (await resp.json()) as { ok: boolean; error: string };
    expect(json.ok).toBe(false);
    expect(json.error).toBe('group_not_found');
  });

  it('returns 404 for archived agent group', async () => {
    createBagetAgentGroup({
      id: 'ag-archived',
      name: 'Old Co',
      folder: 'old-co',
      user_id: 'user-old',
      company_id: 'co-old',
      baget_team_members: JSON.stringify({ cos: 'Louis' }),
      created_at: nowIso(),
    });
    archiveBagetAgentGroup('ag-archived', nowIso(-1000));
    const resp = await celebrate('ag-archived', { batchNumber: 1, summary: 'x' });
    expect(resp.status).toBe(404);
  });

  it('returns 400 when batchNumber is missing', async () => {
    const resp = await celebrate('ag-celebrate', { summary: 'x' });
    expect(resp.status).toBe(400);
    const json = (await resp.json()) as { error: string };
    expect(json.error).toBe('invalid_body');
  });

  it('returns 400 when batchNumber is 0', async () => {
    const resp = await celebrate('ag-celebrate', { batchNumber: 0, summary: 'x' });
    expect(resp.status).toBe(400);
  });

  it('returns 400 when summary is empty', async () => {
    const resp = await celebrate('ag-celebrate', { batchNumber: 1, summary: '' });
    expect(resp.status).toBe(400);
  });

  it('returns 400 when streakDays is present but invalid', async () => {
    const resp = await celebrate('ag-celebrate', { batchNumber: 1, summary: 'x', streakDays: 0 });
    expect(resp.status).toBe(400);
  });

  it('returns 400 when deliverables contains an item without label', async () => {
    const resp = await celebrate('ag-celebrate', {
      batchNumber: 1,
      summary: 'x',
      deliverables: [{ href: 'https://example.com' }],
    });
    expect(resp.status).toBe(400);
  });

  it('returns 401 without bearer token', async () => {
    const resp = await fetch(`${baseUrl}/baget/agent-groups/ag-celebrate/celebrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchNumber: 1, summary: 'x' }),
    });
    expect(resp.status).toBe(401);
  });

  it('skips gracefully when no adapter is found for a channel type', async () => {
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const serverNoAdapter = createBagetAdminServer({
      port: port + 500,
      adminToken: ADMIN_TOKEN,
      telegramBotUsername: 'baget_test_bot',
      generateAgentGroupId: () => 'unused',
      getChannelAdapterFn: () => null,
    });
    await serverNoAdapter.listen();
    try {
      const resp = await fetch(`http://127.0.0.1:${port + 500}/baget/agent-groups/ag-celebrate/celebrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ batchNumber: 2, summary: 'Testing skip.' }),
      });
      expect(resp.status).toBe(200);
      const json = (await resp.json()) as { ok: boolean; delivered: unknown[] };
      expect(json.ok).toBe(true);
      expect(json.delivered).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        'Baget celebrate: no adapter for channel_type',
        expect.objectContaining({ channelType: 'baget-telegram' }),
      );
    } finally {
      await serverNoAdapter.close();
      warnSpy.mockRestore();
    }
  });

  it('logs warn and continues when adapter.deliver throws', async () => {
    const throwingAdapter = makeAdapter(async () => {
      throw new Error('Telegram is down');
    });
    const warnSpy = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const serverThrow = createBagetAdminServer({
      port: port + 501,
      adminToken: ADMIN_TOKEN,
      telegramBotUsername: 'baget_test_bot',
      generateAgentGroupId: () => 'unused',
      getChannelAdapterFn: () => throwingAdapter,
    });
    await serverThrow.listen();
    try {
      const resp = await fetch(`http://127.0.0.1:${port + 501}/baget/agent-groups/ag-celebrate/celebrate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_TOKEN}` },
        body: JSON.stringify({ batchNumber: 5, summary: 'Throw test.' }),
      });
      expect(resp.status).toBe(200);
      const json = (await resp.json()) as { ok: boolean; delivered: unknown[] };
      expect(json.ok).toBe(true);
      expect(json.delivered).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        'Baget celebrate: deliver threw',
        expect.objectContaining({ channelType: 'baget-telegram' }),
      );
    } finally {
      await serverThrow.close();
      warnSpy.mockRestore();
    }
  });
});
