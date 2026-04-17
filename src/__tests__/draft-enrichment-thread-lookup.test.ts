import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { getDraftIdForThread } from '../draft-enrichment.js';

describe('getDraftIdForThread', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`CREATE TABLE draft_originals (
      draft_id TEXT PRIMARY KEY, account TEXT, original_body TEXT,
      enriched_at TEXT, expires_at TEXT, thread_id TEXT
    )`);
  });
  afterEach(() => db.close());

  it('returns the draftId for matching account + threadId', () => {
    db.prepare('INSERT INTO draft_originals VALUES (?, ?, ?, ?, ?, ?)').run(
      'd1',
      'personal',
      'body',
      new Date().toISOString(),
      new Date(Date.now() + 86400000).toISOString(),
      't1',
    );
    expect(getDraftIdForThread(db, 'personal', 't1')).toBe('d1');
  });

  it('returns null when no draft exists for that thread', () => {
    expect(getDraftIdForThread(db, 'personal', 'never')).toBeNull();
  });

  it('scopes by account', () => {
    db.prepare('INSERT INTO draft_originals VALUES (?, ?, ?, ?, ?, ?)').run(
      'd1',
      'personal',
      'body',
      new Date().toISOString(),
      new Date(Date.now() + 86400000).toISOString(),
      't1',
    );
    expect(getDraftIdForThread(db, 'other', 't1')).toBeNull();
  });

  it('returns the most recently enriched draft when multiple exist for same thread', () => {
    const older = new Date(Date.now() - 5000).toISOString();
    const newer = new Date().toISOString();
    db.prepare('INSERT INTO draft_originals VALUES (?, ?, ?, ?, ?, ?)').run(
      'd-old',
      'personal',
      'body',
      older,
      new Date(Date.now() + 86400000).toISOString(),
      't2',
    );
    db.prepare('INSERT INTO draft_originals VALUES (?, ?, ?, ?, ?, ?)').run(
      'd-new',
      'personal',
      'body',
      newer,
      new Date(Date.now() + 86400000).toISOString(),
      't2',
    );
    expect(getDraftIdForThread(db, 'personal', 't2')).toBe('d-new');
  });
});
