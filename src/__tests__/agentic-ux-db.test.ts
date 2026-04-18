import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

describe('Agentic UX DB tables', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');

    db.exec(`
      CREATE TABLE IF NOT EXISTS task_detail_state (
        task_id TEXT PRIMARY KEY,
        group_jid TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        title TEXT NOT NULL,
        steps_json TEXT NOT NULL DEFAULT '[]',
        log_json TEXT NOT NULL DEFAULT '[]',
        findings_json TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS acted_emails (
        email_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        account TEXT NOT NULL,
        action_taken TEXT NOT NULL,
        acted_at TEXT NOT NULL,
        archived_at TEXT,
        PRIMARY KEY (email_id, action_taken)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS draft_originals (
        draft_id TEXT PRIMARY KEY,
        account TEXT NOT NULL,
        original_body TEXT NOT NULL,
        enriched_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `);
  });

  it('inserts and queries task_detail_state', () => {
    db.prepare(
      'INSERT INTO task_detail_state (task_id, group_jid, title, steps_json, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      't1',
      'tg:123',
      'Spamhaus Investigation',
      '[]',
      new Date().toISOString(),
      new Date().toISOString(),
    );

    const row = db
      .prepare('SELECT * FROM task_detail_state WHERE task_id = ?')
      .get('t1') as Record<string, unknown>;
    expect(row.title).toBe('Spamhaus Investigation');
    expect(row.status).toBe('active');
  });

  it('inserts and queries acted_emails', () => {
    db.prepare(
      'INSERT INTO acted_emails (email_id, thread_id, account, action_taken, acted_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'msg_1',
      'thread_1',
      'personal',
      'confirmed',
      new Date().toISOString(),
    );

    const rows = db
      .prepare('SELECT * FROM acted_emails WHERE archived_at IS NULL')
      .all();
    expect(rows).toHaveLength(1);
  });

  it('inserts and queries draft_originals', () => {
    const now = new Date();
    const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    db.prepare(
      'INSERT INTO draft_originals (draft_id, account, original_body, enriched_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      'd1',
      'dev',
      'original text',
      now.toISOString(),
      expires.toISOString(),
    );

    const row = db
      .prepare('SELECT * FROM draft_originals WHERE draft_id = ?')
      .get('d1') as Record<string, unknown>;
    expect(row.original_body).toBe('original text');
  });
});
