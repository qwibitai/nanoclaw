import { describe, it, expect, afterEach } from 'vitest';
import {
  insertTaskAtomic,
  getTaskById,
  getTaskByParentAndIdempotency,
  acquireCompletionLease,
  updateArtifactColumn,
  transitionToTerminal,
  getOrphanedTasks,
  incrementCompletionAttempts,
  type Task,
} from './tasks.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../../db/index.js';
import { getDb } from '../../../db/connection.js';

function now(): string {
  return new Date().toISOString();
}

afterEach(() => {
  closeDb();
});

function setupDb(): void {
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

function seedAgentAndSession(agId: string, sessId: string): void {
  createAgentGroup({ id: agId, name: agId, folder: agId, agent_provider: null, created_at: now() });
  getDb().prepare(`INSERT INTO sessions (id, agent_group_id, created_at) VALUES (?, ?, ?)`).run(sessId, agId, now());
}

function makeTask(overrides: Partial<Omit<Task, 'created_at'>> = {}): Omit<Task, 'created_at'> {
  return {
    task_id: 'task-1',
    idempotency_key: 'ik-1',
    parent_session_id: 'sess-parent',
    parent_agent_group_id: 'ag-parent',
    parent_messaging_group_id: null,
    target_agent_group_id: 'ag-target',
    child_session_id: null,
    status: 'pending',
    task_content: 'do the thing',
    request_hash: 'abc123',
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
    surface_mode: 'pending',
    ...overrides,
  };
}

describe('tasks CRUD', () => {
  it('test_insert_atomic_idempotent_collision', () => {
    setupDb();
    seedAgentAndSession('ag-parent', 'sess-parent');
    seedAgentAndSession('ag-target', 'sess-target');

    const t = makeTask();
    const first = insertTaskAtomic(t);
    expect(first).not.toBeNull();
    expect(first!.task_id).toBe('task-1');

    const second = insertTaskAtomic(t);
    expect(second).toBeNull();
  });

  it('test_get_by_id', () => {
    setupDb();
    seedAgentAndSession('ag-parent', 'sess-parent');
    seedAgentAndSession('ag-target', 'sess-target');

    insertTaskAtomic(makeTask());
    const found = getTaskById('task-1');
    expect(found).not.toBeNull();
    expect(found!.task_id).toBe('task-1');
    expect(found!.idempotency_key).toBe('ik-1');
  });

  it('test_get_by_parent_and_idempotency', () => {
    setupDb();
    seedAgentAndSession('ag-parent', 'sess-parent');
    seedAgentAndSession('ag-target', 'sess-target');

    insertTaskAtomic(makeTask());
    const found = getTaskByParentAndIdempotency('sess-parent', 'ik-1');
    expect(found).not.toBeNull();
    expect(found!.task_id).toBe('task-1');

    const notFound = getTaskByParentAndIdempotency('sess-parent', 'nonexistent');
    expect(notFound).toBeNull();
  });

  it('test_acquire_lease_blocks_concurrent', () => {
    setupDb();
    seedAgentAndSession('ag-parent', 'sess-parent');
    seedAgentAndSession('ag-target', 'sess-target');

    insertTaskAtomic(makeTask());

    const first = acquireCompletionLease('task-1');
    expect(first).not.toBeNull();

    const second = acquireCompletionLease('task-1');
    expect(second).toBeNull();
  });

  it('test_update_artifact_status_guard', () => {
    setupDb();
    seedAgentAndSession('ag-parent', 'sess-parent');
    seedAgentAndSession('ag-target', 'sess-target');

    // Insert in cancelled status by inserting then directly updating
    insertTaskAtomic(makeTask());
    getDb().prepare(`UPDATE tasks SET status='cancelled', cancelled_at=? WHERE task_id='task-1'`).run(now());

    const updated = updateArtifactColumn('task-1', 'parent_platform_message_id', 'msg-1');
    expect(updated).toBe(false);

    const row = getTaskById('task-1');
    expect(row!.parent_platform_message_id).toBeNull();
  });

  it('test_update_artifact_succeeds_for_pending', () => {
    setupDb();
    seedAgentAndSession('ag-parent', 'sess-parent');
    seedAgentAndSession('ag-target', 'sess-target');

    insertTaskAtomic(makeTask());
    const updated = updateArtifactColumn('task-1', 'parent_platform_message_id', 'msg-1');
    expect(updated).toBe(true);

    const row = getTaskById('task-1');
    expect(row!.parent_platform_message_id).toBe('msg-1');
  });

  it('test_transition_terminal_only_from_active', () => {
    setupDb();
    seedAgentAndSession('ag-parent', 'sess-parent');
    seedAgentAndSession('ag-target', 'sess-target');

    insertTaskAtomic(makeTask());
    // First transition to completed
    const first = transitionToTerminal('task-1', 'completed', { completed_at: now(), result_summary: 'done' });
    expect(first).toBe(true);

    // Second transition should fail (already terminal)
    const second = transitionToTerminal('task-1', 'failed', { failed_at: now(), fail_reason: 'x' });
    expect(second).toBe(false);

    const row = getTaskById('task-1');
    expect(row!.status).toBe('completed');
  });

  it('test_transition_to_cancelled', () => {
    setupDb();
    seedAgentAndSession('ag-parent', 'sess-parent');
    seedAgentAndSession('ag-target', 'sess-target');

    insertTaskAtomic(makeTask());
    const ok = transitionToTerminal('task-1', 'cancelled', { cancelled_at: now() });
    expect(ok).toBe(true);

    const row = getTaskById('task-1');
    expect(row!.status).toBe('cancelled');
  });

  it('test_increment_completion_attempts', () => {
    setupDb();
    seedAgentAndSession('ag-parent', 'sess-parent');
    seedAgentAndSession('ag-target', 'sess-target');

    insertTaskAtomic(makeTask());
    const count = incrementCompletionAttempts('task-1');
    expect(count).toBe(1);

    const count2 = incrementCompletionAttempts('task-1');
    expect(count2).toBe(2);
  });

  it('test_get_orphaned_tasks', () => {
    setupDb();
    seedAgentAndSession('ag-parent', 'sess-parent');
    seedAgentAndSession('ag-target', 'sess-target');

    // Insert task with no child_session_id and no lease
    insertTaskAtomic(makeTask());

    const orphans = getOrphanedTasks();
    expect(orphans.length).toBe(1);
    expect(orphans[0]!.task_id).toBe('task-1');
  });

  it('test_get_orphaned_tasks_excludes_leased', () => {
    setupDb();
    seedAgentAndSession('ag-parent', 'sess-parent');
    seedAgentAndSession('ag-target', 'sess-target');

    insertTaskAtomic(makeTask());
    acquireCompletionLease('task-1', 60);

    const orphans = getOrphanedTasks();
    expect(orphans.length).toBe(0);
  });
});
