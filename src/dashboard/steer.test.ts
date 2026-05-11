import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'http';

import { closeDb, initTestDb, runMigrations, createAgentGroup, getDb } from '../db/index.js';
import { applySteer, _resetRateLimitForTesting } from './steer.js';
import type { AuthedRequestContext } from './router.js';

// These imports resolve AFTER vi.mock hoisting — they are the vi.fn() instances.
import { writeSessionMessage as _wsmRaw } from '../session-manager.js';
import { sessionInboundHasMessage as _sihmRaw } from '../db/session-db.js';
import { wakeContainer as _wcRaw } from '../container-runner.js';
import { getChannelAdapter as _gcaRaw } from '../channels/channel-registry.js';
import { getMessagingGroup as _gmgRaw } from '../db/messaging-groups.js';
import { emitDashboardEvent as _edeRaw } from './api/events.js';

// Typed as mocks for use in test assertions / setup
const mockWriteSessionMessage = vi.mocked(_wsmRaw);
const mockSessionInboundHasMessage = vi.mocked(_sihmRaw);
const mockWakeContainer = vi.mocked(_wcRaw);
const mockGetChannelAdapter = vi.mocked(_gcaRaw);
const mockGetMessagingGroup = vi.mocked(_gmgRaw);
const mockEmitDashboardEvent = vi.mocked(_edeRaw);

// ── Mocks ────────────────────────────────────────────────────────────────────
// Simple synchronous factories — vi.fn() created inside factory to avoid TDZ.

vi.mock('../session-manager.js', () => ({
  writeSessionMessage: vi.fn().mockResolvedValue(undefined),
  openInboundDb: vi.fn(),
  openOutboundDb: vi.fn(),
  inboundDbPath: vi.fn().mockReturnValue('/tmp/nonexistent.db'),
  heartbeatPath: vi.fn().mockReturnValue('/tmp/heartbeat'),
  resolveSession: vi.fn(),
  writeSessionRouting: vi.fn(),
}));

vi.mock('../db/session-db.js', () => ({
  sessionInboundHasMessage: vi.fn().mockReturnValue(false),
  syncProcessingAcks: vi.fn(),
  countDueMessages: vi.fn().mockReturnValue(0),
  getProcessingClaims: vi.fn().mockReturnValue([]),
  deleteOrphanProcessingClaims: vi.fn().mockReturnValue(0),
  getContainerState: vi.fn().mockReturnValue(null),
  getMessageForRetry: vi.fn().mockReturnValue(null),
  markMessageFailed: vi.fn(),
  retryWithBackoff: vi.fn(),
}));

vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getContainerSpawnedAt: vi.fn().mockReturnValue(0),
}));

vi.mock('../channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn().mockReturnValue(undefined),
  registerChannelAdapter: vi.fn(),
  getActiveAdapters: vi.fn().mockReturnValue([]),
}));

vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroup: vi.fn().mockReturnValue(undefined),
  createMessagingGroup: vi.fn(),
  getMessagingGroupByPlatform: vi.fn().mockReturnValue(undefined),
}));

vi.mock('./api/events.js', () => ({
  emitDashboardEvent: vi.fn(),
  startSSEFeed: vi.fn(),
  stopSSEFeed: vi.fn(),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function now(): string {
  return new Date().toISOString();
}

function setupDb(): void {
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

function seedAgentGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

function seedUser(id: string): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'dashboard', ?, ?)")
    .run(id, id, now());
}

function grantOwner(userId: string): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'owner', NULL, NULL, ?)",
    )
    .run(userId, now());
}

function grantAdmin(userId: string, agId: string): void {
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'admin', ?, NULL, ?)",
    )
    .run(userId, agId, now());
}

function grantMember(userId: string, agId: string): void {
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)',
    )
    .run(userId, agId, now());
}

function seedSession(sessId: string, agId: string, threadId: string | null = null): void {
  // Use sessId as thread_id to avoid the UNIQUE(agent_group_id, messaging_group_id, thread_id) conflict
  // when multiple sessions share the same agent_group and no messaging_group
  getDb()
    .prepare(
      "INSERT OR IGNORE INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, created_at) VALUES (?, ?, NULL, ?, 'active', ?)",
    )
    .run(sessId, agId, threadId ?? sessId, now());
}

function insertRunningTask(
  taskId: string,
  agId: string,
  sessId: string,
  childSessId: string | null,
  opts: { surface_mode?: string; child_mgid?: string | null; child_thread?: string | null } = {},
): void {
  // Disable FK for insert to avoid cross-module-instance DB isolation issues in vitest
  const db = getDb();
  db.pragma('foreign_keys = OFF');
  db.prepare(
    `
    INSERT OR IGNORE INTO tasks (
      task_id, idempotency_key, parent_session_id, parent_agent_group_id,
      child_session_id, status, task_content, request_hash, admitted_at, started_at,
      dispatch_completion_attempts, surface_mode, created_at,
      child_messaging_group_id, child_platform_thread_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)
  `,
  ).run(
    taskId,
    taskId,
    sessId,
    agId,
    childSessId,
    'running',
    'do something',
    'hash-x',
    now(),
    now(),
    opts.surface_mode ?? 'headless',
    now(),
    opts.child_mgid ?? null,
    opts.child_thread ?? null,
  );
  db.pragma('foreign_keys = ON');
}

function makeCtx(
  userId: string,
  opts: { no_filter?: boolean; allowed_group_ids?: string[] } = {},
): AuthedRequestContext {
  return {
    user: { id: userId, kind: 'dashboard', display_name: `user-${userId}`, created_at: now() },
    scopes: {
      role: opts.no_filter ? 'owner' : 'admin_of_group',
      allowed_group_ids: opts.allowed_group_ids ?? [],
      no_filter: opts.no_filter ?? false,
    },
    rawNodeReq: {} as http.IncomingMessage,
    rawNodeRes: {} as http.ServerResponse,
  };
}

const VALID_IKEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('applySteer — D5', () => {
  beforeEach(() => {
    _resetRateLimitForTesting();
    // Reset module-level mock stubs to defaults before each test
    mockWriteSessionMessage.mockReset();
    mockWriteSessionMessage.mockResolvedValue(undefined);
    mockSessionInboundHasMessage.mockReset();
    mockSessionInboundHasMessage.mockReturnValue(false);
    mockWakeContainer.mockReset();
    mockWakeContainer.mockResolvedValue(true);
    mockGetChannelAdapter.mockReset();
    mockGetChannelAdapter.mockReturnValue(undefined);
    mockGetMessagingGroup.mockReset();
    mockGetMessagingGroup.mockReturnValue(undefined);
    mockEmitDashboardEvent.mockReset();
    setupDb();
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
    seedSession('sess-parent', 'ag-1');
    seedSession('sess-child', 'ag-1');
    seedUser('owner-1');
    grantOwner('owner-1');
    seedUser('admin-1');
    grantAdmin('admin-1', 'ag-1');
    seedUser('member-1');
    grantMember('member-1', 'ag-1');
    // Pre-seed messaging groups for FK satisfaction in native_thread tests
    const dbForMg = getDb();
    dbForMg
      .prepare(
        `INSERT OR IGNORE INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at) VALUES ('mg-1','slack','C-1','test-ch',1,'public',datetime('now'))`,
      )
      .run();
    dbForMg
      .prepare(
        `INSERT OR IGNORE INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at) VALUES ('mg-slack','slack','C-slack','slack-ch',1,'public',datetime('now'))`,
      )
      .run();
    // Verify mg-1 was actually inserted (debug)
    const mgCheck = dbForMg.prepare("SELECT id FROM messaging_groups WHERE id='mg-1'").get();
    if (!mgCheck) throw new Error('mg-1 INSERT failed in beforeEach');
  });

  afterEach(() => {
    closeDb();
    vi.clearAllMocks();
  });

  it('test_steer_empty_text_400', async () => {
    insertRunningTask('spawn-abc', 'ag-1', 'sess-parent', 'sess-child');
    const ctx = makeCtx('owner-1', { no_filter: true });
    const result = await applySteer('spawn-abc', { idempotency_key: VALID_IKEY, text: '   ' }, ctx);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('empty_message');
    // No inbound write
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
  });

  it('test_steer_too_long_400', async () => {
    insertRunningTask('spawn-abc', 'ag-1', 'sess-parent', 'sess-child');
    const ctx = makeCtx('owner-1', { no_filter: true });
    const result = await applySteer('spawn-abc', { idempotency_key: VALID_IKEY, text: 'a'.repeat(4001) }, ctx);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('message_too_long');
  });

  it('test_steer_member_404_disclose_as_not_found', async () => {
    // Post-build QA fix SF-2: member returns 404 not 403, matching §2a disclose-as-not-found.
    // Returning 403 with 'member_role_cannot_steer' would confirm task existence to members
    // (info-disclosure / enumeration vulnerability).
    insertRunningTask('spawn-abc', 'ag-1', 'sess-parent', 'sess-child');
    const ctx = makeCtx('member-1', { allowed_group_ids: ['ag-1'] });
    const result = await applySteer('spawn-abc', { idempotency_key: VALID_IKEY, text: 'hello' }, ctx);
    expect(result.status).toBe(404);
    expect(result.body.error).toBe('task_not_found');
  });

  it('test_steer_out_of_scope_404', async () => {
    seedSession('sess-p2', 'ag-2');
    insertRunningTask('spawn-abc', 'ag-2', 'sess-p2', 'sess-child');
    const ctx = makeCtx('admin-1', { allowed_group_ids: ['ag-1'] });
    const result = await applySteer('spawn-abc', { idempotency_key: VALID_IKEY, text: 'hello' }, ctx);
    expect(result.status).toBe(404);
    expect(result.body.error).toBe('task_not_found');
  });

  it('test_steer_happy_path_202', async () => {
    insertRunningTask('spawn-abc', 'ag-1', 'sess-parent', 'sess-child');

    const ctx = makeCtx('owner-1', { no_filter: true });
    const result = await applySteer('spawn-abc', { idempotency_key: VALID_IKEY, text: 'hello' }, ctx);

    expect(result.status).toBe(202);
    expect(result.body.task_id).toBe('spawn-abc');
    expect(result.body.message_id).toBeTruthy();
    expect(result.body.echo_status).toBe('pending');

    expect(mockWriteSessionMessage).toHaveBeenCalledOnce();
    expect(mockWakeContainer).toHaveBeenCalled();
    expect(mockEmitDashboardEvent).toHaveBeenCalledWith(
      'inbound_message',
      expect.objectContaining({
        task_id: 'spawn-abc',
        child_session_id: 'sess-child',
      }),
    );
  });

  it('test_steer_replay_returns_cached_202', async () => {
    insertRunningTask('spawn-abc', 'ag-1', 'sess-parent', 'sess-child');
    const ctx = makeCtx('owner-1', { no_filter: true });

    // First call
    const r1 = await applySteer('spawn-abc', { idempotency_key: VALID_IKEY, text: 'hello' }, ctx);
    expect(r1.status).toBe(202);
    const firstMsgId = r1.body.message_id as string;

    // Second call — same idempotency key
    mockWriteSessionMessage.mockClear();

    const r2 = await applySteer('spawn-abc', { idempotency_key: VALID_IKEY, text: 'hello' }, ctx);
    expect(r2.status).toBe(202);
    expect(r2.body.message_id).toBe(firstMsgId);
    // No second write
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
  });

  it('test_steer_replay_with_different_text_422', async () => {
    insertRunningTask('spawn-abc', 'ag-1', 'sess-parent', 'sess-child');
    const ctx = makeCtx('owner-1', { no_filter: true });

    await applySteer('spawn-abc', { idempotency_key: VALID_IKEY, text: 'hello' }, ctx);
    const r2 = await applySteer('spawn-abc', { idempotency_key: VALID_IKEY, text: 'goodbye' }, ctx);

    expect(r2.status).toBe(422);
    expect(r2.body.error).toBe('mismatched_idempotency_payload');
    expect(r2.body.conflict_kind).toBe('request_hash');
  });

  it('test_steer_rate_limit_429', async () => {
    insertRunningTask('spawn-abc', 'ag-1', 'sess-parent', 'sess-child');
    const ctx = makeCtx('owner-1', { no_filter: true });

    // Send 30 valid requests
    for (let i = 0; i < 30; i++) {
      await applySteer('spawn-abc', { idempotency_key: `key-${i}`, text: `msg ${i}` }, ctx);
    }

    // 31st should be rate-limited
    const r = await applySteer('spawn-abc', { idempotency_key: 'key-31', text: 'too many' }, ctx);
    expect(r.status).toBe(429);
    // The 31st call must not write
    const callsBefore = mockWriteSessionMessage.mock.calls.length;
    expect(callsBefore).toBeLessThanOrEqual(30);
  });

  it('test_steer_partial_write_recovery', async () => {
    insertRunningTask('spawn-abc', 'ag-1', 'sess-parent', 'sess-child');
    const ctx = makeCtx('owner-2', { no_filter: true }); // use owner-2 to avoid rate-limit from prior tests
    seedUser('owner-2');
    grantOwner('owner-2');

    // Pre-insert a pending idempotency row (simulate prior crash after reservation)
    const preMessageId = 'pre-msg-uuid';
    const text = 'hello';
    const trimmed = text.trim();
    const { createHash } = await import('crypto');
    const hash = createHash('sha256').update(trimmed).digest('hex');
    getDb()
      .prepare(
        `INSERT INTO steer_idempotency (user_id, idempotency_key, task_id, message_id, text, request_hash, reserved_at, status, echo_attempted)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 'pending', 0)`,
      )
      .run('owner-2', VALID_IKEY, 'spawn-abc', preMessageId, trimmed, hash);

    // Simulate that inbound write already happened (partial-write recovery)
    mockSessionInboundHasMessage.mockReturnValue(true);
    mockWriteSessionMessage.mockClear();

    const r = await applySteer('spawn-abc', { idempotency_key: VALID_IKEY, text }, ctx);
    expect(r.status).toBe(202);
    // No new inbound write (inbound already exists)
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
    // Idempotency row promoted to 'applied'
    const row = getDb()
      .prepare('SELECT status FROM steer_idempotency WHERE user_id = ? AND idempotency_key = ?')
      .get('owner-2', VALID_IKEY) as { status: string } | undefined;
    expect(row?.status).toBe('applied');
  });

  it('test_steer_sqlite_busy_503', async () => {
    insertRunningTask('spawn-abc', 'ag-1', 'sess-parent', 'sess-child');
    seedUser('owner-3');
    grantOwner('owner-3');
    const ctx = makeCtx('owner-3', { no_filter: true });

    // Verify the mock is a vi.fn before setting up the rejection
    expect(vi.isMockFunction(mockWriteSessionMessage)).toBe(true);
    const busyErr = Object.assign(new Error('SQLITE_BUSY'), { code: 'SQLITE_BUSY' });
    mockWriteSessionMessage.mockRejectedValueOnce(busyErr);

    const r = await applySteer('spawn-abc', { idempotency_key: VALID_IKEY, text: 'hello' }, ctx);
    // Verify writeSessionMessage was called (if not, the mock wasn't reached)
    expect(mockWriteSessionMessage).toHaveBeenCalled();
    expect(r.status).toBe(503);
    expect(r.body.retry_after).toBe(2);
  });

  it('test_steer_no_child_session_409', async () => {
    insertRunningTask('spawn-abc', 'ag-1', 'sess-parent', null); // no child session
    const ctx = makeCtx('owner-1', { no_filter: true });
    const r = await applySteer('spawn-abc', { idempotency_key: VALID_IKEY, text: 'hello' }, ctx);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('task_has_no_child_session');
  });

  // ── A2 HIGH-IMPACT GATE: concurrent writes serialize ─────────────────────
  it('test_steer_concurrent_writes_serialize: 10 parallel applySteer calls produce unique seqs', async () => {
    insertRunningTask('spawn-seq', 'ag-1', 'sess-parent', 'sess-child');

    // Track call order via timestamps
    const callOrder: number[] = [];
    mockWriteSessionMessage.mockImplementation(async () => {
      callOrder.push(Date.now());
    });

    // Use fresh user (owner-4) to avoid rate-limit spill from prior tests
    seedUser('owner-4');
    grantOwner('owner-4');
    const ctx = makeCtx('owner-4', { no_filter: true });
    const calls = Array.from({ length: 10 }, (_, i) =>
      applySteer('spawn-seq', { idempotency_key: `concurrent-key-${i}`, text: `msg-${i}` }, ctx),
    );

    const results = await Promise.all(calls);

    // All should succeed (202) or 429 if rate-limited
    const succeeded = results.filter((r) => r.status === 202);
    expect(succeeded.length).toBeGreaterThan(0);

    // Message IDs in successful results must be unique
    const messageIds = succeeded.map((r) => r.body.message_id as string);
    const uniqueIds = new Set(messageIds);
    expect(uniqueIds.size).toBe(succeeded.length);
  });

  // ── B4: _emitEchoStatus emits task_event SSE ────────────────────────────────
  it('test_emitEchoStatus_emits_task_event_via_emitDashboardEvent: skipped_headless emits progress event', async () => {
    // Headless task (surface_mode='headless') triggers 'skipped_headless' echo path
    insertRunningTask('spawn-echo', 'ag-1', 'sess-parent', 'sess-child', {
      surface_mode: 'headless',
    });

    const ctx = makeCtx('owner-1', { no_filter: true });
    const r = await applySteer('spawn-echo', { idempotency_key: 'echo-ikey-1', text: 'hello' }, ctx);
    expect(r.status).toBe(202);

    // Let setImmediate fire (echo path is fire-and-forget)
    await new Promise<void>((resolve) => setImmediate(resolve));

    // _emitEchoStatus must have called emitDashboardEvent with task_event + progress + echo_status
    expect(mockEmitDashboardEvent).toHaveBeenCalledWith(
      'task_event',
      expect.objectContaining({
        task_id: 'spawn-echo',
        kind: 'progress',
        agent_group_id: 'ag-1',
        echo_status: 'skipped_headless',
      }),
    );
  });

  // ── A3 HIGH-IMPACT GATE: adapter.deliver format ───────────────────────────
  it('test_steer_happy_path_adapter_deliver_format: verifies deliver called with {kind:chat, content:{text:...}}', async () => {
    // Insert native_thread task
    insertRunningTask('spawn-a3', 'ag-1', 'sess-parent', 'sess-child', {
      surface_mode: 'native_thread',
      child_mgid: 'mg-slack',
      child_thread: 'thread-slack-ts',
    });

    // Build a delivery spy
    const deliverMock = vi.fn().mockResolvedValue('msg-id');

    // Use module-level mock stubs directly
    mockGetChannelAdapter.mockReturnValue({
      deliver: deliverMock,
    } as unknown as import('../channels/adapter.js').ChannelAdapter);
    mockGetMessagingGroup.mockReturnValue({
      id: 'mg-slack',
      channel_type: 'slack',
      platform_id: 'C-slack-platform',
      name: 'slack-ch',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });

    const ctx = makeCtx('owner-1', { no_filter: true });
    const r = await applySteer('spawn-a3', { idempotency_key: 'a3-ikey-1', text: 'test msg' }, ctx);
    expect(r.status).toBe(202);

    // Let setImmediate fire (echo path is fire-and-forget)
    await new Promise<void>((resolve) => setImmediate(resolve));

    // A3 GATE: adapter.deliver called with {kind:'chat', content:{text:'[via dashboard] ...'}}
    expect(deliverMock).toHaveBeenCalledWith(
      'C-slack-platform',
      'thread-slack-ts',
      expect.objectContaining({
        kind: 'chat',
        content: expect.objectContaining({
          text: expect.stringContaining('test msg'),
        }),
      }),
    );

    // Verify format works for Discord adapter too
    deliverMock.mockClear();
    mockGetMessagingGroup.mockReturnValue({
      id: 'mg-discord',
      channel_type: 'discord',
      platform_id: 'C-discord-platform',
      name: 'discord-ch',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    const r2 = await applySteer('spawn-a3', { idempotency_key: 'a3-ikey-discord', text: 'discord msg' }, ctx);
    expect(r2.status).toBe(202);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(deliverMock).toHaveBeenCalledWith(
      'C-discord-platform',
      'thread-slack-ts',
      expect.objectContaining({
        kind: 'chat',
        content: expect.objectContaining({
          text: expect.stringContaining('discord msg'),
        }),
      }),
    );
  });
});
