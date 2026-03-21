import type Database from 'better-sqlite3';

export interface TrustDecision {
  eventType: string;
  eventSource: string;
  routing: string;
  trustRuleId: string | null;
  classificationSummary: string;
  classificationImportance: number;
  classificationUrgency: string;
}

export interface ApprovalStat {
  trustRuleId: string;
  eventType: string;
  total: number;
  approved: number;
  rate: number;
}

export interface DecisionRow {
  id: number;
  timestamp: string;
  event_type: string;
  event_source: string;
  routing: string;
  trust_rule_id: string | null;
  classification_summary: string | null;
  classification_importance: number | null;
  classification_urgency: string | null;
  user_response: string | null;
  user_feedback: string | null;
  responded_at: string | null;
  telegram_msg_id: string | null;
}

export class ApprovalTracker {
  private db: InstanceType<typeof Database>;

  constructor(db: InstanceType<typeof Database>) {
    this.db = db;
  }

  /**
   * Insert a new trust decision record and return its row ID.
   */
  recordDecision(decision: TrustDecision): number {
    const stmt = this.db.prepare(`
      INSERT INTO trust_decisions (
        timestamp,
        event_type,
        event_source,
        routing,
        trust_rule_id,
        classification_summary,
        classification_importance,
        classification_urgency
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      new Date().toISOString(),
      decision.eventType,
      decision.eventSource,
      decision.routing,
      decision.trustRuleId ?? null,
      decision.classificationSummary,
      decision.classificationImportance,
      decision.classificationUrgency,
    );
    return result.lastInsertRowid as number;
  }

  /**
   * Record a user response (approved/rejected/edited) for a pending decision.
   */
  recordResponse(
    decisionId: number,
    response: string,
    feedback?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE trust_decisions
         SET user_response = ?, user_feedback = ?, responded_at = ?
         WHERE id = ?`,
      )
      .run(response, feedback ?? null, new Date().toISOString(), decisionId);
  }

  /**
   * Aggregate approval stats grouped by trust_rule_id + event_type.
   * Only counts decisions with user_response IN ('approved','rejected','edited').
   * Excludes NULL (pending) and 'expired' responses from the denominator.
   */
  getApprovalStats(windowDays: number): ApprovalStat[] {
    const cutoff = new Date(
      Date.now() - windowDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const rows = this.db
      .prepare(
        `SELECT
           trust_rule_id,
           event_type,
           COUNT(*) as total,
           SUM(CASE WHEN user_response = 'approved' THEN 1 ELSE 0 END) as approved
         FROM trust_decisions
         WHERE timestamp >= ?
           AND user_response IN ('approved', 'rejected', 'edited')
         GROUP BY trust_rule_id, event_type`,
      )
      .all(cutoff) as Array<{
      trust_rule_id: string | null;
      event_type: string;
      total: number;
      approved: number;
    }>;

    return rows.map((row) => ({
      trustRuleId: row.trust_rule_id ?? '',
      eventType: row.event_type,
      total: row.total,
      approved: row.approved,
      rate: row.total > 0 ? row.approved / row.total : 0,
    }));
  }

  /**
   * Return the most recent N decisions ordered by id DESC.
   */
  getRecentDecisions(limit: number): DecisionRow[] {
    return this.db
      .prepare(`SELECT * FROM trust_decisions ORDER BY id DESC LIMIT ?`)
      .all(limit) as DecisionRow[];
  }

  /**
   * Return all decisions with routing='draft' and no user response yet.
   */
  getPendingApprovals(): DecisionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM trust_decisions
         WHERE routing = 'draft' AND user_response IS NULL
         ORDER BY id ASC`,
      )
      .all() as DecisionRow[];
  }

  /**
   * Expire all stale pending draft decisions older than maxAgeHours.
   * Returns the number of rows updated.
   */
  expireStaleApprovals(maxAgeHours: number): number {
    const cutoff = new Date(
      Date.now() - maxAgeHours * 60 * 60 * 1000,
    ).toISOString();
    const result = this.db
      .prepare(
        `UPDATE trust_decisions
         SET user_response = 'expired'
         WHERE routing = 'draft'
           AND user_response IS NULL
           AND timestamp < ?`,
      )
      .run(cutoff);
    return result.changes;
  }

  /**
   * Attach a Telegram message ID to an existing decision.
   */
  setTelegramMsgId(decisionId: number, telegramMsgId: string): void {
    this.db
      .prepare(`UPDATE trust_decisions SET telegram_msg_id = ? WHERE id = ?`)
      .run(telegramMsgId, decisionId);
  }

  /**
   * Find a decision by its Telegram message ID.
   */
  findByTelegramMsgId(telegramMsgId: string): DecisionRow | undefined {
    return this.db
      .prepare(`SELECT * FROM trust_decisions WHERE telegram_msg_id = ?`)
      .get(telegramMsgId) as DecisionRow | undefined;
  }
}
