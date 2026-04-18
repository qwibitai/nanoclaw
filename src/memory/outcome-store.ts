/**
 * Outcome Store — Track action outcomes for learning and cost analysis.
 *
 * Stores outcomes in a dedicated `outcomes` table (separate from trust_actions).
 * Enables success rate tracking per action class and cost aggregation.
 */

import { getDb } from '../db.js';
import { logger } from '../logger.js';

export interface Outcome {
  id: number;
  action_class: string;
  description: string;
  method: string;
  result: 'success' | 'failure' | 'partial';
  error: string | null;
  user_feedback: string | null;
  duration_ms: number;
  cost_usd: number | null;
  group_id: string;
  created_at: string;
}

export interface LogOutcomeInput {
  actionClass: string;
  description: string;
  method: string;
  result: 'success' | 'failure' | 'partial';
  error?: string;
  userFeedback?: string;
  durationMs: number;
  costUsd?: number;
  groupId: string;
}

export interface QueryOutcomesOpts {
  actionClass?: string;
  groupId?: string;
  since?: number;
  limit?: number;
}

export interface SuccessRate {
  total: number;
  successes: number;
  rate: number;
}

/**
 * Initialize the outcomes table.
 * Called once during DB setup. Safe to call multiple times.
 */
export function initOutcomeStore(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_class TEXT NOT NULL,
      description TEXT NOT NULL,
      method TEXT NOT NULL,
      result TEXT NOT NULL,
      error TEXT,
      user_feedback TEXT,
      duration_ms INTEGER NOT NULL,
      cost_usd REAL,
      group_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_outcomes_class ON outcomes(action_class, group_id);
    CREATE INDEX IF NOT EXISTS idx_outcomes_time ON outcomes(created_at);
  `);
}

/**
 * Log an action outcome.
 */
export function logOutcome(input: LogOutcomeInput): number {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db
    .prepare(
      `INSERT INTO outcomes (action_class, description, method, result, error, user_feedback, duration_ms, cost_usd, group_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.actionClass,
      input.description,
      input.method,
      input.result,
      input.error || null,
      input.userFeedback || null,
      input.durationMs,
      input.costUsd ?? null,
      input.groupId,
      now,
    );

  logger.debug(
    {
      id: result.lastInsertRowid,
      actionClass: input.actionClass,
      result: input.result,
    },
    'Logged outcome',
  );

  return Number(result.lastInsertRowid);
}

/**
 * Query outcomes with optional filters.
 */
export function queryOutcomes(opts: QueryOutcomesOpts): Outcome[] {
  const db = getDb();
  const limit = opts.limit ?? 50;

  let sql = `SELECT * FROM outcomes WHERE 1=1`;
  const params: (string | number)[] = [];

  if (opts.actionClass) {
    sql += ' AND action_class = ?';
    params.push(opts.actionClass);
  }
  if (opts.groupId) {
    sql += ' AND group_id = ?';
    params.push(opts.groupId);
  }
  if (opts.since) {
    sql += ' AND created_at >= ?';
    params.push(new Date(opts.since).toISOString());
  }

  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  return db.prepare(sql).all(...params) as Outcome[];
}

/**
 * Get success rate for a given action class.
 */
export function getSuccessRate(
  actionClass: string,
  groupId?: string,
): SuccessRate {
  const db = getDb();

  let sql = `SELECT
    COUNT(*) as total,
    COALESCE(SUM(CASE WHEN result = 'success' THEN 1 ELSE 0 END), 0) as successes
    FROM outcomes WHERE action_class = ?`;
  const params: string[] = [actionClass];

  if (groupId) {
    sql += ' AND group_id = ?';
    params.push(groupId);
  }

  const row = db.prepare(sql).get(...params) as {
    total: number;
    successes: number;
  };

  return {
    total: row.total,
    successes: row.successes,
    rate: row.total > 0 ? row.successes / row.total : 0,
  };
}

/**
 * Get total cost over a period, optionally filtered by group.
 */
export function getTotalCost(opts?: {
  since?: number;
  groupId?: string;
}): number {
  const db = getDb();

  let sql = `SELECT COALESCE(SUM(cost_usd), 0) as total FROM outcomes WHERE 1=1`;
  const params: string[] = [];

  if (opts?.since) {
    sql += ' AND created_at >= ?';
    params.push(new Date(opts.since).toISOString());
  }
  if (opts?.groupId) {
    sql += ' AND group_id = ?';
    params.push(opts.groupId);
  }

  const row = db.prepare(sql).get(...params) as { total: number };
  return row.total;
}
