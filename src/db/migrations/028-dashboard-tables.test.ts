import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migration028 } from './028-dashboard-tables.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL,
      display_name TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO users VALUES ('u1', 'phone', null, '2026-01-01T00:00:00Z');
  `);
  migration028.up(db);
  return db;
}

describe('migration028', () => {
  it('token_hmac UNIQUE rejects duplicate', () => {
    const db = makeDb();
    db.exec(
      `INSERT INTO dashboard_tokens (user_id, token_hmac, issued_at, expires_at) VALUES ('u1', 'hmac1', '2026-01-01', '2026-01-02')`,
    );
    expect(() =>
      db.exec(
        `INSERT INTO dashboard_tokens (user_id, token_hmac, issued_at, expires_at) VALUES ('u1', 'hmac1', '2026-01-01', '2026-01-02')`,
      ),
    ).toThrow();
    db.close();
  });

  it('steer_idempotency UNIQUE(user_id, idempotency_key)', () => {
    const db = makeDb();
    db.exec(
      `INSERT INTO steer_idempotency (user_id, idempotency_key, task_id, message_id, text, reserved_at, request_hash) VALUES ('u1', 'k1', 't1', 'm1', 'hello', '2026-01-01', 'hash1')`,
    );
    expect(() =>
      db.exec(
        `INSERT INTO steer_idempotency (user_id, idempotency_key, task_id, message_id, text, reserved_at, request_hash) VALUES ('u1', 'k1', 't2', 'm2', 'hello2', '2026-01-01', 'hash2')`,
      ),
    ).toThrow();
    db.close();
  });

  it('text column present and NOT NULL', () => {
    const db = makeDb();
    const cols = db.prepare('PRAGMA table_info(steer_idempotency)').all() as { name: string; notnull: number }[];
    const textCol = cols.find((c) => c.name === 'text');
    expect(textCol).toBeDefined();
    expect(textCol!.notnull).toBe(1);
    db.close();
  });

  it('request_hash column present', () => {
    const db = makeDb();
    const cols = (db.prepare('PRAGMA table_info(steer_idempotency)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('request_hash');
    db.close();
  });

  it('echo_attempted column present', () => {
    const db = makeDb();
    const cols = (db.prepare('PRAGMA table_info(steer_idempotency)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('echo_attempted');
    db.close();
  });

  it('no token_hex column', () => {
    const db = makeDb();
    const cols = (db.prepare('PRAGMA table_info(dashboard_tokens)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain('token_hex');
    db.close();
  });
});
