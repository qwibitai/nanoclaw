import { afterEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { runReconcilerSweep } from './reconciler.js';

// Mock completeSpawnSideEffects so we can track calls without running the full side-effect chain
vi.mock('./dispatch.js', () => ({
  completeSpawnSideEffects: vi.fn().mockResolvedValue(undefined),
  applySpawnTask: vi.fn(),
}));

function now(): string {
  return new Date().toISOString();
}

function tenMinutesAgo(): string {
  return new Date(Date.now() - 10 * 60 * 1000).toISOString();
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
  getDb()
    .prepare(`INSERT INTO sessions (id, agent_group_id, created_at) VALUES (?, ?, ?)`)
    .run('sess-parent', 'ag-parent', now());
}

function insertOrphanedTask(taskId: string, leaseAt: string | null = null): void {
  getDb()
    .prepare(
      `INSERT INTO tasks (task_id, idempotency_key, parent_session_id, parent_agent_group_id,
        status, task_content, request_hash, admitted_at, surface_mode,
        completion_lease_at, dispatch_completion_attempts, created_at)
       VALUES (?, ?, 'sess-parent', 'ag-parent', 'pending', 'do x', 'hash', ?, 'headless', ?, 0, ?)`,
    )
    .run(taskId, `ik-${taskId}`, tenMinutesAgo(), leaseAt, now());
}

afterEach(() => {
  closeDb();
  vi.clearAllMocks();
});

describe('runReconcilerSweep', () => {
  it('test_reconciler_picks_up_orphan: schedules side-effects for orphaned task', async () => {
    setupDb();
    seedGroups();
    insertOrphanedTask('task-orphan', null); // no lease

    const setImmediateSpy = vi.spyOn(global, 'setImmediate');

    runReconcilerSweep();

    expect(setImmediateSpy).toHaveBeenCalledWith(expect.any(Function), 'task-orphan', 'ag-parent');

    setImmediateSpy.mockRestore();
  });

  it('test_reconciler_skips_active_lease: does not schedule when lease is held', async () => {
    setupDb();
    seedGroups();
    // lease set to NOW (not expired — within 60s TTL)
    insertOrphanedTask('task-leased', now());

    const setImmediateSpy = vi.spyOn(global, 'setImmediate');

    runReconcilerSweep();

    expect(setImmediateSpy).not.toHaveBeenCalledWith(expect.any(Function), 'task-leased', expect.any(String));

    setImmediateSpy.mockRestore();
  });

  it('picks up multiple orphans in one sweep', async () => {
    setupDb();
    seedGroups();
    insertOrphanedTask('task-a');
    insertOrphanedTask('task-b');

    const setImmediateSpy = vi.spyOn(global, 'setImmediate');

    runReconcilerSweep();

    const taskIds = (setImmediateSpy.mock.calls as unknown as [Function, string, string][]).map((c) => c[1]);
    expect(taskIds).toContain('task-a');
    expect(taskIds).toContain('task-b');

    setImmediateSpy.mockRestore();
  });

  it('does nothing when no orphans exist', async () => {
    setupDb();
    seedGroups();

    const setImmediateSpy = vi.spyOn(global, 'setImmediate');
    runReconcilerSweep();
    expect(setImmediateSpy).not.toHaveBeenCalled();
    setImmediateSpy.mockRestore();
  });
});

describe('index.ts — ASSERT registered actions', () => {
  it('test_index_registers_five_actions without cancel_task', async () => {
    const { readFileSync } = await import('fs');
    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');

    // Read the TypeScript source directly (not the compiled output)
    const dir = dirname(fileURLToPath(import.meta.url));
    const indexSrc = readFileSync(join(dir, 'index.ts'), 'utf-8');

    // ASSERT: exactly 5 registerDeliveryAction calls
    const matches = indexSrc.match(/registerDeliveryAction\(/g) ?? [];
    expect(matches.length).toBe(5);

    // ASSERT: all 5 expected actions present (renamed dispatch_* → spawn_*)
    const expectedActions = [
      'spawn_task',
      'spawn_complete',
      'spawn_failed',
      'spawn_cancel',
      'spawn_progress',
    ];
    for (const action of expectedActions) {
      expect(indexSrc).toContain(`'${action}'`);
    }

    // ASSERT: legacy dispatch_* names are NOT registered
    expect(indexSrc).not.toContain("'dispatch_task'");
    // ASSERT: 'cancel_task' (with quotes) is NOT registered (collision avoidance with scheduling module)
    expect(indexSrc).not.toContain("'cancel_task'");
  });
});
