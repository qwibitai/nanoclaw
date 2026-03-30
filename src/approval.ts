import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { logger } from './logger.js';

export interface ApprovalPolicy {
  defaults: { mode: 'auto' | 'confirm' | 'block' };
  actions: Record<string, { mode: 'auto' | 'confirm' | 'block' }>;
  notifyChannels: string[];
  expiryMinutes: number;
}

const DEFAULT_POLICY: ApprovalPolicy = {
  defaults: { mode: 'confirm' },
  actions: {},
  notifyChannels: [],
  expiryMinutes: 60,
};

export function loadApprovalPolicy(filePath: string): ApprovalPolicy {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      defaults: parsed.defaults ?? DEFAULT_POLICY.defaults,
      actions: parsed.actions ?? {},
      notifyChannels: parsed.notifyChannels ?? [],
      expiryMinutes: parsed.expiryMinutes ?? 60,
    };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export function getActionMode(
  policy: ApprovalPolicy,
  action: string,
): 'auto' | 'confirm' | 'block' {
  return policy.actions[action]?.mode ?? policy.defaults.mode;
}

export function writeApprovalResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: { requestId: string; approved: boolean; respondedBy: string; respondedAt: string },
): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'approval_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const filePath = path.join(resultsDir, `${requestId}.json`);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(result));
  fs.renameSync(tempPath, filePath);
}

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

export function startApprovalExpiryTimer(
  store: ApprovalStore,
  dataDir: string,
  intervalMs = 30_000,
): NodeJS.Timeout {
  return setInterval(() => {
    const expired = store.expireStale();
    if (expired > 0) {
      logger.info({ count: expired }, 'Expired stale approvals');
      // Write expired results so the polling container gets unblocked
      const db = (store as any).db as Database.Database;
      const recentlyExpired = db.prepare(`
        SELECT id, group_folder FROM pending_approvals
        WHERE status = 'expired' AND responded_at IS NULL
      `).all() as { id: string; group_folder: string }[];

      for (const row of recentlyExpired) {
        writeApprovalResult(dataDir, row.group_folder, row.id, {
          requestId: row.id,
          approved: false,
          respondedBy: 'system:expired',
          respondedAt: new Date().toISOString(),
        });
        // Mark as having been notified
        db.prepare(`UPDATE pending_approvals SET responded_at = datetime('now') WHERE id = ?`).run(row.id);
      }
    }
  }, intervalMs);
}
