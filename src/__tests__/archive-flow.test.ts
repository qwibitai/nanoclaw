import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ArchiveTracker } from '../archive-tracker.js';

describe('Archive all flow', () => {
  it('archiveTracker.getUnarchived returns unarchived emails', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE acted_emails (
        email_id TEXT PRIMARY KEY, thread_id TEXT, account TEXT,
        action_taken TEXT, acted_at TEXT, archived_at TEXT
      )
    `);
    const tracker = new ArchiveTracker(db);
    tracker.recordAction('e1', 't1', 'personal', 'replied');
    tracker.recordAction('e2', 't2', 'dev', 'delegated');
    tracker.markArchived('e1', 'replied');

    const unarchived = tracker.getUnarchived();
    expect(unarchived).toHaveLength(1);
    expect(unarchived[0].email_id).toBe('e2');
  });

  it('batch archive iterates unarchived and marks each', async () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE acted_emails (
        email_id TEXT PRIMARY KEY, thread_id TEXT, account TEXT,
        action_taken TEXT, acted_at TEXT, archived_at TEXT
      )
    `);
    const tracker = new ArchiveTracker(db);
    tracker.recordAction('e1', 't1', 'personal', 'replied');
    tracker.recordAction('e2', 't2', 'dev', 'delegated');

    const mockArchive = vi.fn().mockResolvedValue(undefined);
    const unarchived = tracker.getUnarchived();
    let archived = 0;
    for (const email of unarchived) {
      await mockArchive(email.account, email.thread_id);
      tracker.markArchived(email.email_id, email.action_taken);
      archived++;
    }

    expect(archived).toBe(2);
    expect(mockArchive).toHaveBeenCalledTimes(2);
    expect(tracker.getUnarchived()).toHaveLength(0);
  });
});
