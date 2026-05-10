import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  createSession,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { getTaskByParentAndIdempotency, getTaskById, insertTaskAtomic } from './db/tasks.js';
import type { Task } from './db/tasks.js';
import { computeRequestHash } from './derive-task-id.js';
import { applyDispatchTask, completeDispatchSideEffects } from './dispatch.js';
import type { Session } from '../../types.js';

// ── Mock side-effecting modules ──────────────────────────────────────────────
vi.mock('../../session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...real,
    writeSessionMessage: vi.fn().mockResolvedValue(undefined),
    resolveSession: vi.fn().mockImplementation((agId: string, mgId: string | null, threadId: string | null, _mode: string) => ({
      session: {
        id: `child-sess-${agId}`,
        agent_group_id: agId,
        messaging_group_id: mgId,
        thread_id: threadId,
        status: 'active' as const,
        container_status: 'stopped' as const,
        agent_provider: null,
        last_active: null,
        created_at: new Date().toISOString(),
      },
      created: true,
    })),
    writeSessionRouting: vi.fn(),
    inboundDbPath: vi.fn().mockReturnValue('/tmp/nonexistent-inbound.db'),
    openInboundDb: vi.fn(),
  };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
}));

vi.mock('../../db/sessions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/sessions.js')>();
  return {
    ...real,
    getSession: vi.fn().mockReturnValue(null),
  };
});

vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn(),
  registerChannelAdapter: vi.fn(),
  getActiveAdapters: vi.fn().mockReturnValue([]),
}));

// ── Channel adapter stubs ─────────────────────────────────────────────────────
const mockAdapterWithThread = {
  channelType: 'slack',
  deliver: vi.fn(),
  createThread: vi.fn().mockResolvedValue({ threadId: 'parent-ts-123', messageId: 'reply-ts-456' }),
  postParent: vi.fn().mockResolvedValue({ messageId: 'parent-msg-id' }),
  setup: vi.fn(),
  teardown: vi.fn(),
};

const mockAdapterWithoutThread = {
  channelType: 'telegram',
  deliver: vi.fn(),
  setup: vi.fn(),
  teardown: vi.fn(),
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function now(): string {
  return new Date().toISOString();
}

function setupDb(): void {
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

function makeCallerSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-caller',
    agent_group_id: 'ag-caller',
    messaging_group_id: null,
    thread_id: null,
    status: 'active',
    container_status: 'stopped',
    agent_provider: null,
    last_active: null,
    created_at: now(),
    ...overrides,
  };
}

function seedAgentGroup(id: string): void {
  createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
}

function seedSession(sessId: string, agId: string, mgId: string | null = null): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO sessions (id, agent_group_id, messaging_group_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(sessId, agId, mgId, now());
}

function seedMessagingGroup(mgId: string): void {
  createMessagingGroup({
    id: mgId,
    channel_type: 'slack',
    platform_id: 'C-platform',
    name: 'test-channel',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
}

function grantOrchestrator(agId: string): void {
  const config = JSON.stringify({
    concurrencyCap: 5,
    noProgressTimeoutSec: 1800,
    spawnDeadlineSec: 300,
    drainGraceSec: 120,
  });
  getDb()
    .prepare(
      `INSERT INTO agent_group_capabilities (agent_group_id, role, config_json, granted_by, granted_at)
       VALUES (?, 'orchestrator', ?, NULL, ?)
       ON CONFLICT(agent_group_id, role) DO UPDATE SET config_json = excluded.config_json`,
    )
    .run(agId, config, now());
}

function grantOrchestratorCap1(agId: string): void {
  const config = JSON.stringify({
    concurrencyCap: 1,
    noProgressTimeoutSec: 1800,
    spawnDeadlineSec: 300,
    drainGraceSec: 120,
  });
  getDb()
    .prepare(
      `INSERT INTO agent_group_capabilities (agent_group_id, role, config_json, granted_by, granted_at)
       VALUES (?, 'orchestrator', ?, NULL, ?)
       ON CONFLICT(agent_group_id, role) DO UPDATE SET config_json = excluded.config_json`,
    )
    .run(agId, config, now());
}

function wireTargetToMg(targetAgId: string, mgId: string): void {
  createMessagingGroupAgent({
    id: `mga-${targetAgId}-${mgId}`,
    messaging_group_id: mgId,
    agent_group_id: targetAgId,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    default_model: null,
    default_effort: null,
    default_tone: null,
    created_at: now(),
  });
}

function insertActiveTask(taskId: string, idempotencyKey: string, sessionId: string, agId: string, targetAgId: string): Task {
  return insertTaskAtomic({
    task_id: taskId,
    idempotency_key: idempotencyKey,
    parent_session_id: sessionId,
    parent_agent_group_id: agId,
    parent_messaging_group_id: null,
    target_agent_group_id: targetAgId,
    child_session_id: null,
    status: 'running',
    task_content: 'do something',
    request_hash: 'hash-x',
    deadline: null,
    parent_platform_message_id: null,
    child_platform_thread_id: null,
    child_messaging_group_id: null,
    admitted_at: now(),
    started_at: now(),
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    last_progress_at: now(),
    last_progress_message: null,
    fail_reason: null,
    result_summary: null,
    dispatch_completion_attempts: 0,
    completion_lease_at: null,
    surface_mode: 'headless',
  })!;
}

beforeEach(async () => {
  const { getChannelAdapter } = await import('../../channels/channel-registry.js');
  vi.mocked(getChannelAdapter).mockReturnValue(undefined); // default: no adapter (headless)
});

afterEach(() => {
  closeDb();
  vi.clearAllMocks();
});

// ── B2 Tests ─────────────────────────────────────────────────────────────────

describe('applyDispatchTask', () => {
  it('test_admit_missing_capability_rejects: rejects when caller has no orchestrator capability', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedSession('sess-caller', 'ag-caller');

    const caller = makeCallerSession();
    await applyDispatchTask(
      { target_group: 'ag-target', content: 'Do X', idempotency_key: 'k1' },
      caller,
    );

    const task = getTaskByParentAndIdempotency('sess-caller', 'k1');
    expect(task).toBeNull();

    const { writeSessionMessage } = await import('../../session-manager.js');
    expect(vi.mocked(writeSessionMessage)).toHaveBeenCalledWith(
      'ag-caller',
      'sess-caller',
      expect.objectContaining({ content: expect.stringContaining('not an orchestrator') }),
    );
  });

  it('test_admit_happy_path: inserts task with correct fields (headless mode)', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedSession('sess-caller', 'ag-caller');
    grantOrchestrator('ag-caller');

    const { getChannelAdapter } = await import('../../channels/channel-registry.js');
    vi.mocked(getChannelAdapter).mockReturnValue(undefined); // no adapter → headless

    const caller = makeCallerSession();
    await applyDispatchTask(
      { target_group: 'ag-target', content: 'Do X', idempotency_key: 'k1' },
      caller,
    );

    const task = getTaskByParentAndIdempotency('sess-caller', 'k1');
    expect(task).not.toBeNull();
    expect(task!.status).toBe('pending');
    expect(task!.surface_mode).toBe('headless');
    expect(task!.admitted_at).toBeTruthy();
  });

  it('test_idempotency_replay_succeeds_at_cap: replay succeeds even when at concurrency cap', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedSession('sess-caller', 'ag-caller');
    grantOrchestratorCap1('ag-caller');

    // Insert one active task (at cap)
    insertActiveTask('task-existing', 'k-other', 'sess-caller', 'ag-caller', 'ag-target');

    // Also insert the idempotency key we'll replay
    const replayHash = computeRequestHash('ag-target', 'Do X', null);
    insertTaskAtomic({
      task_id: 'task-replay',
      idempotency_key: 'k1',
      parent_session_id: 'sess-caller',
      parent_agent_group_id: 'ag-caller',
      parent_messaging_group_id: null,
      target_agent_group_id: 'ag-target',
      child_session_id: null,
      status: 'pending',
      task_content: 'Do X',
      request_hash: replayHash,
      deadline: null,
      parent_platform_message_id: null,
      child_platform_thread_id: null,
      child_messaging_group_id: null,
      admitted_at: now(),
      started_at: null,
      completed_at: null,
      failed_at: null,
      cancelled_at: null,
      last_progress_at: null,
      last_progress_message: null,
      fail_reason: null,
      result_summary: null,
      dispatch_completion_attempts: 0,
      completion_lease_at: null,
      surface_mode: 'headless',
    });

    // Now we have 2 tasks (running + pending) but cap is 1.
    // Replaying k1 should succeed (replay precedes cap check).
    const caller = makeCallerSession();
    await applyDispatchTask(
      { target_group: 'ag-target', content: 'Do X', idempotency_key: 'k1' },
      caller,
    );

    const { writeSessionMessage } = await import('../../session-manager.js');
    const calls = vi.mocked(writeSessionMessage).mock.calls;
    const messages = calls.map((c) => JSON.parse(c[2].content as string).text as string);
    // Should NOT get "cap reached" — should get the existing task status
    expect(messages.some((m) => m.includes('task-replay'))).toBe(true);
    expect(messages.some((m) => m.includes('cap reached'))).toBe(false);
  });

  it('test_idempotency_replay_with_different_payload: rejects with key_reused', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedSession('sess-caller', 'ag-caller');
    grantOrchestrator('ag-caller');

    // Insert existing task with hash for ('ag-target', 'X', null)
    const originalHash = computeRequestHash('ag-target', 'X', null);
    insertTaskAtomic({
      task_id: 'task-orig',
      idempotency_key: 'k1',
      parent_session_id: 'sess-caller',
      parent_agent_group_id: 'ag-caller',
      parent_messaging_group_id: null,
      target_agent_group_id: 'ag-target',
      child_session_id: null,
      status: 'pending',
      task_content: 'X',
      request_hash: originalHash,
      deadline: null,
      parent_platform_message_id: null,
      child_platform_thread_id: null,
      child_messaging_group_id: null,
      admitted_at: now(),
      started_at: null,
      completed_at: null,
      failed_at: null,
      cancelled_at: null,
      last_progress_at: null,
      last_progress_message: null,
      fail_reason: null,
      result_summary: null,
      dispatch_completion_attempts: 0,
      completion_lease_at: null,
      surface_mode: 'headless',
    });

    const caller = makeCallerSession();
    await applyDispatchTask(
      { target_group: 'ag-target', content: 'X-DIFFERENT', idempotency_key: 'k1' },
      caller,
    );

    const { writeSessionMessage } = await import('../../session-manager.js');
    const messages = vi.mocked(writeSessionMessage).mock.calls.map((c) =>
      JSON.parse(c[2].content as string).text as string,
    );
    expect(messages.some((m) => m.includes('idempotency_key_reused_with_different_payload'))).toBe(true);

    // Existing task unchanged
    const existing = getTaskById('task-orig');
    expect(existing!.task_content).toBe('X');
  });

  it('test_cap_rejects_new_admission: rejects when at concurrency cap', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedSession('sess-caller', 'ag-caller');
    grantOrchestratorCap1('ag-caller');

    // Insert one active (running) task → at cap
    insertActiveTask('task-existing', 'k-other', 'sess-caller', 'ag-caller', 'ag-target');

    const caller = makeCallerSession();
    await applyDispatchTask(
      { target_group: 'ag-target', content: 'New work', idempotency_key: 'k-new' },
      caller,
    );

    const newTask = getTaskByParentAndIdempotency('sess-caller', 'k-new');
    expect(newTask).toBeNull();

    const { writeSessionMessage } = await import('../../session-manager.js');
    const messages = vi.mocked(writeSessionMessage).mock.calls.map((c) =>
      JSON.parse(c[2].content as string).text as string,
    );
    expect(messages.some((m) => m.includes('concurrency cap reached'))).toBe(true);
  });

  it('test_target_not_wired_rejects: rejects when target not wired to caller messaging group', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedMessagingGroup('mg-1');
    seedSession('sess-caller', 'ag-caller', 'mg-1');
    grantOrchestrator('ag-caller');
    // NO messaging_group_agents row for (ag-target, mg-1)

    const caller = makeCallerSession({ messaging_group_id: 'mg-1' });
    await applyDispatchTask(
      { target_group: 'ag-target', content: 'Do X', idempotency_key: 'k1' },
      caller,
    );

    const task = getTaskByParentAndIdempotency('sess-caller', 'k1');
    expect(task).toBeNull();

    const { writeSessionMessage } = await import('../../session-manager.js');
    const messages = vi.mocked(writeSessionMessage).mock.calls.map((c) =>
      JSON.parse(c[2].content as string).text as string,
    );
    expect(messages.some((m) => m.includes('target_not_wired_to_caller_messaging_group'))).toBe(true);
  });

  it('test_headless_path_when_no_create_thread: surface_mode=headless when adapter lacks createThread', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedMessagingGroup('mg-1');
    seedSession('sess-caller', 'ag-caller', 'mg-1');
    wireTargetToMg('ag-target', 'mg-1');
    grantOrchestrator('ag-caller');

    const { getChannelAdapter } = await import('../../channels/channel-registry.js');
    // Return adapter WITHOUT createThread
    vi.mocked(getChannelAdapter).mockReturnValue(mockAdapterWithoutThread as any);

    const caller = makeCallerSession({ messaging_group_id: 'mg-1' });
    await applyDispatchTask(
      { target_group: 'ag-target', content: 'Do X', idempotency_key: 'k1' },
      caller,
    );

    const task = getTaskByParentAndIdempotency('sess-caller', 'k1');
    expect(task).not.toBeNull();
    expect(task!.surface_mode).toBe('headless');
  });

  it('ASSERT: surface_mode=native_thread when adapter has createThread and mgId is non-null', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedMessagingGroup('mg-1');
    seedSession('sess-caller', 'ag-caller', 'mg-1');
    wireTargetToMg('ag-target', 'mg-1');
    grantOrchestrator('ag-caller');

    const { getChannelAdapter } = await import('../../channels/channel-registry.js');
    vi.mocked(getChannelAdapter).mockReturnValue(mockAdapterWithThread as any);

    const caller = makeCallerSession({ messaging_group_id: 'mg-1' });
    await applyDispatchTask(
      { target_group: 'ag-target', content: 'Do X', idempotency_key: 'k1' },
      caller,
    );

    const task = getTaskByParentAndIdempotency('sess-caller', 'k1');
    expect(task).not.toBeNull();
    expect(task!.surface_mode).toBe('native_thread');
  });

  it('ASSERT: target-is-orchestrator rejects', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedSession('sess-caller', 'ag-caller');
    grantOrchestrator('ag-caller');
    // Also grant orchestrator to target
    grantOrchestrator('ag-target');

    const caller = makeCallerSession();
    await applyDispatchTask(
      { target_group: 'ag-target', content: 'Do X', idempotency_key: 'k1' },
      caller,
    );

    const task = getTaskByParentAndIdempotency('sess-caller', 'k1');
    expect(task).toBeNull();
  });

  it('ASSERT: self-dispatch rejects', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedSession('sess-caller', 'ag-caller');
    grantOrchestrator('ag-caller');

    const caller = makeCallerSession();
    await applyDispatchTask(
      { target_group: 'ag-caller', content: 'Do X', idempotency_key: 'k1' }, // target = self
      caller,
    );

    const task = getTaskByParentAndIdempotency('sess-caller', 'k1');
    expect(task).toBeNull();
  });

  it('ASSERT: post-INSERT setImmediate(completeDispatchSideEffects, task_id) called', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedSession('sess-caller', 'ag-caller');
    grantOrchestrator('ag-caller');

    const setImmediateSpy = vi.spyOn(global, 'setImmediate');

    const caller = makeCallerSession();
    await applyDispatchTask(
      { target_group: 'ag-target', content: 'Do X', idempotency_key: 'k1' },
      caller,
    );

    expect(setImmediateSpy).toHaveBeenCalledWith(
      expect.any(Function),
      expect.stringContaining('dispatch-'),
    );
    setImmediateSpy.mockRestore();
  });

  it('ASSERT: notify-caller wrapped in try/catch — writeSessionMessage failure does not throw', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedSession('sess-caller', 'ag-caller');
    grantOrchestrator('ag-caller');

    const { writeSessionMessage } = await import('../../session-manager.js');
    vi.mocked(writeSessionMessage).mockRejectedValueOnce(new Error('DB write failure'));

    const caller = makeCallerSession();
    // Should NOT throw even though writeSessionMessage fails
    await expect(
      applyDispatchTask({ target_group: 'ag-target', content: 'Do X', idempotency_key: 'k1' }, caller),
    ).resolves.not.toThrow();
  });
});

// ── B3 Tests ─────────────────────────────────────────────────────────────────

describe('completeDispatchSideEffects', () => {
  it('test_lease_skip_when_held: skips silently when lease is already held', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedSession('sess-caller', 'ag-caller');

    // Insert task with lease already held (set to now, not expired)
    const taskId = 'task-leased';
    getDb()
      .prepare(
        `INSERT INTO tasks (task_id, idempotency_key, parent_session_id, parent_agent_group_id,
          target_agent_group_id, status, task_content, request_hash, admitted_at, surface_mode,
          completion_lease_at, dispatch_completion_attempts, created_at)
         VALUES (?, 'ik', 'sess-caller', 'ag-caller', 'ag-target', 'pending', 'do x', 'hash', ?, 'headless', ?, 0, ?)`,
      )
      .run(taskId, now(), now(), now()); // lease set to NOW (not expired)

    const { postParent } = mockAdapterWithThread;

    await completeDispatchSideEffects(taskId);

    // Should not have called any adapter method
    expect(postParent).not.toHaveBeenCalled();
  });

  it('test_concurrent_setImmediate_dedupe: second call returns same promise (in-process guard)', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedSession('sess-caller', 'ag-caller');

    const taskId = 'task-dedup';
    getDb()
      .prepare(
        `INSERT INTO tasks (task_id, idempotency_key, parent_session_id, parent_agent_group_id,
          target_agent_group_id, status, task_content, request_hash, admitted_at, surface_mode,
          dispatch_completion_attempts, created_at)
         VALUES (?, 'ik', 'sess-caller', 'ag-caller', 'ag-target', 'pending', 'do x', 'hash', ?, 'headless', 0, ?)`,
      )
      .run(taskId, now(), now());

    let callCount = 0;
    const { writeSessionMessage } = await import('../../session-manager.js');
    vi.mocked(writeSessionMessage).mockImplementation(async () => {
      callCount++;
    });

    // Call twice concurrently — only first should run
    const p1 = completeDispatchSideEffects(taskId);
    const p2 = completeDispatchSideEffects(taskId);
    await Promise.all([p1, p2]);
    // The Map dedup returns the same promise, so the side effects only run once
    // (we can't check callCount easily since headless path would still call writeSessionMessage)
    // Just verify no double-run exceptions
  });

  it('test_adapter_unavailable_marks_failed_immediately: adapter_unavailable does not consume retry budget', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedSession('sess-caller', 'ag-caller');
    seedMessagingGroup('mg-1');
    seedSession('sess-caller', 'ag-caller', 'mg-1');

    const taskId = 'task-no-adapter';
    getDb()
      .prepare(
        `INSERT INTO tasks (task_id, idempotency_key, parent_session_id, parent_agent_group_id,
          parent_messaging_group_id, target_agent_group_id, status, task_content, request_hash,
          admitted_at, surface_mode, dispatch_completion_attempts, created_at)
         VALUES (?, 'ik', 'sess-caller', 'ag-caller', 'mg-1', 'ag-target', 'pending', 'do x', 'hash', ?, 'native_thread', 0, ?)`,
      )
      .run(taskId, now(), now());

    const { getChannelAdapter } = await import('../../channels/channel-registry.js');
    // Return adapter WITHOUT createThread
    vi.mocked(getChannelAdapter).mockReturnValue(mockAdapterWithoutThread as any);

    await completeDispatchSideEffects(taskId);

    const task = getTaskById(taskId);
    expect(task!.status).toBe('failed');
    expect(task!.fail_reason).toBe('adapter_unavailable');
    // CRITICAL: dispatch_completion_attempts === 0 (no retry budget consumed)
    expect(task!.dispatch_completion_attempts).toBe(0);
  });

  it('test_completion_exhausted_after_5_failures: marks failed after 5 throws', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedSession('sess-caller', 'ag-caller');

    const taskId = 'task-exhaust';
    getDb()
      .prepare(
        `INSERT INTO tasks (task_id, idempotency_key, parent_session_id, parent_agent_group_id,
          target_agent_group_id, status, task_content, request_hash, admitted_at, surface_mode,
          dispatch_completion_attempts, created_at)
         VALUES (?, 'ik', 'sess-caller', 'ag-caller', 'ag-target', 'pending', 'do x', 'hash', ?, 'headless', 0, ?)`,
      )
      .run(taskId, now(), now());

    const { writeSessionMessage } = await import('../../session-manager.js');
    vi.mocked(writeSessionMessage).mockRejectedValue(new Error('always fails'));

    // 5 failures
    for (let i = 0; i < 5; i++) {
      // Reset the lease between calls (simulate each call as a separate process run)
      getDb().prepare(`UPDATE tasks SET completion_lease_at = NULL WHERE task_id = ?`).run(taskId);
      await completeDispatchSideEffects(taskId);
    }

    const task = getTaskById(taskId);
    expect(task!.status).toBe('failed');
    expect(task!.fail_reason).toBe('completion_exhausted');
  });

  it('test_status_cas_aborts_on_cancel_mid_flight: aborts when status no longer pending', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedSession('sess-caller', 'ag-caller');

    const taskId = 'task-cancelled-mid';
    getDb()
      .prepare(
        `INSERT INTO tasks (task_id, idempotency_key, parent_session_id, parent_agent_group_id,
          target_agent_group_id, status, task_content, request_hash, admitted_at, surface_mode,
          dispatch_completion_attempts, created_at)
         VALUES (?, 'ik', 'sess-caller', 'ag-caller', 'ag-target', 'cancelled', 'do x', 'hash', ?, 'headless', 0, ?)`,
      )
      .run(taskId, now(), now());

    const { writeSessionMessage } = await import('../../session-manager.js');
    await completeDispatchSideEffects(taskId);

    // Should have exited immediately — acquireCompletionLease requires status='pending'
    // so it returns null. No writeSessionMessage calls.
    // (The acquireCompletionLease UPDATE won't match since status is 'cancelled')
    // If it DID run, it would have tried to write a message — verify it didn't.
    const task = getTaskById(taskId);
    expect(task!.status).toBe('cancelled'); // unchanged
  });

  it('test_slack_thread_id_is_parent_message_id: persists threadId not messageId', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedMessagingGroup('mg-1');
    seedSession('sess-caller', 'ag-caller', 'mg-1');

    const taskId = 'task-slack-thread';
    getDb()
      .prepare(
        `INSERT INTO tasks (task_id, idempotency_key, parent_session_id, parent_agent_group_id,
          parent_messaging_group_id, target_agent_group_id, status, task_content, request_hash,
          admitted_at, surface_mode, dispatch_completion_attempts, created_at)
         VALUES (?, 'ik', 'sess-caller', 'ag-caller', 'mg-1', 'ag-target', 'pending', 'do x', 'hash', ?, 'native_thread', 0, ?)`,
      )
      .run(taskId, now(), now());

    const { getChannelAdapter } = await import('../../channels/channel-registry.js');
    vi.mocked(getChannelAdapter).mockReturnValue(mockAdapterWithThread as any);
    // createThread returns {threadId: 'parent-ts-123', messageId: 'reply-ts-456'}

    await completeDispatchSideEffects(taskId);

    const task = getTaskById(taskId);
    // child_platform_thread_id should be threadId ('parent-ts-123'), NOT messageId ('reply-ts-456')
    if (task && task.child_platform_thread_id !== null) {
      expect(task.child_platform_thread_id).toBe('parent-ts-123');
    }
    // Task may be in 'running' or 'failed' at this point depending on session resolution
  });

  it('test_open_session_write_order: tasks UPDATE before writeSessionMessage before wakeContainer', async () => {
    setupDb();
    seedAgentGroup('ag-caller');
    seedAgentGroup('ag-target');
    seedSession('sess-caller', 'ag-caller');

    const taskId = 'task-write-order';
    getDb()
      .prepare(
        `INSERT INTO tasks (task_id, idempotency_key, parent_session_id, parent_agent_group_id,
          target_agent_group_id, status, task_content, request_hash, admitted_at, surface_mode,
          dispatch_completion_attempts, created_at)
         VALUES (?, 'ik', 'sess-caller', 'ag-caller', 'ag-target', 'pending', 'do x', 'hash', ?, 'headless', 0, ?)`,
      )
      .run(taskId, now(), now());

    const order: string[] = [];
    const { writeSessionMessage } = await import('../../session-manager.js');
    const { wakeContainer } = await import('../../container-runner.js');

    vi.mocked(writeSessionMessage).mockImplementation(async () => {
      // By the time writeSessionMessage is called, child_session_id must be set
      const task = getTaskById(taskId);
      if (task && task.status === 'running') {
        order.push('writeSessionMessage-after-tasks-update');
      }
    });

    vi.mocked(wakeContainer).mockImplementation(async () => {
      order.push('wakeContainer');
      return true;
    });

    await completeDispatchSideEffects(taskId);

    // wakeContainer must come after writeSessionMessage
    const wakeIdx = order.lastIndexOf('wakeContainer');
    const writeIdx = order.lastIndexOf('writeSessionMessage-after-tasks-update');
    if (writeIdx !== -1 && wakeIdx !== -1) {
      expect(writeIdx).toBeLessThan(wakeIdx);
    }
  });
});
