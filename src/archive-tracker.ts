import type Database from 'better-sqlite3';

export interface ActedEmail {
  email_id: string;
  thread_id: string;
  account: string;
  action_taken: string;
  acted_at: string;
  archived_at: string | null;
}

export class ArchiveTracker {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  recordAction(
    emailId: string,
    threadId: string,
    account: string,
    actionTaken: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO acted_emails
         (email_id, thread_id, account, action_taken, acted_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(emailId, threadId, account, actionTaken, new Date().toISOString());
  }

  markArchived(emailId: string, actionTaken: string): void {
    this.db
      .prepare(
        `UPDATE acted_emails SET archived_at = ? WHERE email_id = ? AND action_taken = ?`,
      )
      .run(new Date().toISOString(), emailId, actionTaken);
  }

  getUnarchived(): ActedEmail[] {
    return this.db
      .prepare(
        `SELECT * FROM acted_emails WHERE archived_at IS NULL ORDER BY acted_at DESC`,
      )
      .all() as ActedEmail[];
  }
}
