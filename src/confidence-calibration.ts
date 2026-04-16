import { getDb } from './db.js';
import { logger } from './logger.js';

export interface CalibrationBucket {
  total: number;
  correct: number;
  accuracy: number;
}

export interface CalibrationStats {
  verified: CalibrationBucket;
  unverified: CalibrationBucket;
  unknown: CalibrationBucket;
}

export function recordConfidenceOutcome(
  actionId: string,
  confidenceLevel: 'verified' | 'unverified' | 'unknown',
  wasCorrect: boolean,
): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO trust_actions (action_class, domain, operation, description, decision, group_id, timestamp, confidence_level, was_correct)
     VALUES ('calibration', 'verify', 'check', @actionId, 'auto', 'system', @timestamp, @confidenceLevel, @wasCorrect)`,
  ).run({
    actionId,
    timestamp: new Date().toISOString(),
    confidenceLevel,
    wasCorrect: wasCorrect ? 1 : 0,
  });
}

export function getCalibrationStats(): CalibrationStats {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT confidence_level, COUNT(*) as total, SUM(was_correct) as correct
       FROM trust_actions WHERE confidence_level IS NOT NULL
       GROUP BY confidence_level`,
    )
    .all() as { confidence_level: string; total: number; correct: number }[];

  const buckets: Record<string, CalibrationBucket> = {
    verified: { total: 0, correct: 0, accuracy: 0 },
    unverified: { total: 0, correct: 0, accuracy: 0 },
    unknown: { total: 0, correct: 0, accuracy: 0 },
  };

  for (const row of rows) {
    const key = row.confidence_level;
    if (buckets[key]) {
      buckets[key].total = row.total;
      buckets[key].correct = row.correct ?? 0;
      buckets[key].accuracy = row.total > 0 ? buckets[key].correct / row.total : 0;
    }
  }

  logger.debug({ stats: buckets }, 'Confidence calibration stats computed');

  return buckets as CalibrationStats;
}
