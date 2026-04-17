import { getDb } from '../db.js';

const SKIP_LABELS: ReadonlySet<string> = new Set([
  'newsletter',
  'promotional',
  'bulk',
]);

export interface PrefilterInput {
  superpilotLabel: string | null;
  sender: string;
}

export interface PrefilterResult {
  skip: boolean;
  reason: string;
}

export function shouldSkip(input: PrefilterInput): PrefilterResult {
  if (input.superpilotLabel && SKIP_LABELS.has(input.superpilotLabel)) {
    return { skip: true, reason: `superpilot:${input.superpilotLabel}` };
  }

  const row = getDb()
    .prepare(
      `SELECT promoted_at FROM triage_skip_list
       WHERE pattern = ? AND pattern_type = 'sender_exact' AND promoted_at IS NOT NULL`,
    )
    .get(input.sender.toLowerCase()) as { promoted_at: number } | undefined;
  if (row) return { skip: true, reason: 'skip_list:sender_exact' };

  const domain = input.sender.toLowerCase().split('@')[1];
  if (domain) {
    const drow = getDb()
      .prepare(
        `SELECT promoted_at FROM triage_skip_list
         WHERE pattern = ? AND pattern_type = 'sender_domain' AND promoted_at IS NOT NULL`,
      )
      .get(domain) as { promoted_at: number } | undefined;
    if (drow) return { skip: true, reason: 'skip_list:sender_domain' };
  }

  return { skip: false, reason: 'no_match' };
}

/**
 * Record a user's archive action. After PROMOTION_HITS consistent archives
 * of the same sender, mark pattern as promoted (active skip-list entry).
 */
export function recordSkip(
  sender: string,
  promotionHits: number,
): { promoted: boolean } {
  const pattern = sender.toLowerCase();
  const now = Date.now();
  const db = getDb();

  db.prepare(
    `INSERT INTO triage_skip_list (pattern, pattern_type, hit_count, last_hit_at)
     VALUES (?, 'sender_exact', 1, ?)
     ON CONFLICT(pattern) DO UPDATE SET
       hit_count = hit_count + 1,
       last_hit_at = excluded.last_hit_at`,
  ).run(pattern, now);

  const row = db
    .prepare(
      `SELECT hit_count, promoted_at FROM triage_skip_list WHERE pattern = ?`,
    )
    .get(pattern) as { hit_count: number; promoted_at: number | null };

  if (row.hit_count >= promotionHits && row.promoted_at === null) {
    db.prepare(
      `UPDATE triage_skip_list SET promoted_at = ? WHERE pattern = ?`,
    ).run(now, pattern);
    return { promoted: true };
  }

  return { promoted: false };
}
