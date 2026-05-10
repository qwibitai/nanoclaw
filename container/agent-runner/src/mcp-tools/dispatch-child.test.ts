/**
 * Tests for child-only MCP tools: spawn_progress, spawn_complete, spawn_failed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { spawnProgress, spawnComplete, spawnFailed } from './dispatch-child.js';

function createSessionRoutingWithTaskId(taskId: string | null): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT,
    platform_id TEXT,
    thread_id TEXT,
    spawn_task_id TEXT,
    session_id TEXT
  )`);
  if (taskId !== null) {
    db.prepare(`INSERT INTO session_routing (id, spawn_task_id) VALUES (1, ?)`).run(taskId);
  } else {
    db.prepare(`INSERT INTO session_routing (id) VALUES (1)`).run();
  }
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('spawn_progress', () => {
  it('test_spawn_progress_auto_fills_task_id', async () => {
    createSessionRoutingWithTaskId('spawn-test123');
    await spawnProgress.handler({ message: 'half done' });

    const outbound = getOutboundDb();
    const rows = outbound.prepare(`SELECT content FROM messages_out WHERE kind = 'system'`).all() as Array<{
      content: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);

    const parsed = JSON.parse(rows[0].content);
    expect(parsed.action).toBe('spawn_progress');
    expect(parsed.task_id).toBe('spawn-test123');
    expect(parsed.message).toBe('half done');
  });

  it('test_spawn_progress_allows_explicit_task_id_override', async () => {
    createSessionRoutingWithTaskId('spawn-auto');
    await spawnProgress.handler({ message: 'override test', task_id: 'spawn-override' });

    const outbound = getOutboundDb();
    const rows = outbound.prepare(`SELECT content FROM messages_out WHERE kind = 'system'`).all() as Array<{
      content: string;
    }>;
    const parsed = JSON.parse(rows[0].content);
    expect(parsed.task_id).toBe('spawn-override');
  });

  it('test_spawn_progress_requires_message', async () => {
    createSessionRoutingWithTaskId('spawn-abc');
    const result = await spawnProgress.handler({});
    expect(result.isError).toBe(true);
  });

  it('test_spawn_progress_without_session_spawn_task_id_returns_error', async () => {
    createSessionRoutingWithTaskId(null);
    const result = await spawnProgress.handler({ message: 'test' });
    expect(result.isError).toBe(true);
  });
});

describe('spawn_complete', () => {
  it('test_spawn_complete_terminal_state', async () => {
    createSessionRoutingWithTaskId('spawn-x');
    await spawnComplete.handler({ summary: 'All done successfully' });

    const outbound = getOutboundDb();
    const rows = outbound.prepare(`SELECT content FROM messages_out WHERE kind = 'system'`).all() as Array<{
      content: string;
    }>;
    const parsed = JSON.parse(rows[0].content);
    expect(parsed.action).toBe('spawn_complete');
    expect(parsed.task_id).toBe('spawn-x');
    expect(parsed.summary).toBe('All done successfully');
  });

  it('test_spawn_complete_requires_summary', async () => {
    createSessionRoutingWithTaskId('spawn-x');
    const result = await spawnComplete.handler({});
    expect(result.isError).toBe(true);
  });
});

describe('spawn_failed', () => {
  it('test_spawn_failed_with_reason', async () => {
    createSessionRoutingWithTaskId('spawn-x');
    await spawnFailed.handler({ summary: 'Bad failure', fail_reason: 'agent_error' });

    const outbound = getOutboundDb();
    const rows = outbound.prepare(`SELECT content FROM messages_out WHERE kind = 'system'`).all() as Array<{
      content: string;
    }>;
    const parsed = JSON.parse(rows[0].content);
    expect(parsed.action).toBe('spawn_failed');
    expect(parsed.task_id).toBe('spawn-x');
    expect(parsed.summary).toBe('Bad failure');
    expect(parsed.fail_reason).toBe('agent_error');
  });

  it('test_spawn_failed_without_fail_reason', async () => {
    createSessionRoutingWithTaskId('spawn-y');
    await spawnFailed.handler({ summary: 'Unknown failure' });

    const outbound = getOutboundDb();
    const rows = outbound.prepare(`SELECT content FROM messages_out WHERE kind = 'system'`).all() as Array<{
      content: string;
    }>;
    const parsed = JSON.parse(rows[0].content);
    expect(parsed.action).toBe('spawn_failed');
    expect(parsed.fail_reason).toBeUndefined();
  });

  it('test_spawn_failed_auto_fills_task_id', async () => {
    createSessionRoutingWithTaskId('spawn-auto-fill');
    await spawnFailed.handler({ summary: 'Failed' });

    const outbound = getOutboundDb();
    const rows = outbound.prepare(`SELECT content FROM messages_out WHERE kind = 'system'`).all() as Array<{
      content: string;
    }>;
    const parsed = JSON.parse(rows[0].content);
    expect(parsed.task_id).toBe('spawn-auto-fill');
  });
});
