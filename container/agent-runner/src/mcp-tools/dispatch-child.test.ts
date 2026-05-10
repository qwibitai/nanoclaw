/**
 * Tests for child-only MCP tools: dispatch_progress, dispatch_complete, dispatch_failed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { dispatchProgress, dispatchComplete, dispatchFailed } from './dispatch-child.js';

function createSessionRoutingWithTaskId(taskId: string | null): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT,
    platform_id TEXT,
    thread_id TEXT,
    dispatch_task_id TEXT,
    session_id TEXT
  )`);
  if (taskId !== null) {
    db.prepare(`INSERT INTO session_routing (id, dispatch_task_id) VALUES (1, ?)`).run(taskId);
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

describe('dispatch_progress', () => {
  it('test_dispatch_progress_auto_fills_task_id', async () => {
    createSessionRoutingWithTaskId('dispatch-test123');
    await dispatchProgress.handler({ message: 'half done' });

    const outbound = getOutboundDb();
    const rows = outbound.prepare(`SELECT content FROM messages_out WHERE kind = 'system'`).all() as Array<{ content: string }>;
    expect(rows.length).toBeGreaterThan(0);

    const parsed = JSON.parse(rows[0].content);
    expect(parsed.action).toBe('dispatch_progress');
    expect(parsed.task_id).toBe('dispatch-test123');
    expect(parsed.message).toBe('half done');
  });

  it('test_dispatch_progress_allows_explicit_task_id_override', async () => {
    createSessionRoutingWithTaskId('dispatch-auto');
    await dispatchProgress.handler({ message: 'override test', task_id: 'dispatch-override' });

    const outbound = getOutboundDb();
    const rows = outbound.prepare(`SELECT content FROM messages_out WHERE kind = 'system'`).all() as Array<{ content: string }>;
    const parsed = JSON.parse(rows[0].content);
    expect(parsed.task_id).toBe('dispatch-override');
  });

  it('test_dispatch_progress_requires_message', async () => {
    createSessionRoutingWithTaskId('dispatch-abc');
    const result = await dispatchProgress.handler({});
    expect(result.isError).toBe(true);
  });

  it('test_dispatch_progress_without_session_dispatch_task_id_returns_error', async () => {
    createSessionRoutingWithTaskId(null);
    const result = await dispatchProgress.handler({ message: 'test' });
    expect(result.isError).toBe(true);
  });
});

describe('dispatch_complete', () => {
  it('test_dispatch_complete_terminal_state', async () => {
    createSessionRoutingWithTaskId('dispatch-x');
    await dispatchComplete.handler({ summary: 'All done successfully' });

    const outbound = getOutboundDb();
    const rows = outbound.prepare(`SELECT content FROM messages_out WHERE kind = 'system'`).all() as Array<{ content: string }>;
    const parsed = JSON.parse(rows[0].content);
    expect(parsed.action).toBe('dispatch_complete');
    expect(parsed.task_id).toBe('dispatch-x');
    expect(parsed.summary).toBe('All done successfully');
  });

  it('test_dispatch_complete_requires_summary', async () => {
    createSessionRoutingWithTaskId('dispatch-x');
    const result = await dispatchComplete.handler({});
    expect(result.isError).toBe(true);
  });
});

describe('dispatch_failed', () => {
  it('test_dispatch_failed_with_reason', async () => {
    createSessionRoutingWithTaskId('dispatch-x');
    await dispatchFailed.handler({ summary: 'Bad failure', fail_reason: 'agent_error' });

    const outbound = getOutboundDb();
    const rows = outbound.prepare(`SELECT content FROM messages_out WHERE kind = 'system'`).all() as Array<{ content: string }>;
    const parsed = JSON.parse(rows[0].content);
    expect(parsed.action).toBe('dispatch_failed');
    expect(parsed.task_id).toBe('dispatch-x');
    expect(parsed.summary).toBe('Bad failure');
    expect(parsed.fail_reason).toBe('agent_error');
  });

  it('test_dispatch_failed_without_fail_reason', async () => {
    createSessionRoutingWithTaskId('dispatch-y');
    await dispatchFailed.handler({ summary: 'Unknown failure' });

    const outbound = getOutboundDb();
    const rows = outbound.prepare(`SELECT content FROM messages_out WHERE kind = 'system'`).all() as Array<{ content: string }>;
    const parsed = JSON.parse(rows[0].content);
    expect(parsed.action).toBe('dispatch_failed');
    expect(parsed.fail_reason).toBeUndefined();
  });

  it('test_dispatch_failed_auto_fills_task_id', async () => {
    createSessionRoutingWithTaskId('dispatch-auto-fill');
    await dispatchFailed.handler({ summary: 'Failed' });

    const outbound = getOutboundDb();
    const rows = outbound.prepare(`SELECT content FROM messages_out WHERE kind = 'system'`).all() as Array<{ content: string }>;
    const parsed = JSON.parse(rows[0].content);
    expect(parsed.task_id).toBe('dispatch-auto-fill');
  });
});
