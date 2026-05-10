import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, createSession, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { getTaskById, insertTaskAtomic } from './db/tasks.js';
import type { Task } from './db/tasks.js';
import { applyDispatchComplete, applyDispatchFailed } from './completion.js';
import type { Session } from '../../types.js';

vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../container-runner.js', () => ({
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

function makeWrongSession(): Session {
  return {
    id: 'sess-wrong',
    agent_group_id: 'ag-other',
    messaging_group_id: null,
    thread_id: null,
    status: 'active',
    container_status: 'running',
    agent_provider: null,
    last_active: null,
    created_at: now(),
  };
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

afterEach(() => {
  closeDb();
  vi.clearAllMocks();
});

describe('applyDispatchComplete', () => {
  it('test_complete_happy_path: transitions to completed and notifies parent', async () => {
    setupDb();
    seedGroups();
    makeRunningTask();

    const { getSession } = await import('../../db/sessions.js');
    vi.mocked(getSession).mockReturnValue(makeParentSession());

    await applyDispatchComplete({ task_id: 'task-1', summary: 'Done!' }, makeChildSession());

    const task = getTaskById('task-1');
    expect(task!.status).toBe('completed');
    expect(task!.result_summary).toBe('Done!');
    expect(task!.completed_at).toBeTruthy();

    const { writeSessionMessage } = await import('../../session-manager.js');
    expect(vi.mocked(writeSessionMessage)).toHaveBeenCalledWith(
      'ag-parent',
      'sess-parent',
      expect.objectContaining({ content: expect.stringContaining('task-1') }),
    );
  });

  it('ASSERT: rejects when content lacks task_id', async () => {
    setupDb();
    seedGroups();
    makeRunningTask();

    await applyDispatchComplete({}, makeChildSession()); // no task_id

    const task = getTaskById('task-1');
    expect(task!.status).toBe('running'); // unchanged
  });

  it('test_auth_rejects_wrong_session: does not transition when child_session_id mismatch', async () => {
    setupDb();
    seedGroups();
    makeRunningTask();

    await applyDispatchComplete({ task_id: 'task-1', summary: 'Done' }, makeWrongSession());

    const task = getTaskById('task-1');
    expect(task!.status).toBe('running'); // unchanged

    const { writeSessionMessage } = await import('../../session-manager.js');
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
  });

  it('test_complete_after_cancel_skips_notify: skips parent notify when already terminal', async () => {
    setupDb();
    seedGroups();
    const task = makeRunningTask();

    // Pre-cancel the task
    getDb()
      .prepare(`UPDATE tasks SET status = 'cancelled', cancelled_at = ? WHERE task_id = ?`)
      .run(now(), task.task_id);

    const { writeSessionMessage } = await import('../../session-manager.js');
    await applyDispatchComplete({ task_id: 'task-1', summary: 'Done' }, makeChildSession());

    const updated = getTaskById('task-1');
    expect(updated!.status).toBe('cancelled'); // unchanged — CAS rejected
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
  });
});

describe('applyDispatchFailed', () => {
  it('test_failed_includes_reason: stores fail_reason and transitions to failed', async () => {
    setupDb();
    seedGroups();
    makeRunningTask();

    const { getSession } = await import('../../db/sessions.js');
    vi.mocked(getSession).mockReturnValue(makeParentSession());

    await applyDispatchFailed(
      { task_id: 'task-1', summary: 'Error occurred', fail_reason: 'agent_error' },
      makeChildSession(),
    );

    const task = getTaskById('task-1');
    expect(task!.status).toBe('failed');
    expect(task!.fail_reason).toBe('agent_error');
    expect(task!.result_summary).toBe('Error occurred');
  });

  it('ASSERT: two-column auth enforced for failed', async () => {
    setupDb();
    seedGroups();
    makeRunningTask();

    await applyDispatchFailed({ task_id: 'task-1', summary: 'X' }, makeWrongSession());

    const task = getTaskById('task-1');
    expect(task!.status).toBe('running'); // unchanged
  });

  it('ASSERT: skips parent notify when transition returns false', async () => {
    setupDb();
    seedGroups();
    makeRunningTask();

    // Pre-complete the task
    getDb().prepare(`UPDATE tasks SET status = 'completed', completed_at = ? WHERE task_id = ?`).run(now(), 'task-1');

    const { writeSessionMessage } = await import('../../session-manager.js');
    await applyDispatchFailed({ task_id: 'task-1', summary: 'X' }, makeChildSession());

    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
  });
});
