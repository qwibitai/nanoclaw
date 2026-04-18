import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ArchiveTracker } from '../archive-tracker.js';

describe('ArchiveTracker', () => {
  let db: Database.Database;
  let tracker: ArchiveTracker;

  beforeEach(() => {
    db = new Database(':memory:');
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
    tracker = new ArchiveTracker(db);
  });

  it('records an acted email', () => {
    tracker.recordAction('msg_1', 'thread_1', 'personal', 'confirmed');
    const pending = tracker.getUnarchived();
    expect(pending).toHaveLength(1);
    expect(pending[0].email_id).toBe('msg_1');
  });

  it('marks email as archived', () => {
    tracker.recordAction('msg_1', 'thread_1', 'personal', 'confirmed');
    tracker.markArchived('msg_1', 'confirmed');
    const pending = tracker.getUnarchived();
    expect(pending).toHaveLength(0);
  });

  it('returns only unarchived emails', () => {
    tracker.recordAction('msg_1', 'thread_1', 'personal', 'confirmed');
    tracker.recordAction('msg_2', 'thread_2', 'dev', 'replied');
    tracker.markArchived('msg_1', 'confirmed');

    const pending = tracker.getUnarchived();
    expect(pending).toHaveLength(1);
    expect(pending[0].email_id).toBe('msg_2');
  });
});
