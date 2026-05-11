import { getDb } from '../../db/connection.js';

export interface SteerResponse {
  task_id: string;
  message_id: string;
  echo_status: string;
}

export interface ReservedSteer {
  id: number;
  messageId: string;
  status: 'pending' | 'applied';
  storedText: string;
  echoAttempted: boolean;
  cached?: SteerResponse;
}

export class IdempotencyConflict extends Error {
  readonly conflictKind: 'task_id' | 'request_hash';
  constructor(kind: 'task_id' | 'request_hash') {
    super(`Idempotency conflict: ${kind} mismatch`);
    this.conflictKind = kind;
  }
}

export function reserveIdempotency(
  userId: string,
  idempotencyKey: string,
  taskId: string,
  messageId: string,
  text: string,
  requestHash: string,
): ReservedSteer {
  const db = getDb();

  const existing = db
    .prepare(
      `SELECT id, message_id, task_id, request_hash, status, echo_attempted, text, cached_response
       FROM steer_idempotency
       WHERE user_id = ? AND idempotency_key = ?`,
    )
    .get(userId, idempotencyKey) as
    | {
        id: number;
        message_id: string;
        task_id: string;
        request_hash: string;
        status: 'pending' | 'applied';
        echo_attempted: number;
        text: string;
        cached_response: string | null;
      }
    | undefined;

  if (existing) {
    if (existing.task_id !== taskId) throw new IdempotencyConflict('task_id');
    if (existing.request_hash !== requestHash) throw new IdempotencyConflict('request_hash');
    const cached =
      existing.status === 'applied' && existing.cached_response
        ? (JSON.parse(existing.cached_response) as SteerResponse)
        : undefined;
    return {
      id: existing.id,
      messageId: existing.message_id,
      status: existing.status,
      storedText: existing.text,
      echoAttempted: existing.echo_attempted === 1,
      cached,
    };
  }

  const row = db
    .prepare(
      `INSERT INTO steer_idempotency
         (user_id, idempotency_key, task_id, message_id, text, request_hash, reserved_at, status, echo_attempted)
       VALUES (@user_id, @idempotency_key, @task_id, @message_id, @text, @request_hash, datetime('now'), 'pending', 0)
       RETURNING id, message_id, status, echo_attempted, text`,
    )
    .get({
      user_id: userId,
      idempotency_key: idempotencyKey,
      task_id: taskId,
      message_id: messageId,
      text,
      request_hash: requestHash,
    }) as { id: number; message_id: string; status: 'pending'; echo_attempted: number; text: string };

  return {
    id: row.id,
    messageId: row.message_id,
    status: row.status,
    storedText: row.text,
    echoAttempted: row.echo_attempted === 1,
  };
}

export function applyIdempotency(userId: string, idempotencyKey: string, response: SteerResponse): void {
  getDb()
    .prepare(
      `UPDATE steer_idempotency
       SET status = 'applied', applied_at = datetime('now'), cached_response = @cached_response
       WHERE user_id = @user_id AND idempotency_key = @idempotency_key AND status != 'applied'`,
    )
    .run({
      user_id: userId,
      idempotency_key: idempotencyKey,
      cached_response: JSON.stringify(response),
    });
}

export function markEchoAttempted(idempotencyRowId: number): void {
  getDb().prepare('UPDATE steer_idempotency SET echo_attempted = 1 WHERE id = ?').run(idempotencyRowId);
}

/**
 * Atomically claim the echo-attempt slot — sets `echo_attempted = 1` if and only
 * if it was currently 0. Returns true iff this call won the race.
 *
 * Use this in lieu of the read-then-write check `if (!reserved.echoAttempted) ...
 * markEchoAttempted(...)` to prevent the echo-duplication race where two concurrent
 * retries of the same idempotency_key both see echo_attempted=0 at reservation
 * time and both schedule adapter.deliver, resulting in duplicate Slack/Discord
 * messages. Post-build QA fix SF-1.
 */
export function claimEchoAttempted(idempotencyRowId: number): boolean {
  const result = getDb()
    .prepare('UPDATE steer_idempotency SET echo_attempted = 1 WHERE id = ? AND echo_attempted = 0')
    .run(idempotencyRowId);
  return result.changes > 0;
}
