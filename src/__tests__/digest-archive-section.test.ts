import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ArchiveTracker } from '../archive-tracker.js';
import { generateArchiveDigestSection } from '../digest-archive-section.js';

describe('generateArchiveDigestSection', () => {
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

  it('returns empty string when no unarchived emails', () => {
    const section = generateArchiveDigestSection(tracker);
    expect(section).toBe('');
  });

  it('generates section with unarchived emails', () => {
    tracker.recordAction('msg_1', 'thread_1', 'personal', 'confirmed');
    tracker.recordAction('msg_2', 'thread_2', 'dev', 'replied');

    const section = generateArchiveDigestSection(tracker);
    expect(section).toContain('INBOX CLEANUP');
    expect(section).toContain('2');
    expect(section).toContain('personal');
    expect(section).toContain('dev');
  });

  it('does not include already archived emails', () => {
    tracker.recordAction('msg_1', 'thread_1', 'personal', 'confirmed');
    tracker.recordAction('msg_2', 'thread_2', 'dev', 'replied');
    tracker.markArchived('msg_1', 'confirmed');

    const section = generateArchiveDigestSection(tracker);
    expect(section).toContain('1');
    expect(section).not.toContain('personal');
    expect(section).toContain('dev');
  });
});
