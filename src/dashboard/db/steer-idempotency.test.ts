import { afterEach, beforeEach, describe, it, expect } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { IdempotencyConflict, applyIdempotency, markEchoAttempted, reserveIdempotency } from './steer-idempotency.js';
import type { SteerResponse } from './steer-idempotency.js';

function now(): string {
  return new Date().toISOString();
}

function seedUser(id: string): void {
  getDb().prepare("INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'test', NULL, ?)").run(id, now());
}

beforeEach(() => {
  // Reset column-check flag between tests so ensureColumn runs fresh each time
  // (the module-level flag persists across tests in the same process)
  const db = initTestDb();
  runMigrations(db);
  seedUser('u1');
});

afterEach(() => {
  closeDb();
});

function makeResponse(taskId = 'spawn-abc', messageId = 'msg-1'): SteerResponse {
  return { task_id: taskId, message_id: messageId, echo_status: 'pending' };
}

describe('steer_idempotency DAO', () => {
  it('test_reserve_fresh', () => {
    const result = reserveIdempotency('u1', 'key-1', 'spawn-abc', 'msg-1', 'hello', 'hash-h');
    expect(result.messageId).toBe('msg-1');
    expect(result.status).toBe('pending');
    expect(result.echoAttempted).toBe(false);
    expect(result.storedText).toBe('hello');
  });

  it('test_reserve_replay_same_payload', () => {
    reserveIdempotency('u1', 'key-1', 'spawn-abc', 'msg-1', 'hello', 'hash-h');
    const replay = reserveIdempotency('u1', 'key-1', 'spawn-abc', 'msg-2', 'hello', 'hash-h');
    expect(replay.messageId).toBe('msg-1');
  });

  it('test_reserve_task_id_conflict', () => {
    reserveIdempotency('u1', 'key-1', 'spawn-abc', 'msg-1', 'hello', 'hash-h');
    expect(() => reserveIdempotency('u1', 'key-1', 'spawn-OTHER', 'msg-2', 'hello', 'hash-h')).toThrow(
      IdempotencyConflict,
    );
    try {
      reserveIdempotency('u1', 'key-1', 'spawn-OTHER', 'msg-2', 'hello', 'hash-h');
    } catch (e) {
      expect(e).toBeInstanceOf(IdempotencyConflict);
      expect((e as IdempotencyConflict).conflictKind).toBe('task_id');
    }
  });

  it('test_reserve_request_hash_conflict', () => {
    reserveIdempotency('u1', 'key-1', 'spawn-abc', 'msg-1', 'hello', 'hash-h');
    try {
      reserveIdempotency('u1', 'key-1', 'spawn-abc', 'msg-2', 'goodbye', 'hash-OTHER');
    } catch (e) {
      expect(e).toBeInstanceOf(IdempotencyConflict);
      expect((e as IdempotencyConflict).conflictKind).toBe('request_hash');
    }
  });

  it('test_apply_advances_status', () => {
    reserveIdempotency('u1', 'key-1', 'spawn-abc', 'msg-1', 'hello', 'hash-h');
    applyIdempotency('u1', 'key-1', makeResponse());

    const row = getDb()
      .prepare(
        "SELECT status, applied_at, cached_response FROM steer_idempotency WHERE user_id = 'u1' AND idempotency_key = 'key-1'",
      )
      .get() as { status: string; applied_at: string | null; cached_response: string | null } | undefined;

    expect(row?.status).toBe('applied');
    expect(row?.applied_at).not.toBeNull();
    expect(row?.cached_response).not.toBeNull();
  });

  it('test_apply_idempotent', () => {
    reserveIdempotency('u1', 'key-1', 'spawn-abc', 'msg-1', 'hello', 'hash-h');
    applyIdempotency('u1', 'key-1', makeResponse());
    expect(() => applyIdempotency('u1', 'key-1', makeResponse())).not.toThrow();

    const row = getDb()
      .prepare("SELECT status FROM steer_idempotency WHERE user_id = 'u1' AND idempotency_key = 'key-1'")
      .get() as { status: string } | undefined;
    expect(row?.status).toBe('applied');
  });

  it('test_markEchoAttempted_sets_flag', () => {
    const reserved = reserveIdempotency('u1', 'key-1', 'spawn-abc', 'msg-1', 'hello', 'hash-h');
    markEchoAttempted(reserved.id);

    const row = getDb().prepare('SELECT echo_attempted FROM steer_idempotency WHERE id = ?').get(reserved.id) as
      | { echo_attempted: number }
      | undefined;
    expect(row?.echo_attempted).toBe(1);
  });
});
