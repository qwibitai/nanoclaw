/**
 * Tests for session-routing DB helpers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { initTestSessionDb, closeSessionDb, getInboundDb } from './connection.js';
import { getSessionSpawnTaskId, getSessionId } from './session-routing.js';

function createSessionRoutingTable(withSpawnTaskId = true, withSessionId = true): void {
  const db = getInboundDb();
  const cols = ['id INTEGER PRIMARY KEY CHECK (id = 1)', 'channel_type TEXT', 'platform_id TEXT', 'thread_id TEXT'];
  if (withSpawnTaskId) cols.push('spawn_task_id TEXT');
  if (withSessionId) cols.push('session_id TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (${cols.join(', ')})`);
}

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('getSessionSpawnTaskId', () => {
  it('test_returns_null_when_no_row', () => {
    createSessionRoutingTable();
    const result = getSessionSpawnTaskId();
    expect(result).toBeNull();
  });

  it('test_returns_value_when_set', () => {
    createSessionRoutingTable();
    getInboundDb()
      .prepare(`INSERT INTO session_routing (id, spawn_task_id) VALUES (1, ?)`)
      .run('spawn-abc123def4567890');
    const result = getSessionSpawnTaskId();
    expect(result).toBe('spawn-abc123def4567890');
  });

  it('test_returns_null_when_column_value_is_null', () => {
    createSessionRoutingTable();
    getInboundDb()
      .prepare(`INSERT INTO session_routing (id, channel_type, spawn_task_id) VALUES (1, 'telegram', NULL)`)
      .run();
    const result = getSessionSpawnTaskId();
    expect(result).toBeNull();
  });

  it('test_returns_null_when_column_missing_legacy', () => {
    // Pre-rework: session_routing has a row but no spawn_task_id column
    createSessionRoutingTable(false, false);
    getInboundDb()
      .prepare(`INSERT INTO session_routing (id, channel_type) VALUES (1, 'slack')`)
      .run();
    const result = getSessionSpawnTaskId();
    expect(result).toBeNull();
  });
});

describe('getSessionId', () => {
  it('test_returns_null_when_no_row', () => {
    createSessionRoutingTable();
    const result = getSessionId();
    expect(result).toBeNull();
  });

  it('test_returns_value_when_set', () => {
    createSessionRoutingTable();
    getInboundDb()
      .prepare(`INSERT INTO session_routing (id, session_id) VALUES (1, ?)`)
      .run('sess-xyz-789');
    const result = getSessionId();
    expect(result).toBe('sess-xyz-789');
  });

  it('test_returns_null_when_column_missing_legacy', () => {
    // Pre-rework: no session_id column
    createSessionRoutingTable(true, false);
    getInboundDb()
      .prepare(`INSERT INTO session_routing (id, channel_type) VALUES (1, 'slack')`)
      .run();
    const result = getSessionId();
    expect(result).toBeNull();
  });
});
