import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { getTaskById, insertTaskAtomic } from './db/tasks.js';
import type { Task } from './db/tasks.js';
import { applyDispatchCancel } from './cancellation.js';
import type { Session } from '../../types.js';

vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../container-runner.js', () => ({
  killContainer: vi.fn(),
  wakeContainer: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../db/sessions.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../db/sessions.js')>();
  return {
    ...real,
    getSession: vi.fn(),
  };
});

function now(): string {
  return new Date().toISOString();
}

function setupDb(): void {
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

function seedGroups(): void {
  createAgentGroup({
    id: 'ag-parent',
    name: 'ag-parent',
    folder: 'ag-parent',
    agent_provider: null,
    created_at: now(),
  });
  createAgentGroup({ id: 'ag-child', name: 'ag-child', folder: 'ag-child', agent_provider: null, created_at: now() });
  getDb()
    .prepare(`INSERT INTO sessions (id, agent_group_id, created_at) VALUES (?, ?, ?)`)
    .run('sess-parent', 'ag-parent', now());
  getDb()
    .prepare(`INSERT INTO sessions (id, agent_group_id, created_at) VALUES (?, ?, ?)`)
    .run('sess-child', 'ag-child', now());
}

function makeRunningTask(): Task {
  return insertTaskAtomic({
    task_id: 'task-1',
    idempotency_key: 'ik-1',
    parent_session_id: 'sess-parent',
    parent_agent_group_id: 'ag-parent',
    parent_messaging_group_id: null,
    target_agent_group_id: 'ag-child',
    child_session_id: 'sess-child',
    status: 'running',
    task_content: 'do something',
    request_hash: 'hash123',
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

function makePendingTask(): Task {
  return insertTaskAtomic({
    task_id: 'task-pend',
    idempotency_key: 'ik-p',
    parent_session_id: 'sess-parent',
    parent_agent_group_id: 'ag-parent',
    parent_messaging_group_id: null,
    target_agent_group_id: 'ag-child',
    child_session_id: null,
    status: 'pending',
    task_content: 'pending work',
    request_hash: 'hash-p',
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
  })!;
}

function makeParentSession(): Session {
  return {
    id: 'sess-parent',
    agent_group_id: 'ag-parent',
    messaging_group_id: null,
    thread_id: null,
    status: 'active',
    container_status: 'idle',
    agent_provider: null,
    last_active: null,
    created_at: now(),
  };
}

function makeChildSession(): Session {
  return {
    id: 'sess-child',
    agent_group_id: 'ag-child',
    messaging_group_id: null,
    thread_id: null,
    status: 'active',
    container_status: 'running',
    agent_provider: null,
    last_active: null,
    created_at: now(),
  };
}

function makeOtherOrchestratorSession(): Session {
  return {
    id: 'sess-other-orchestrator',
    agent_group_id: 'ag-other',
    messaging_group_id: null,
    thread_id: null,
    status: 'active',
    container_status: 'idle',
    agent_provider: null,
    last_active: null,
    created_at: now(),
  };
}

afterEach(() => {
  closeDb();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('applyDispatchCancel', () => {
  it('test_cancel_parent_session_id_required: other orchestrator cannot cancel', async () => {
    setupDb();
    seedGroups();
    makeRunningTask();

    await applyDispatchCancel({ task_id: 'task-1' }, makeOtherOrchestratorSession());

    const task = getTaskById('task-1');
    expect(task!.status).toBe('running'); // unchanged

    const { writeSessionMessage } = await import('../../session-manager.js');
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
  });

  it('cancel pending task transitions to cancelled, no child envelope', async () => {
    setupDb();
    seedGroups();
    makePendingTask();

    const { getSession } = await import('../../db/sessions.js');
    vi.mocked(getSession).mockImplementation((id: string) => {
      if (id === 'sess-parent') return makeParentSession();
      return undefined;
    });

    await applyDispatchCancel({ task_id: 'task-pend', reason: 'user' }, makeParentSession());

    const task = getTaskById('task-pend');
    expect(task!.status).toBe('cancelled');

    const { writeSessionMessage } = await import('../../session-manager.js');
    const calls = vi.mocked(writeSessionMessage).mock.calls;
    // Only the parent confirmation — no child envelope (no child_session_id)
    const childEnvelopes = calls.filter((c) => {
      const content = JSON.parse(c[2].content as string);
      return content._dispatch_cancel !== undefined;
    });
    expect(childEnvelopes.length).toBe(0);
  });

  it('test_cancel_running_writes_envelope_and_arms_kill: running task gets cancel envelope + 2-min timer', async () => {
    setupDb();
    seedGroups();
    makeRunningTask();

    vi.useFakeTimers();

    const { getSession } = await import('../../db/sessions.js');
    vi.mocked(getSession).mockImplementation((id: string) => {
      if (id === 'sess-child') return makeChildSession();
      if (id === 'sess-parent') return makeParentSession();
      return undefined;
    });

    const { killContainer } = await import('../../container-runner.js');

    await applyDispatchCancel({ task_id: 'task-1', reason: 'user' }, makeParentSession());

    const task = getTaskById('task-1');
    expect(task!.status).toBe('cancelled');

    // Check child envelope was written
    const { writeSessionMessage } = await import('../../session-manager.js');
    const calls = vi.mocked(writeSessionMessage).mock.calls;
    const childEnvelopes = calls.filter((c) => {
      const parsed = JSON.parse(c[2].content as string);
      return parsed._dispatch_cancel !== undefined;
    });
    expect(childEnvelopes.length).toBe(1);

    // setTimeout should have been called with 120000ms
    expect(vi.mocked(killContainer)).not.toHaveBeenCalled(); // not yet

    vi.advanceTimersByTime(120_000);

    expect(vi.mocked(killContainer)).toHaveBeenCalledWith('sess-child', expect.any(String));
  });

  it('test_cancel_envelope_format: envelope has correct JSON structure', async () => {
    setupDb();
    seedGroups();
    makeRunningTask();

    vi.useFakeTimers();

    const { getSession } = await import('../../db/sessions.js');
    vi.mocked(getSession).mockImplementation((id: string) => {
      if (id === 'sess-child') return makeChildSession();
      if (id === 'sess-parent') return makeParentSession();
      return undefined;
    });

    await applyDispatchCancel({ task_id: 'task-1', reason: 'user' }, makeParentSession());

    const { writeSessionMessage } = await import('../../session-manager.js');
    const calls = vi.mocked(writeSessionMessage).mock.calls;
    const childCall = calls.find((c) => {
      const parsed = JSON.parse(c[2].content as string);
      return parsed._dispatch_cancel !== undefined;
    });

    expect(childCall).toBeDefined();
    const parsed = JSON.parse(childCall![2].content as string);
    expect(parsed._dispatch_cancel).toEqual({ task_id: 'task-1', reason: 'user' });
  });

  it('ASSERT: 2-min timer calls killContainer regardless of agent acknowledgement', async () => {
    setupDb();
    seedGroups();
    makeRunningTask();

    vi.useFakeTimers();

    const { getSession } = await import('../../db/sessions.js');
    vi.mocked(getSession).mockImplementation((id: string) => {
      if (id === 'sess-child') return makeChildSession();
      if (id === 'sess-parent') return makeParentSession();
      return undefined;
    });

    const { killContainer } = await import('../../container-runner.js');

    await applyDispatchCancel({ task_id: 'task-1', reason: 'timeout' }, makeParentSession());

    // Advance time to just before 2 minutes — should NOT have killed yet
    vi.advanceTimersByTime(119_999);
    expect(vi.mocked(killContainer)).not.toHaveBeenCalled();

    // Advance to exactly 2 minutes
    vi.advanceTimersByTime(1);
    expect(vi.mocked(killContainer)).toHaveBeenCalledWith('sess-child', expect.stringContaining('dispatch_cancel'));
  });
});
