import { getDb } from './db.js';

export type ObservedBehavior =
  | 'immediate_action'
  | 'snooze'
  | 'dismiss'
  | 'ignore';
export type AdjustmentType = 'promote' | 'demote' | 'none';

export function recordBehavior(
  source: string,
  senderPattern: string,
  originalClassification: string,
  behavior: ObservedBehavior,
  subjectPattern?: string,
): void {
  const db = getDb();
  const now = Date.now();

  const existing = db
    .prepare(
      `SELECT id, count FROM classification_behaviors
       WHERE source = ? AND sender_pattern = ? AND original_classification = ? AND observed_behavior = ?`,
    )
    .get(source, senderPattern, originalClassification, behavior) as
    | { id: number; count: number }
    | undefined;

  if (existing) {
    db.prepare(
      'UPDATE classification_behaviors SET count = count + 1, updated_at = ? WHERE id = ?',
    ).run(now, existing.id);
  } else {
    db.prepare(
      `INSERT INTO classification_behaviors
       (source, sender_pattern, subject_pattern, original_classification, observed_behavior, count, adjustment, confidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 'none', 0.0, ?, ?)`,
    ).run(
      source,
      senderPattern,
      subjectPattern ?? null,
      originalClassification,
      behavior,
      now,
      now,
    );
  }

  recomputeAdjustment(source, senderPattern);
}

export function getAdjustment(
  source: string,
  senderPattern: string,
  opts?: { minDataPoints?: number },
): AdjustmentType {
  const db = getDb();
  const minPoints = opts?.minDataPoints ?? 3;

  const rows = db
    .prepare(
      `SELECT observed_behavior, SUM(count) as total FROM classification_behaviors
       WHERE source = ? AND sender_pattern = ?
       GROUP BY observed_behavior`,
    )
    .all(source, senderPattern) as Array<{
    observed_behavior: string;
    total: number;
  }>;

  const totalAll = rows.reduce((sum, r) => sum + r.total, 0);
  if (totalAll < minPoints) return 'none';

  const dismissals =
    rows.find((r) => r.observed_behavior === 'dismiss')?.total ?? 0;
  const immediateActions =
    rows.find((r) => r.observed_behavior === 'immediate_action')?.total ?? 0;

  if (dismissals >= 3) return 'demote';
  if (immediateActions >= 3) return 'promote';
  return 'none';
}

function recomputeAdjustment(source: string, senderPattern: string): void {
  const db = getDb();
  const adj = getAdjustment(source, senderPattern);
  const now = Date.now();
  const totalRows = db
    .prepare(
      'SELECT SUM(count) as total FROM classification_behaviors WHERE source = ? AND sender_pattern = ?',
    )
    .get(source, senderPattern) as { total: number };

  const confidence = Math.min(1.0, (totalRows?.total ?? 0) / 20);

  db.prepare(
    `UPDATE classification_behaviors SET adjustment = ?, confidence = ?, updated_at = ?
     WHERE source = ? AND sender_pattern = ?`,
  ).run(adj, confidence, now, source, senderPattern);
}

export function resetAdjustments(): void {
  const db = getDb();
  db.prepare('DELETE FROM classification_behaviors').run();
}
