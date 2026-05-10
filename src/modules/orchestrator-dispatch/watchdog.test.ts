/**
 * Unit tests for the watchdog decision function and outbound-DB helper.
 * The decideTaskAction tests are pure (no DB required).
 * The pendingTerminalDispatchOutboundSeenAt tests use in-memory SQLite via mocked path resolution.
 */
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { describe, expect, it, afterEach, vi } from 'vitest';

import { decideTaskAction } from './watchdog.js';
import type { Task } from './db/tasks.js';

const BASE = Date.parse('2026-04-20T12:00:00.000Z');

// ─── Fixtures ────────────────────────────────────────────────────────────────

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: 'task-1',
    idempotency_key: 'idem-1',
    parent_session_id: 'parent-sess',
    parent_agent_group_id: 'parent-ag',
    parent_messaging_group_id: null,
    target_agent_group_id: 'target-ag',
    child_session_id: null,
    status: 'running',
    task_content: '{}',
    request_hash: 'hash',
    deadline: null,
    parent_platform_message_id: null,
    child_platform_thread_id: null,
    child_messaging_group_id: null,
    admitted_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
    started_at: new Date(BASE - 4 * 60 * 1000).toISOString(),
    completed_at: null,
    failed_at: null,
    cancelled_at: null,
    last_progress_at: new Date(BASE - 2 * 60 * 1000).toISOString(),
    last_progress_message: null,
    fail_reason: null,
    result_summary: null,
    dispatch_completion_attempts: 0,
    completion_lease_at: null,
    surface_mode: 'headless',
    created_at: new Date(BASE - 5 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

const DEFAULT_ARGS = {
  now: BASE,
  childContainerStatus: null as 'running' | 'stopped' | null,
  terminalOutboundSeenAt: null as string | null,
  noProgressTimeoutSec: 1800,
  spawnDeadlineSec: 300,
  drainGraceSec: 120,
};

// ─── C1: decideTaskAction ─────────────────────────────────────────────────────

describe('decideTaskAction', () => {
  // ASSERT C20: deadline check runs FIRST, overrides drain-first
  it('test_deadline_overrides_drain: returns fail-deadline even when drain is active', () => {
    const task = baseTask({
      deadline: new Date(BASE - 60 * 60 * 1000).toISOString(), // 1 hour ago
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      terminalOutboundSeenAt: new Date(BASE).toISOString(), // drain active right now
    });
    expect(result.action).toBe('fail-deadline');
  });

  it('returns ok when deadline is in the future', () => {
    const task = baseTask({
      deadline: new Date(BASE + 60 * 60 * 1000).toISOString(), // 1 hour from now
    });
    const result = decideTaskAction({ ...DEFAULT_ARGS, task });
    expect(result.action).toBe('ok');
  });

  // ASSERT: spawn deadline applies only when status='pending' AND admitted_at IS NOT NULL AND started_at IS NULL
  it('returns fail-spawn-deadline for pending task past spawn window', () => {
    const task = baseTask({
      status: 'pending',
      started_at: null,
      last_progress_at: null,
      admitted_at: new Date(BASE - 6 * 60 * 1000).toISOString(), // 6 min ago, beyond 5 min spawn deadline
    });
    const result = decideTaskAction({ ...DEFAULT_ARGS, task });
    expect(result.action).toBe('fail-spawn-deadline');
  });

  it('returns ok for pending task within spawn window', () => {
    const task = baseTask({
      status: 'pending',
      started_at: null,
      last_progress_at: null,
      admitted_at: new Date(BASE - 2 * 60 * 1000).toISOString(), // 2 min ago, within 5 min spawn deadline
    });
    const result = decideTaskAction({ ...DEFAULT_ARGS, task });
    expect(result.action).toBe('ok');
  });

  it('does NOT trigger spawn deadline when started_at is set (already started)', () => {
    const task = baseTask({
      status: 'pending',
      started_at: new Date(BASE - 2 * 60 * 1000).toISOString(), // already started
      admitted_at: new Date(BASE - 10 * 60 * 1000).toISOString(), // old admission
    });
    // Not in spawn-deadline branch (started_at is set); last_progress_at is 2 min ago which is within 1800s
    const result = decideTaskAction({ ...DEFAULT_ARGS, task });
    expect(result.action).toBe('ok');
  });

  // ASSERT M24: drain-first grace measured from terminalOutboundSeenAt, NOT last_progress_at
  it('test_drain_grace_starts_from_terminal_seen_at: returns ok when drain is recent even with stale progress', () => {
    const task = baseTask({
      last_progress_at: new Date(BASE - 60 * 60 * 1000).toISOString(), // 1 hour ago — well past no-progress timeout
      child_session_id: 'child-sess',
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      childContainerStatus: 'running',
      terminalOutboundSeenAt: new Date(BASE - 30 * 1000).toISOString(), // 30s ago — within 120s grace
      drainGraceSec: 120,
    });
    expect(result.action).toBe('ok');
  });

  // ASSERT: drain-first allows up to drainGraceSec; beyond that, falls through
  it('test_drain_grace_expired: returns fail-no-progress when drain grace has elapsed', () => {
    const task = baseTask({
      last_progress_at: new Date(BASE - 60 * 60 * 1000).toISOString(), // 1 hour ago
      child_session_id: 'child-sess',
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      childContainerStatus: 'running',
      terminalOutboundSeenAt: new Date(BASE - 200 * 1000).toISOString(), // 200s ago — beyond 120s grace
      drainGraceSec: 120,
    });
    expect(result.action).toBe('fail-no-progress');
  });

  it('drain-first is NOT active when terminalOutboundSeenAt is null', () => {
    const task = baseTask({
      last_progress_at: new Date(BASE - 60 * 60 * 1000).toISOString(), // 1 hour ago — triggers no-progress
      child_session_id: 'child-sess',
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      terminalOutboundSeenAt: null,
      noProgressTimeoutSec: 1800,
    });
    expect(result.action).toBe('fail-no-progress');
  });

  // ASSERT C21: triple fallback last_signal = last_progress_at OR started_at OR admitted_at
  it('test_last_signal_falls_back_to_started_at: no reap when started_at is recent', () => {
    const task = baseTask({
      status: 'running',
      last_progress_at: null,
      started_at: new Date(BASE - 2 * 60 * 1000).toISOString(), // 2 min ago — within 1800s timeout
    });
    const result = decideTaskAction({ ...DEFAULT_ARGS, task });
    expect(result.action).toBe('ok');
  });

  it('test_last_signal_falls_back_to_admitted_at: uses admitted_at when both others are null', () => {
    const task = baseTask({
      status: 'running',
      last_progress_at: null,
      started_at: null,
      admitted_at: new Date(BASE - 2 * 60 * 1000).toISOString(), // 2 min ago — within 1800s timeout
    });
    const result = decideTaskAction({ ...DEFAULT_ARGS, task });
    expect(result.action).toBe('ok');
  });

  it('triggers no-progress using admitted_at fallback when all others are null and old', () => {
    const task = baseTask({
      status: 'running',
      last_progress_at: null,
      started_at: null,
      admitted_at: new Date(BASE - 60 * 60 * 1000).toISOString(), // 1 hour ago — past no-progress timeout
    });
    const result = decideTaskAction({ ...DEFAULT_ARGS, task, noProgressTimeoutSec: 1800 });
    expect(result.action).toBe('fail-no-progress');
  });

  // ASSERT C21 plan test: pending task with admitted_at falls into spawn-deadline path first
  it('test_no_progress_with_admitted_at_fallback: pending task hits spawn deadline first', () => {
    const task = baseTask({
      status: 'pending',
      started_at: null,
      last_progress_at: null,
      admitted_at: new Date(BASE - 31 * 60 * 1000).toISOString(), // 31 min ago
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      noProgressTimeoutSec: 1800,
      spawnDeadlineSec: 300,
    });
    // spawn deadline check fires first (pending + admitted + no started_at)
    expect(result.action).toBe('fail-spawn-deadline');
  });

  it('test_no_progress_running_with_started_at: running task hits no-progress when started_at is old', () => {
    const task = baseTask({
      status: 'running',
      started_at: new Date(BASE - 31 * 60 * 1000).toISOString(), // 31 min ago
      last_progress_at: null,
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      noProgressTimeoutSec: 1800,
    });
    expect(result.action).toBe('fail-no-progress');
  });

  // ASSERT: container-exit branch only when child_session_id IS NOT NULL
  it('test_container_exit_only_when_child_exists: no fail-container-exit when child_session_id is null', () => {
    const task = baseTask({
      child_session_id: null,
      last_progress_at: new Date(BASE - 2 * 60 * 1000).toISOString(), // recent progress
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      childContainerStatus: 'stopped',
    });
    // child_session_id is null → container exit branch doesn't fire
    expect(result.action).toBe('ok');
  });

  it('returns fail-container-exit when child exists and container stopped', () => {
    const task = baseTask({
      child_session_id: 'child-sess',
      last_progress_at: new Date(BASE - 2 * 60 * 1000).toISOString(), // recent progress
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      childContainerStatus: 'stopped',
    });
    expect(result.action).toBe('fail-container-exit');
  });

  it('returns ok when child exists and container is running', () => {
    const task = baseTask({
      child_session_id: 'child-sess',
      last_progress_at: new Date(BASE - 2 * 60 * 1000).toISOString(),
    });
    const result = decideTaskAction({
      ...DEFAULT_ARGS,
      task,
      childContainerStatus: 'running',
    });
    expect(result.action).toBe('ok');
  });

  it('returns ok when everything is healthy', () => {
    const task = baseTask();
    const result = decideTaskAction({ ...DEFAULT_ARGS, task });
    expect(result.action).toBe('ok');
  });
});

// ─── C2: pendingTerminalDispatchOutboundSeenAt ────────────────────────────────
// Tests use real on-disk SQLite DBs in a temp directory, with vi.mock to
// redirect outboundDbPath to the temp location.

const TEST_ROOT = path.join(os.tmpdir(), 'watchdog-test-' + process.pid);
const tmpSessions: string[] = [];

vi.mock('../../session-manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...real,
    outboundDbPath: (agentGroupId: string, sessionId: string) =>
      path.join(TEST_ROOT, agentGroupId, sessionId, 'outbound.db'),
  };
});

function makeTmpOutboundDb(agentGroupId: string, sessionId: string): Database.Database {
  const dir = path.join(TEST_ROOT, agentGroupId, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  tmpSessions.push(agentGroupId);

  const dbPath = path.join(dir, 'outbound.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_out (
      id          TEXT PRIMARY KEY,
      seq         INTEGER UNIQUE,
      in_reply_to TEXT,
      timestamp   TEXT NOT NULL,
      kind        TEXT NOT NULL,
      content     TEXT NOT NULL
    );
  `);
  return db;
}

afterEach(() => {
  // Clean up session directories created in each test
  for (const agentGroupId of tmpSessions) {
    try {
      fs.rmSync(path.join(TEST_ROOT, agentGroupId), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  tmpSessions.length = 0;
});

describe('pendingTerminalDispatchOutboundSeenAt', () => {
  it('test_returns_null_no_pending: returns null when only chat messages exist', async () => {
    const { pendingTerminalDispatchOutboundSeenAt } = await import('./watchdog.js');
    const agentGroupId = 'ag-null-test';
    const sessionId = 'sess-null-test';
    const db = makeTmpOutboundDb(agentGroupId, sessionId);
    db.prepare("INSERT INTO messages_out VALUES ('m1', 1, null, '2026-01-01T00:00:00.000Z', 'chat', ?)").run(
      JSON.stringify({ text: 'hello world' }),
    );
    db.close();

    const result = pendingTerminalDispatchOutboundSeenAt(agentGroupId, sessionId);
    expect(result).toBeNull();
  });

  it('test_returns_min_timestamp: returns earliest timestamp for multiple terminal rows', async () => {
    const { pendingTerminalDispatchOutboundSeenAt } = await import('./watchdog.js');
    const agentGroupId = 'ag-min-test';
    const sessionId = 'sess-min-test';
    const db = makeTmpOutboundDb(agentGroupId, sessionId);
    db.prepare("INSERT INTO messages_out VALUES ('m1', 1, null, '2026-01-01T00:01:00.000Z', 'system', ?)").run(
      JSON.stringify({ action: 'dispatch_complete', task_id: 'task-1' }),
    );
    db.prepare("INSERT INTO messages_out VALUES ('m2', 2, null, '2026-01-01T00:02:00.000Z', 'system', ?)").run(
      JSON.stringify({ action: 'dispatch_complete', task_id: 'task-2' }),
    );
    db.prepare("INSERT INTO messages_out VALUES ('m3', 3, null, '2026-01-01T00:00:30.000Z', 'system', ?)").run(
      JSON.stringify({ action: 'dispatch_failed', task_id: 'task-3' }),
    );
    db.close();

    const result = pendingTerminalDispatchOutboundSeenAt(agentGroupId, sessionId);
    expect(result).toBe('2026-01-01T00:00:30.000Z');
  });

  it('test_excludes_chat_messages_with_action_word: excludes non-system rows even with action text', async () => {
    const { pendingTerminalDispatchOutboundSeenAt } = await import('./watchdog.js');
    const agentGroupId = 'ag-chat-test';
    const sessionId = 'sess-chat-test';
    const db = makeTmpOutboundDb(agentGroupId, sessionId);
    // Chat message containing action text — kind='chat' guard must reject it
    db.prepare("INSERT INTO messages_out VALUES ('m1', 1, null, '2026-01-01T00:01:00.000Z', 'chat', ?)").run(
      JSON.stringify({ action: 'dispatch_complete', text: 'task done' }),
    );
    db.close();

    const result = pendingTerminalDispatchOutboundSeenAt(agentGroupId, sessionId);
    expect(result).toBeNull();
  });

  it('test_excludes_false_positive_match: excludes system rows with action as superstring of dispatch_complete', async () => {
    const { pendingTerminalDispatchOutboundSeenAt } = await import('./watchdog.js');
    const agentGroupId = 'ag-fp-test';
    const sessionId = 'sess-fp-test';
    const db = makeTmpOutboundDb(agentGroupId, sessionId);
    // "dispatch_complete_other" contains "dispatch_complete" as substring — must NOT match
    db.prepare("INSERT INTO messages_out VALUES ('m1', 1, null, '2026-01-01T00:01:00.000Z', 'system', ?)").run(
      JSON.stringify({ action: 'dispatch_complete_other' }),
    );
    db.close();

    const result = pendingTerminalDispatchOutboundSeenAt(agentGroupId, sessionId);
    expect(result).toBeNull();
  });

  it('returns null when outbound.db does not exist', async () => {
    const { pendingTerminalDispatchOutboundSeenAt } = await import('./watchdog.js');
    // No DB created at this path
    const result = pendingTerminalDispatchOutboundSeenAt('ag-nonexistent-xyz', 'sess-nonexistent-xyz');
    expect(result).toBeNull();
  });

  it('matches dispatch_failed correctly', async () => {
    const { pendingTerminalDispatchOutboundSeenAt } = await import('./watchdog.js');
    const agentGroupId = 'ag-failed-test';
    const sessionId = 'sess-failed-test';
    const db = makeTmpOutboundDb(agentGroupId, sessionId);
    db.prepare("INSERT INTO messages_out VALUES ('m1', 1, null, '2026-01-01T00:05:00.000Z', 'system', ?)").run(
      JSON.stringify({ action: 'dispatch_failed', task_id: 'task-1' }),
    );
    db.close();

    const result = pendingTerminalDispatchOutboundSeenAt(agentGroupId, sessionId);
    expect(result).toBe('2026-01-01T00:05:00.000Z');
  });
});
