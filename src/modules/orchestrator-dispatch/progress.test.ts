import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { getTaskById, insertTaskAtomic } from './db/tasks.js';
import type { Task } from './db/tasks.js';
import { applyDispatchProgress } from './progress.js';
import type { Session } from '../../types.js';

function now(): string {
  return new Date().toISOString();
}

function setupDb(): void {
  const db = initTestDb();
  db.pragma('foreign_keys = ON');
  runMigrations(db);
}

function seedGroups(): void {
  createAgentGroup({ id: 'ag-parent', name: 'ag-parent', folder: 'ag-parent', agent_provider: null, created_at: now() });
  createAgentGroup({ id: 'ag-child', name: 'ag-child', folder: 'ag-child', agent_provider: null, created_at: now() });
  getDb().prepare(`INSERT INTO sessions (id, agent_group_id, created_at) VALUES (?, ?, ?)`).run('sess-parent', 'ag-parent', now());
  getDb().prepare(`INSERT INTO sessions (id, agent_group_id, created_at) VALUES (?, ?, ?)`).run('sess-child', 'ag-child', now());
}

function makeRunningTask(lastProgressAt?: string): Task {
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
    last_progress_at: lastProgressAt ?? new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
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

afterEach(() => {
  closeDb();
  vi.clearAllMocks();
});

describe('applyDispatchProgress', () => {
  it('test_progress_resets_timer: updates last_progress_at and last_progress_message', async () => {
    setupDb();
    seedGroups();
    makeRunningTask();

    const before = Date.now();
    await applyDispatchProgress({ task_id: 'task-1', message: 'Working' }, makeChildSession());
    const after = Date.now();

    const task = getTaskById('task-1');
    expect(task!.last_progress_message).toBe('Working');
    // last_progress_at should be within this test run
    const progressMs = new Date(task!.last_progress_at!).getTime();
    expect(progressMs).toBeGreaterThanOrEqual(before);
    expect(progressMs).toBeLessThanOrEqual(after + 100);
  });

  it('test_progress_truncates_500: truncates message to 500 chars', async () => {
    setupDb();
    seedGroups();
    makeRunningTask();

    await applyDispatchProgress({ task_id: 'task-1', message: 'X'.repeat(1000) }, makeChildSession());

    const task = getTaskById('task-1');
    expect(task!.last_progress_message!.length).toBe(500);
  });

  it('test_progress_wrong_session_silent: does not throw on auth mismatch', async () => {
    setupDb();
    seedGroups();
    makeRunningTask();

    await expect(
      applyDispatchProgress({ task_id: 'task-1', message: 'Working' }, makeWrongSession()),
    ).resolves.not.toThrow();

    // Task should be unchanged (no update happened)
    const task = getTaskById('task-1');
    expect(task!.last_progress_message).toBeNull(); // not updated
  });

  it('ASSERT: no status guard — progress can be reported on any status', async () => {
    setupDb();
    seedGroups();
    // Insert task with status=pending (unusual but should still work)
    insertTaskAtomic({
      task_id: 'task-pend',
      idempotency_key: 'ik-p',
      parent_session_id: 'sess-parent',
      parent_agent_group_id: 'ag-parent',
      parent_messaging_group_id: null,
      target_agent_group_id: 'ag-child',
      child_session_id: 'sess-child',
      status: 'running', // need to be 'running' for auth to match
      task_content: 'x',
      request_hash: 'h',
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
    // Force status to 'cancelled' to verify no status guard
    getDb().prepare(`UPDATE tasks SET status = 'cancelled' WHERE task_id = 'task-pend'`).run();

    // Should not throw — no status guard
    await expect(
      applyDispatchProgress({ task_id: 'task-pend', message: 'Still reporting' }, makeChildSession()),
    ).resolves.not.toThrow();
  });
});
