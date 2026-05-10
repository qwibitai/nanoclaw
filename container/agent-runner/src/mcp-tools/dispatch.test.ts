/**
 * Tests for orchestrator-only MCP tools: dispatch_task, list_dispatched_tasks, dispatch_cancel.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { deriveDispatchTaskId } from '../dispatch/derive-task-id.js';
import { dispatchTask, listDispatchedTasks, dispatchCancel } from './dispatch.js';

function createSessionRoutingTable(sessionId?: string): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT,
    platform_id TEXT,
    thread_id TEXT,
    dispatch_task_id TEXT,
    session_id TEXT
  )`);
  if (sessionId !== undefined) {
    db.prepare(`INSERT INTO session_routing (id, session_id) VALUES (1, ?)`).run(sessionId);
  }
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('dispatch_task', () => {
  it('test_dispatch_task_returns_locally_computed_task_id', async () => {
    createSessionRoutingTable('sess-parent-1');
    const result = await dispatchTask.handler({
      target_group: 'ag-child',
      content: 'Do something useful',
      idempotency_key: 'test-key-1',
    });
    const text = (result.content[0] as { type: string; text: string }).text;
    const expectedTaskId = deriveDispatchTaskId('sess-parent-1', 'test-key-1');
    expect(text).toContain(expectedTaskId);
    expect(result.isError).toBeFalsy();
  });

  it('test_dispatch_task_writes_outbound_row', async () => {
    createSessionRoutingTable('sess-parent-1');
    await dispatchTask.handler({
      target_group: 'ag-target',
      content: 'task content here',
      idempotency_key: 'idem-42',
    });

    const outbound = getOutboundDb();
    const rows = outbound.prepare(`SELECT * FROM messages_out WHERE kind = 'system'`).all() as Array<{
      content: string;
      kind: string;
    }>;
    expect(rows.length).toBeGreaterThan(0);

    const parsed = JSON.parse(rows[0].content);
    expect(parsed.action).toBe('dispatch_task');
    expect(parsed.target_group).toBe('ag-target');
    expect(parsed.content).toBe('task content here');
    expect(parsed.idempotency_key).toBe('idem-42');
    expect(parsed.task_id).toBe(deriveDispatchTaskId('sess-parent-1', 'idem-42'));
  });

  it('test_dispatch_task_includes_deadline_when_provided', async () => {
    createSessionRoutingTable('sess-parent-2');
    const deadline = '2026-12-31T23:59:59Z';
    await dispatchTask.handler({
      target_group: 'ag-y',
      content: 'Deadline task',
      idempotency_key: 'dl-key',
      deadline,
    });

    const outbound = getOutboundDb();
    const rows = outbound.prepare(`SELECT content FROM messages_out WHERE kind = 'system'`).all() as Array<{ content: string }>;
    const parsed = JSON.parse(rows[0].content);
    expect(parsed.deadline).toBe(deadline);
  });

  it('test_dispatch_task_without_session_id_errors_loud', async () => {
    // When session_id is null (no session_routing row), the tool refuses to dispatch
    // rather than computing task_id from an empty parent_session_id (which would
    // silently mismatch the host's task_id derivation). Per QA Adversarial-reviewer
    // finding #4 — fail loud at the caller boundary.
    createSessionRoutingTable();
    const result = await dispatchTask.handler({
      target_group: 'ag-z',
      content: 'fallback',
      idempotency_key: 'k0',
    });
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(text).toMatch(/cannot determine parent session id/i);
    expect(result.isError).toBe(true);
  });

  it('test_dispatch_task_requires_target_group_content_idempotency_key', async () => {
    createSessionRoutingTable('sess-1');
    const result = await dispatchTask.handler({ content: 'missing target', idempotency_key: 'k' });
    expect(result.isError).toBe(true);
  });
});

describe('list_dispatched_tasks', () => {
  it('test_list_dispatched_tasks_returns_text_result', async () => {
    createSessionRoutingTable('sess-p1');
    const result = await listDispatchedTasks.handler({});
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(typeof text).toBe('string');
    expect(result.isError).toBeFalsy();
  });

  it('test_list_dispatched_tasks_no_central_db_returns_gracefully', async () => {
    createSessionRoutingTable('sess-p1');
    // No central.db mounted (test environment) — should return gracefully
    const result = await listDispatchedTasks.handler({});
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(typeof text).toBe('string');
  });

  it('test_list_dispatched_tasks_no_session_id_returns_gracefully', async () => {
    createSessionRoutingTable(); // no session_id
    const result = await listDispatchedTasks.handler({});
    const text = (result.content[0] as { type: string; text: string }).text;
    expect(typeof text).toBe('string');
  });
});

describe('dispatch_cancel', () => {
  it('test_dispatch_cancel_writes_outbound_row', async () => {
    createSessionRoutingTable('sess-parent-3');
    await dispatchCancel.handler({ task_id: 'dispatch-abc123', reason: 'user cancelled' });

    const outbound = getOutboundDb();
    const rows = outbound.prepare(`SELECT content FROM messages_out WHERE kind = 'system'`).all() as Array<{ content: string }>;
    expect(rows.length).toBeGreaterThan(0);

    const parsed = JSON.parse(rows[0].content);
    expect(parsed.action).toBe('dispatch_cancel');
    expect(parsed.task_id).toBe('dispatch-abc123');
    expect(parsed.reason).toBe('user cancelled');
  });

  it('test_dispatch_cancel_without_reason', async () => {
    createSessionRoutingTable('sess-parent-4');
    await dispatchCancel.handler({ task_id: 'dispatch-xyz789' });

    const outbound = getOutboundDb();
    const rows = outbound.prepare(`SELECT content FROM messages_out WHERE kind = 'system'`).all() as Array<{ content: string }>;
    const parsed = JSON.parse(rows[0].content);
    expect(parsed.action).toBe('dispatch_cancel');
    expect(parsed.task_id).toBe('dispatch-xyz789');
    expect(parsed.reason).toBeUndefined();
  });

  it('test_dispatch_cancel_requires_task_id', async () => {
    createSessionRoutingTable('sess-parent-5');
    const result = await dispatchCancel.handler({});
    expect(result.isError).toBe(true);
  });
});
