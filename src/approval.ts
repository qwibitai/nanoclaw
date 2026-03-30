import Database from 'better-sqlite3';
import { logger } from './logger.js';

export interface ApprovalRequest {
  id: string;
  category: string;
  action: string;
  summary: string;
  details: Record<string, unknown>;
  groupFolder: string;
  expiresAt: string;
}

export interface Approval {
  id: string;
  category: string;
  action: string;
  summary: string;
  details: Record<string, unknown>;
  groupFolder: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  expiresAt: string;
  respondedBy: string | null;
  respondedAt: string | null;
  createdAt: string;
}

export class ApprovalStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        expires_at TEXT NOT NULL,
        responded_by TEXT,
        responded_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_approvals_status
      ON pending_approvals(status)
    `);
  }

  create(req: ApprovalRequest): Approval {
    const stmt = this.db.prepare(`
      INSERT INTO pending_approvals (id, category, action, summary, details, group_folder, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(req.id, req.category, req.action, req.summary, JSON.stringify(req.details), req.groupFolder, req.expiresAt);
    logger.debug({ id: req.id, category: req.category }, 'Approval created');
    return this.get(req.id)!;
  }

  get(id: string): Approval | undefined {
    const row = this.db.prepare('SELECT * FROM pending_approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.rowToApproval(row);
  }

  listPending(groupFolder?: string): Approval[] {
    const sql = groupFolder
      ? 'SELECT * FROM pending_approvals WHERE status = ? AND group_folder = ? ORDER BY created_at DESC'
      : 'SELECT * FROM pending_approvals WHERE status = ? ORDER BY created_at DESC';
    const args = groupFolder ? ['pending', groupFolder] : ['pending'];
    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    return rows.map(r => this.rowToApproval(r));
  }

  resolve(id: string, approved: boolean, respondedBy: string): Approval | undefined {
    const stmt = this.db.prepare(`
      UPDATE pending_approvals
      SET status = ?, responded_by = ?, responded_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `);
    const result = stmt.run(approved ? 'approved' : 'rejected', respondedBy, id);
    if (result.changes === 0) return undefined;
    logger.debug({ id, approved, respondedBy }, 'Approval resolved');
    return this.get(id);
  }

  expireStale(): number {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE pending_approvals
      SET status = 'expired'
      WHERE status = 'pending' AND expires_at <= ?
    `);
    const result = stmt.run(now);
    if (result.changes > 0) {
      logger.debug({ count: result.changes }, 'Approvals expired');
    }
    return result.changes;
  }

  private rowToApproval(row: Record<string, unknown>): Approval {
    return {
      id: row.id as string,
      category: row.category as string,
      action: row.action as string,
      summary: row.summary as string,
      details: JSON.parse(row.details as string),
      groupFolder: row.group_folder as string,
      status: row.status as Approval['status'],
      expiresAt: row.expires_at as string,
      respondedBy: row.responded_by as string | null,
      respondedAt: row.responded_at as string | null,
      createdAt: row.created_at as string,
    };
  }
}
