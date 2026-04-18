import { randomUUID } from 'crypto';

import { getDb } from '../db.js';
import { logger } from '../logger.js';

export interface LearnedRule {
  id: string;
  rule: string;
  source: 'outcome_pattern' | 'user_feedback' | 'agent_reported';
  actionClasses: string[];
  groupId: string | null;
  confidence: number;
  evidenceCount: number;
  createdAt: string;
  lastMatchedAt: string;
}

export type AddRuleInput = Omit<
  LearnedRule,
  'id' | 'createdAt' | 'lastMatchedAt'
>;

interface RuleRow {
  id: string;
  rule: string;
  source: string;
  action_classes: string;
  group_id: string | null;
  confidence: number;
  evidence_count: number;
  created_at: string;
  last_matched_at: string;
}

function rowToRule(row: RuleRow): LearnedRule {
  return {
    id: row.id,
    rule: row.rule,
    source: row.source as LearnedRule['source'],
    actionClasses: JSON.parse(row.action_classes) as string[],
    groupId: row.group_id,
    confidence: row.confidence,
    evidenceCount: row.evidence_count,
    createdAt: row.created_at,
    lastMatchedAt: row.last_matched_at,
  };
}

export function initRulesStore(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS learned_rules (
      id TEXT PRIMARY KEY,
      rule TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('outcome_pattern', 'user_feedback', 'agent_reported')),
      action_classes TEXT NOT NULL,
      group_id TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      evidence_count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_matched_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS learned_rules_fts USING fts5(
      rule,
      action_classes,
      content=learned_rules,
      content_rowid=rowid
    );
    CREATE TRIGGER IF NOT EXISTS learned_rules_fts_insert
      AFTER INSERT ON learned_rules BEGIN
        INSERT INTO learned_rules_fts(rowid, rule, action_classes)
        VALUES (new.rowid, new.rule, new.action_classes);
      END;
    CREATE TRIGGER IF NOT EXISTS learned_rules_fts_delete
      AFTER DELETE ON learned_rules BEGIN
        INSERT INTO learned_rules_fts(learned_rules_fts, rowid, rule, action_classes)
        VALUES ('delete', old.rowid, old.rule, old.action_classes);
      END;
  `);
  logger.debug('Rules store initialized');
}

export function addRule(input: AddRuleInput): string {
  const db = getDb();
  const id = randomUUID();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO learned_rules (id, rule, source, action_classes, group_id, confidence, evidence_count, created_at, last_matched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.rule,
    input.source,
    JSON.stringify(input.actionClasses),
    input.groupId,
    input.confidence,
    input.evidenceCount,
    now,
    now,
  );

  logger.debug(
    { id, source: input.source, groupId: input.groupId },
    'Rule added',
  );
  return id;
}

export function queryRules(
  actionClasses: string[],
  groupId: string,
  limit = 5,
): LearnedRule[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const classFilter = actionClasses
    .map(() => 'action_classes LIKE ?')
    .join(' OR ');
  const sql = classFilter
    ? `SELECT * FROM learned_rules
       WHERE (group_id = ? OR group_id IS NULL)
         AND (${classFilter})
         AND (last_matched_at >= ? OR created_at >= ?)
       ORDER BY confidence DESC LIMIT ?`
    : `SELECT * FROM learned_rules
       WHERE (group_id = ? OR group_id IS NULL)
         AND (last_matched_at >= ? OR created_at >= ?)
       ORDER BY confidence DESC LIMIT ?`;

  const params: (string | number)[] = [groupId];
  if (classFilter) {
    for (const cls of actionClasses) params.push(`%${cls}%`);
  }
  params.push(cutoff, cutoff, limit);

  const rows = db.prepare(sql).all(...params) as RuleRow[];
  return rows.map(rowToRule);
}

export function markMatched(ruleId: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE learned_rules SET last_matched_at = ? WHERE id = ?`).run(
    now,
    ruleId,
  );
}

export function pruneStaleRules(): number {
  const db = getDb();
  const result = db
    .prepare(`DELETE FROM learned_rules WHERE confidence < 0.1`)
    .run();
  const count = result.changes;
  if (count > 0) logger.info({ count }, 'Pruned stale rules');
  return count;
}

export function deleteRule(id: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM learned_rules WHERE id = ?`).run(id);
}

export function decayConfidence(): number {
  const db = getDb();
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const result = db
    .prepare(
      `UPDATE learned_rules
       SET confidence = MAX(0.0, confidence - 0.1)
       WHERE last_matched_at < ?`,
    )
    .run(cutoff);
  return result.changes;
}
