import { getDb } from '../db.js';

export type ExampleKind = 'positive' | 'negative';

export interface TriageExample {
  kind: ExampleKind;
  trackedItemId: string;
  emailSummary: string;
  agentQueue: string;
  userQueue: string;
  reasons: string[];
}

export function recordExample(ex: TriageExample): void {
  getDb()
    .prepare(
      `INSERT INTO triage_examples
       (kind, tracked_item_id, email_summary, agent_queue, user_queue,
        reasons_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ex.kind,
      ex.trackedItemId,
      ex.emailSummary,
      ex.agentQueue,
      ex.userQueue,
      JSON.stringify(ex.reasons),
      Date.now(),
    );
}

export function getRecentExamples(
  kind: ExampleKind,
  limit: number,
): TriageExample[] {
  const rows = getDb()
    .prepare(
      `SELECT kind, tracked_item_id, email_summary, agent_queue, user_queue,
              reasons_json
       FROM triage_examples
       WHERE kind = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(kind, limit) as Array<{
    kind: ExampleKind;
    tracked_item_id: string;
    email_summary: string;
    agent_queue: string;
    user_queue: string;
    reasons_json: string;
  }>;

  return rows.map((r) => ({
    kind: r.kind,
    trackedItemId: r.tracked_item_id,
    emailSummary: r.email_summary,
    agentQueue: r.agent_queue,
    userQueue: r.user_queue,
    reasons: JSON.parse(r.reasons_json) as string[],
  }));
}
