/**
 * Per-wiring channel permission tests — `permission` column on
 * `messaging_group_agents` (migration 014).
 *
 * Inbound (`write` is post-only): router skips the wiring with a log.warn;
 *   no session is spawned. (See src/router.ts.)
 * Outbound (`read` is monitor-only): delivery skips with a log.warn and
 *   marks the row failed; subsequent ticks see the message as already-
 *   delivered (status='failed' lives in the same `delivered` table that
 *   `getDeliveredIds` filters on), so the adapter is never re-invoked.
 *   (See src/delivery.ts.)
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-wiring-permission' };
});

const TEST_DIR = '/tmp/nanoclaw-test-wiring-permission';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { findSession } from './db/sessions.js';
import { resolveSession, inboundDbPath, outboundDbPath } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';
import type { InboundEvent } from './channels/adapter.js';
import type { WiringPermission } from './types.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgentAndChannel(permission: WiringPermission): void {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'discord',
    platform_id: 'chan-test',
    name: 'Channel',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    permission,
    created_at: now(),
  });
}

function insertOutbound(agentGroupId: string, sessionId: string, msgId: string): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, datetime('now'), 'chat', 'chan-test', 'discord', ?)`,
  ).run(msgId, JSON.stringify({ text: 'agent reply' }));
  db.close();
}

function inboundEvent(): InboundEvent {
  return {
    channelType: 'discord',
    platformId: 'chan-test',
    threadId: null,
    message: {
      id: 'msg-in',
      kind: 'chat',
      content: JSON.stringify({ sender: 'User', text: 'hello' }),
      timestamp: now(),
    },
  };
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('wiring permission', () => {
  it('read+write: routes inbound and delivers outbound', async () => {
    seedAgentAndChannel('read+write');

    // Inbound side: routeInbound creates a session and stores the message.
    const { routeInbound } = await import('./router.js');
    await routeInbound(inboundEvent());

    const session = findSession('mg-1', null);
    expect(session).toBeDefined();
    const inRows = new Database(inboundDbPath('ag-1', session!.id))
      .prepare('SELECT id FROM messages_in')
      .all() as Array<{ id: string }>;
    expect(inRows).toHaveLength(1);

    // Outbound side: a queued reply hits the adapter exactly once.
    insertOutbound('ag-1', session!.id, 'out-ok');
    const calls: string[] = [];
    setDeliveryAdapter({
      async deliver(_ct, _pid, _tid, _kind, content) {
        calls.push(content);
        return 'plat-1';
      },
    });
    await deliverSessionMessages(session!);
    expect(calls).toHaveLength(1);
  });

  it('write-only: router skips the wiring on inbound, no session is spawned', async () => {
    seedAgentAndChannel('write');
    const { routeInbound } = await import('./router.js');
    await routeInbound(inboundEvent());

    expect(findSession('mg-1', null)).toBeUndefined();
  });

  it('read-only: delivery skips outbound, marks failed, and never retries', async () => {
    seedAgentAndChannel('read');
    const { session } = resolveSession('ag-1', 'mg-1', null, 'shared');
    insertOutbound('ag-1', session.id, 'out-blocked');

    let adapterCalls = 0;
    setDeliveryAdapter({
      async deliver() {
        adapterCalls++;
        return 'should-not-be-called';
      },
    });

    // Three consecutive ticks: the adapter must never be invoked. The
    // first tick marks the row failed; subsequent ticks see it as
    // already-recorded in the `delivered` table and skip.
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(adapterCalls).toBe(0);

    const inDb = new Database(inboundDbPath('ag-1', session.id));
    const failed = inDb.prepare("SELECT message_out_id FROM delivered WHERE status = 'failed'").all() as Array<{
      message_out_id: string;
    }>;
    inDb.close();
    expect(failed).toHaveLength(1);
    expect(failed[0].message_out_id).toBe('out-blocked');
  });
});
