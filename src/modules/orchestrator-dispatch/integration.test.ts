/**
 * F1 — End-to-end self-spawn integration test.
 *
 * Tests the complete handler chain:
 *   orchestrator calls applySpawnTask
 *   → host admits task, opens child session in the same agent group
 *   → child calls applySpawnProgress / applySpawnComplete
 *   → orchestrator gets notified
 *
 * No real Docker, no real Slack/Discord — all side-effecting modules are mocked.
 *
 * Test runner: vitest
 * Run: pnpm test --run src/modules/orchestrator-dispatch/integration.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, createMessagingGroup, createMessagingGroupAgent, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { getTaskById, insertTaskAtomic } from './db/tasks.js';
import { computeRequestHash, deriveSpawnTaskId } from './derive-task-id.js';
import { applySpawnTask } from './dispatch.js';
import { applySpawnComplete } from './completion.js';
import { applySpawnProgress } from './progress.js';
import { applySpawnCancel } from './cancellation.js';
import { runReconcilerSweep } from './reconciler.js';
import { _sweepTaskWatchdogForTesting } from '../../host-sweep.js';
import type { Session } from '../../types.js';

// ── Mock side-effecting modules ──────────────────────────────────────────────

// writeSessionMessage: track calls per (agentGroupId, sessionId) for assertion.
const writtenMessages: Array<{ agentGroupId: string; sessionId: string; content: string }> = [];

// Used by the resolveSession mock to insert child sessions into the central DB
// so that tasks.child_session_id FK constraints pass.
function insertChildSession(
  sessionId: string,
  agId: string,
  mgId: string | null,
  threadId: string | null,
  createdAt: string,
): void {
  try {
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO sessions (id, agent_group_id, messaging_group_id, thread_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, agId, mgId, threadId, createdAt);
  } catch {
    // DB not yet initialized in some test paths — ignore; FK will catch it if needed
  }
}

vi.mock('../../session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...real,
    writeSessionMessage: vi
      .fn()
      .mockImplementation(async (agentGroupId: string, sessionId: string, msg: { content: string }) => {
        writtenMessages.push({ agentGroupId, sessionId, content: msg.content });
      }),
    // resolveSession: inserts the child session into the central DB so FK constraints pass.
    resolveSession: vi
      .fn()
      .mockImplementation((agId: string, mgId: string | null, threadId: string | null, _mode: string) => {
        const sessionId = mgId ? `child-sess-${agId}-${threadId ?? 'no-thread'}` : `child-sess-${agId}-headless`;
        const now = new Date().toISOString();
        const session: Session = {
          id: sessionId,
          agent_group_id: agId,
          messaging_group_id: mgId,
          thread_id: threadId,
          status: 'active' as const,
          container_status: 'stopped' as const,
          agent_provider: null,
          last_active: null,
          created_at: now,
        };
        insertChildSession(sessionId, agId, mgId, threadId, now);
        sessionMap.set(sessionId, session);
        return { session, created: true };
      }),
    writeSessionRouting: vi.fn(),
    inboundDbPath: vi.fn().mockReturnValue('/tmp/nonexistent-inbound.db'),
    openInboundDb: vi.fn(),
  };
});

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  killContainer: vi.fn(),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getContainerSpawnedAt: vi.fn().mockReturnValue(null),
}));

const sessionMap = new Map<string, Session>();

vi.mock('../../db/sessions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/sessions.js')>();
  return {
    ...real,
    getSession: vi.fn().mockImplementation((id: string) => sessionMap.get(id) ?? null),
  };
});

vi.mock('../../channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn(),
  registerChannelAdapter: vi.fn(),
  getActiveAdapters: vi.fn().mockReturnValue([]),
}));

// ── Adapter stubs ─────────────────────────────────────────────────────────────

const mockAdapterWithThread = {
  channelType: 'slack' as const,
  deliver: vi.fn(),
  postParent: vi.fn().mockResolvedValue({ messageId: 'parent-msg-id-001' }),
  createThread: vi.fn().mockResolvedValue({ threadId: 'parent-msg-id-001', messageId: 'parent-msg-id-001' }),
  setup: vi.fn(),
  teardown: vi.fn(),
};

const mockAdapterWithoutThread = {
  channelType: 'telegram' as const,
  deliver: vi.fn(),
  setup: vi.fn(),
  teardown: vi.fn(),
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString();
}

function setupDb(): void {
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

function seedGroups({ withMg = false }: { withMg?: boolean } = {}): { orchSession: Session; mgId: string | null } {
  // Self-orchestration: only one agent group is needed. The "child" sessions
  // resolveSession returns will live in the SAME group (ag-orch).
  createAgentGroup({ id: 'ag-orch', name: 'ag-orch', folder: 'ag-orch', agent_provider: null, created_at: ts() });

  const capConfig = JSON.stringify({
    concurrencyCap: 5,
    noProgressTimeoutSec: 1800,
    spawnDeadlineSec: 300,
    drainGraceSec: 120,
  });
  getDb()
    .prepare(
      `INSERT INTO agent_group_capabilities (agent_group_id, role, config_json, granted_by, granted_at) VALUES (?, 'orchestrator', ?, NULL, ?)`,
    )
    .run('ag-orch', capConfig, ts());

  let mgId: string | null = null;
  if (withMg) {
    mgId = 'mg-shared';
    createMessagingGroup({
      id: mgId,
      channel_type: 'slack',
      platform_id: 'C-123',
      name: 'test-channel',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: ts(),
    });
    createMessagingGroupAgent({
      id: 'mga-orch',
      messaging_group_id: mgId,
      agent_group_id: 'ag-orch',
      engage_mode: 'mention',
      engage_pattern: null,
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      default_model: null,
      default_effort: null,
      default_tone: null,
      created_at: ts(),
    });
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO sessions (id, agent_group_id, messaging_group_id, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run('sess-orch', 'ag-orch', mgId, ts());
  } else {
    getDb()
      .prepare(`INSERT OR IGNORE INTO sessions (id, agent_group_id, created_at) VALUES (?, ?, ?)`)
      .run('sess-orch', 'ag-orch', ts());
  }

  const orchSession: Session = {
    id: 'sess-orch',
    agent_group_id: 'ag-orch',
    messaging_group_id: mgId,
    thread_id: null,
    status: 'active',
    container_status: 'stopped',
    agent_provider: null,
    last_active: null,
    created_at: ts(),
  };
  sessionMap.set('sess-orch', orchSession);

  return { orchSession, mgId };
}

/** Wait for setImmediate callbacks to drain. */
function drainImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function getWrittenFor(sessionId: string): string[] {
  return writtenMessages.filter((m) => m.sessionId === sessionId).map((m) => m.content);
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(async () => {
  writtenMessages.length = 0;
  sessionMap.clear();
  vi.clearAllMocks();
  // Re-wire writeSessionMessage after clearAllMocks
  const sm = await import('../../session-manager.js');
  vi.mocked(sm.writeSessionMessage).mockImplementation(
    async (agentGroupId: string, sessionId: string, msg: { content: string }) => {
      writtenMessages.push({ agentGroupId, sessionId, content: msg.content });
    },
  );
});

afterEach(() => {
  closeDb();
  vi.clearAllMocks();
});

// ── F1 Tests ─────────────────────────────────────────────────────────────────

describe('F1: e2e threaded happy path', () => {
  it('test_e2e_threaded_happy_path: full admit → thread → child complete → parent notified', async () => {
    setupDb();
    const { orchSession } = seedGroups({ withMg: true });

    const { getChannelAdapter } = await import('../../channels/channel-registry.js');
    vi.mocked(getChannelAdapter).mockReturnValue(
      mockAdapterWithThread as unknown as ReturnType<typeof getChannelAdapter>,
    );

    // Step 1: orchestrator spawns a task
    await applySpawnTask({ content: 'Do thing', idempotency_key: 'k1' }, orchSession);

    // Step 2: drain setImmediate (completeSpawnSideEffects)
    await drainImmediate();
    await drainImmediate(); // second drain for async chain inside _runThreadedPath

    // Step 3: verify task row is running with all key fields populated
    const taskId = deriveSpawnTaskId('sess-orch', 'k1');
    const task = getTaskById(taskId);
    expect(task).not.toBeNull();
    expect(task!.status).toBe('running');
    expect(task!.surface_mode).toBe('native_thread');
    expect(task!.child_session_id).not.toBeNull();
    // Self-orchestration: child session lives in the parent's agent group
    expect(task!.child_session_id).toContain('child-sess-ag-orch');

    // M25: child_platform_thread_id === parent_platform_message_id (Slack semantics)
    expect(task!.parent_platform_message_id).toBe('parent-msg-id-001');
    expect(task!.child_platform_thread_id).toBe('parent-msg-id-001');

    // Step 4: verify parent got admitted notification
    const orchMessages = getWrittenFor('sess-orch');
    expect(orchMessages.some((m) => m.includes('Task admitted'))).toBe(true);

    // Step 5: verify child session got the _spawn envelope
    const childSessionId = task!.child_session_id!;
    const childMessages = getWrittenFor(childSessionId);
    const spawnMsg = childMessages.find((m) => m.includes('_spawn'));
    expect(spawnMsg).toBeDefined();
    const parsed = JSON.parse(spawnMsg!);
    expect(parsed._spawn.task_id).toBe(taskId);

    // Step 6: child reports progress (child shares the parent agent group)
    const childSession: Session = {
      id: childSessionId,
      agent_group_id: 'ag-orch',
      messaging_group_id: null,
      thread_id: null,
      status: 'active',
      container_status: 'running',
      agent_provider: null,
      last_active: null,
      created_at: ts(),
    };
    sessionMap.set(childSessionId, childSession);

    await applySpawnProgress({ task_id: taskId, message: 'step 1 done' }, childSession);
    const afterProgress = getTaskById(taskId);
    expect(afterProgress!.last_progress_at).not.toBeNull();
    expect(afterProgress!.last_progress_message).toBe('step 1 done');

    // Step 7: child reports completion
    sessionMap.set('sess-orch', orchSession);
    await applySpawnComplete({ task_id: taskId, summary: 'all done' }, childSession);

    // Step 8: verify terminal state + parent notification
    const completedTask = getTaskById(taskId);
    expect(completedTask!.status).toBe('completed');
    expect(completedTask!.completed_at).not.toBeNull();
    expect(completedTask!.result_summary).toBe('all done');

    const orchMessagesAfter = getWrittenFor('sess-orch');
    const completionMsg = orchMessagesAfter.find((m) => m.includes('Task completed'));
    expect(completionMsg).toBeDefined();
    const completionParsed = JSON.parse(completionMsg!);
    expect(completionParsed._task_update.status).toBe('completed');

    // M21: child_session_id set in tasks BEFORE writeSessionMessage to child
    expect(task!.child_session_id).not.toBeNull();
    expect(childMessages.length).toBeGreaterThan(0);
  }, 10_000);
});

describe('F1: e2e headless happy path', () => {
  it('test_e2e_headless_happy_path: no createThread → headless surface_mode', async () => {
    setupDb();
    const { orchSession } = seedGroups({ withMg: false }); // no messaging group

    const { getChannelAdapter } = await import('../../channels/channel-registry.js');
    vi.mocked(getChannelAdapter).mockReturnValue(
      mockAdapterWithoutThread as unknown as ReturnType<typeof getChannelAdapter>,
    );

    await applySpawnTask({ content: 'Do headless thing', idempotency_key: 'k-headless' }, orchSession);
    await drainImmediate();
    await drainImmediate();

    const taskId = deriveSpawnTaskId('sess-orch', 'k-headless');
    const task = getTaskById(taskId);
    expect(task).not.toBeNull();
    expect(task!.status).toBe('running');
    expect(task!.surface_mode).toBe('headless');
    // In headless mode: no platform IDs
    expect(task!.child_platform_thread_id).toBeNull();
    expect(task!.parent_platform_message_id).toBeNull();

    // Child session uses task_id as synthetic thread_id
    const childSessionId = task!.child_session_id;
    expect(childSessionId).not.toBeNull();

    // Verify _spawn was written to child
    const childMessages = getWrittenFor(childSessionId!);
    const spawnMsg = childMessages.find((m) => m.includes('_spawn'));
    expect(spawnMsg).toBeDefined();

    // No adapter.deliver should be called (headless path has no platform delivery)
    expect(mockAdapterWithoutThread.deliver).not.toHaveBeenCalled();

    // Parent received notifications
    const orchMessages = getWrittenFor('sess-orch');
    expect(orchMessages.some((m) => m.includes('Task admitted') || m.includes('Headless task running'))).toBe(true);

    // Complete from child (same agent group as parent)
    const childSession: Session = {
      id: childSessionId!,
      agent_group_id: 'ag-orch',
      messaging_group_id: null,
      thread_id: taskId,
      status: 'active',
      container_status: 'running',
      agent_provider: null,
      last_active: null,
      created_at: ts(),
    };
    sessionMap.set(childSessionId!, childSession);
    sessionMap.set('sess-orch', orchSession);

    await applySpawnComplete({ task_id: taskId, summary: 'headless done' }, childSession);
    const completedTask = getTaskById(taskId);
    expect(completedTask!.status).toBe('completed');
  }, 10_000);
});

describe('F1: e2e idempotency replay', () => {
  it('test_e2e_idempotent_replay: same idempotency_key does not insert new task row', async () => {
    setupDb();
    const { orchSession } = seedGroups({ withMg: false });

    const { getChannelAdapter } = await import('../../channels/channel-registry.js');
    vi.mocked(getChannelAdapter).mockReturnValue(undefined);

    // First spawn
    await applySpawnTask({ content: 'Do X', idempotency_key: 'k-replay' }, orchSession);

    // Second spawn with SAME idempotency_key
    await applySpawnTask({ content: 'Do X', idempotency_key: 'k-replay' }, orchSession);

    // Only one row should exist
    const allTasks = getDb().prepare(`SELECT * FROM tasks WHERE parent_session_id = 'sess-orch'`).all();
    expect(allTasks).toHaveLength(1);

    // Replay notification includes existing task_id
    const orchMessages = getWrittenFor('sess-orch');
    expect(orchMessages.some((m) => m.includes('already exists') || m.includes('Task admitted'))).toBe(true);
  });

  it('test_e2e_idempotent_replay_at_concurrency_cap: replay succeeds even when cap is reached', async () => {
    setupDb();
    const { orchSession } = seedGroups({ withMg: false });

    // Set cap to 1
    const capCfg = JSON.stringify({
      concurrencyCap: 1,
      noProgressTimeoutSec: 1800,
      spawnDeadlineSec: 300,
      drainGraceSec: 120,
    });
    getDb()
      .prepare(
        `UPDATE agent_group_capabilities SET config_json = ? WHERE agent_group_id = 'ag-orch' AND role = 'orchestrator'`,
      )
      .run(capCfg);

    const { getChannelAdapter } = await import('../../channels/channel-registry.js');
    vi.mocked(getChannelAdapter).mockReturnValue(undefined);

    // Insert a pre-existing running task to fill the cap (child session lives in same group)
    getDb()
      .prepare(`INSERT OR IGNORE INTO sessions (id, agent_group_id, created_at) VALUES (?, ?, ?)`)
      .run('some-child-sess', 'ag-orch', ts());

    const replayHash = computeRequestHash('Do X', null);
    insertTaskAtomic({
      task_id: 'task-filler',
      idempotency_key: 'k-other',
      parent_session_id: 'sess-orch',
      parent_agent_group_id: 'ag-orch',
      parent_messaging_group_id: null,
      child_session_id: 'some-child-sess',
      status: 'running',
      task_content: 'filler',
      request_hash: 'hash-filler',
      deadline: null,
      parent_platform_message_id: null,
      child_platform_thread_id: null,
      child_messaging_group_id: null,
      admitted_at: ts(),
      started_at: ts(),
      completed_at: null,
      failed_at: null,
      cancelled_at: null,
      last_progress_at: ts(),
      last_progress_message: null,
      fail_reason: null,
      result_summary: null,
      dispatch_completion_attempts: 0,
      completion_lease_at: null,
      surface_mode: 'headless',
    });

    // Insert the task we want to replay
    insertTaskAtomic({
      task_id: 'task-replay',
      idempotency_key: 'k-replay',
      parent_session_id: 'sess-orch',
      parent_agent_group_id: 'ag-orch',
      parent_messaging_group_id: null,
      child_session_id: null,
      status: 'pending',
      task_content: 'Do X',
      request_hash: replayHash,
      deadline: null,
      parent_platform_message_id: null,
      child_platform_thread_id: null,
      child_messaging_group_id: null,
      admitted_at: ts(),
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

    // Replay k-replay: cap is 1 (2 active tasks), but idempotency check runs BEFORE cap check (M20)
    await applySpawnTask({ content: 'Do X', idempotency_key: 'k-replay' }, orchSession);

    const orchMessages = getWrittenFor('sess-orch');
    expect(orchMessages.some((m) => m.includes('task-replay'))).toBe(true);
    expect(orchMessages.some((m) => m.includes('cap reached'))).toBe(false);
  });
});

describe('F1: e2e cancel during running', () => {
  it('test_e2e_cancel_during_running: cancel writes _spawn_cancel and arms kill timer', async () => {
    setupDb();
    const { orchSession } = seedGroups({ withMg: false });

    const { getChannelAdapter } = await import('../../channels/channel-registry.js');
    vi.mocked(getChannelAdapter).mockReturnValue(undefined);

    // Spawn and wait for running state (use real timers for this part)
    await applySpawnTask(
      { content: 'Do cancellable thing', idempotency_key: 'k-cancel' },
      orchSession,
    );
    await drainImmediate();
    await drainImmediate();

    const taskId = deriveSpawnTaskId('sess-orch', 'k-cancel');
    const task = getTaskById(taskId);
    expect(task!.status).toBe('running');

    const childSessionId = task!.child_session_id!;
    const childSession: Session = {
      id: childSessionId,
      agent_group_id: 'ag-orch',
      messaging_group_id: null,
      thread_id: null,
      status: 'active',
      container_status: 'running',
      agent_provider: null,
      last_active: null,
      created_at: ts(),
    };
    sessionMap.set(childSessionId, childSession);
    sessionMap.set('sess-orch', orchSession);

    // Switch to fake timers AFTER draining the real queue
    vi.useFakeTimers();

    // Cancel from orchestrator (parent session)
    await applySpawnCancel({ task_id: taskId, reason: 'changed mind' }, orchSession);

    // Verify cancelled in DB
    const cancelledTask = getTaskById(taskId);
    expect(cancelledTask!.status).toBe('cancelled');
    expect(cancelledTask!.cancelled_at).not.toBeNull();

    // Verify _spawn_cancel written to child
    const childMessages = getWrittenFor(childSessionId);
    const cancelMsg = childMessages.find((m) => m.includes('_spawn_cancel'));
    expect(cancelMsg).toBeDefined();
    const cancelParsed = JSON.parse(cancelMsg!);
    expect(cancelParsed._spawn_cancel.task_id).toBe(taskId);
    expect(cancelParsed._spawn_cancel.reason).toBe('changed mind');

    // Verify killContainer is NOT called yet (2-min timer hasn't fired)
    const { killContainer } = await import('../../container-runner.js');
    expect(vi.mocked(killContainer)).not.toHaveBeenCalled();

    // Advance fake timers by 120 seconds to fire the kill setTimeout
    vi.advanceTimersByTime(120_000);
    expect(vi.mocked(killContainer)).toHaveBeenCalledWith(childSessionId, expect.stringContaining('spawn_cancel'));

    // Verify parent got cancellation notification
    const orchMessages = getWrittenFor('sess-orch');
    expect(orchMessages.some((m) => m.includes('Task cancelled'))).toBe(true);

    vi.useRealTimers();
  }, 15_000);

  it('test_e2e_complete_after_cancel_is_no_op: CAS prevents overwriting cancelled status', async () => {
    setupDb();
    const { orchSession } = seedGroups({ withMg: false });

    const { getChannelAdapter } = await import('../../channels/channel-registry.js');
    vi.mocked(getChannelAdapter).mockReturnValue(undefined);

    // Spawn + drain
    await applySpawnTask({ content: 'Do then cancel', idempotency_key: 'k-cas' }, orchSession);
    await drainImmediate();
    await drainImmediate();

    const taskId = deriveSpawnTaskId('sess-orch', 'k-cas');
    const runningTask = getTaskById(taskId);
    const childSessionId = runningTask!.child_session_id!;

    const childSession: Session = {
      id: childSessionId,
      agent_group_id: 'ag-orch',
      messaging_group_id: null,
      thread_id: null,
      status: 'active',
      container_status: 'running',
      agent_provider: null,
      last_active: null,
      created_at: ts(),
    };
    sessionMap.set(childSessionId, childSession);
    sessionMap.set('sess-orch', orchSession);

    // Cancel it
    await applySpawnCancel({ task_id: taskId, reason: 'cancel first' }, orchSession);
    expect(getTaskById(taskId)!.status).toBe('cancelled');

    // Now child tries to complete — CAS should reject (status is already 'cancelled')
    const completionNotifyCountBefore = getWrittenFor('sess-orch').filter((m) => m.includes('Task completed')).length;

    await applySpawnComplete({ task_id: taskId, summary: 'too late' }, childSession);

    // Status must still be 'cancelled'
    expect(getTaskById(taskId)!.status).toBe('cancelled');

    // No extra 'Task completed' notification sent to parent
    const completionNotifyCountAfter = getWrittenFor('sess-orch').filter((m) => m.includes('Task completed')).length;
    expect(completionNotifyCountAfter).toBe(completionNotifyCountBefore);
  }, 10_000);
});

describe('F1: e2e watchdog terminates no-progress task', () => {
  it('test_e2e_watchdog_terminates_no_progress: sweep reaps task with stale last_progress_at', async () => {
    setupDb();
    const { orchSession } = seedGroups({ withMg: false });

    const { getChannelAdapter } = await import('../../channels/channel-registry.js');
    vi.mocked(getChannelAdapter).mockReturnValue(undefined);

    // Spawn + drain to get a running task
    await applySpawnTask({ content: 'Stall forever', idempotency_key: 'k-watchdog' }, orchSession);
    await drainImmediate();
    await drainImmediate();

    const taskId = deriveSpawnTaskId('sess-orch', 'k-watchdog');
    let task = getTaskById(taskId);
    expect(task!.status).toBe('running');

    // Set last_progress_at to 2 hours ago to trigger no-progress timeout
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    getDb()
      .prepare(`UPDATE tasks SET last_progress_at = ?, started_at = ? WHERE task_id = ?`)
      .run(twoHoursAgo, twoHoursAgo, taskId);

    // Ensure orchSession is retrievable for watchdog notification
    sessionMap.set('sess-orch', orchSession);

    // Trigger the watchdog sweep
    await _sweepTaskWatchdogForTesting();

    // Task should be failed with no_progress_timeout reason (design canonical enum)
    task = getTaskById(taskId);
    expect(task!.status).toBe('failed');
    expect(task!.fail_reason).toBe('no_progress_timeout');

    // Parent received task-update notification (watchdog writes action: 'spawn_task_watchdog_fail')
    const orchMessages = getWrittenFor('sess-orch');
    expect(orchMessages.some((m) => m.includes('spawn_task_watchdog_fail') || m.includes('no_progress_timeout'))).toBe(
      true,
    );
  }, 10_000);
});

describe('F1: e2e orphan recovery', () => {
  it('test_e2e_orphan_recovery: reconciler picks up admitted-but-incomplete task', async () => {
    setupDb();
    seedGroups({ withMg: false });

    const { getChannelAdapter } = await import('../../channels/channel-registry.js');
    vi.mocked(getChannelAdapter).mockReturnValue(undefined);

    // Insert an orphaned task: admitted (admitted_at set), no child_session_id, expired lease
    const taskId = deriveSpawnTaskId('sess-orch', 'k-orphan');
    // Use a past admitted_at > 60s ago so getOrphanedTasks picks it up
    const oldTs = new Date(Date.now() - 90_000).toISOString();
    insertTaskAtomic({
      task_id: taskId,
      idempotency_key: 'k-orphan',
      parent_session_id: 'sess-orch',
      parent_agent_group_id: 'ag-orch',
      parent_messaging_group_id: null,
      child_session_id: null,
      status: 'pending',
      task_content: 'orphaned work',
      request_hash: computeRequestHash('orphaned work', null),
      deadline: null,
      parent_platform_message_id: null,
      child_platform_thread_id: null,
      child_messaging_group_id: null,
      admitted_at: oldTs,
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

    // Verify the orphan is in 'pending' with no child_session_id
    const orphan = getTaskById(taskId);
    expect(orphan!.status).toBe('pending');
    expect(orphan!.child_session_id).toBeNull();

    // Run reconciler — it calls setImmediate(completeSpawnSideEffects, taskId, parentAgentGroupId)
    runReconcilerSweep();

    // Drain the setImmediate so completeSpawnSideEffects runs
    await drainImmediate();
    await drainImmediate();

    // The orphan should now be running with a child session
    const recovered = getTaskById(taskId);
    expect(recovered!.status).toBe('running');
    expect(recovered!.child_session_id).not.toBeNull();
  }, 10_000);
});
