import { getDb } from './db.js';
import { logger } from './logger.js';

export interface DebtItem {
  id: string;
  group_folder: string;
  chat_jid: string;
  description: string;
  created_at: string;
  resolved_at: string | null;
  score: number;
  last_escalated_at: string | null;
  escalation_count: number;
  source_message_id: string | null;
}

export function addDebt(
  item: Omit<DebtItem, 'score' | 'escalation_count' | 'last_escalated_at'>,
): void {
  const db = getDb();
  const id =
    item.id || 'debt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  db.prepare(
    `INSERT INTO temporal_debt
      (id, group_folder, chat_jid, description, created_at, resolved_at, score, last_escalated_at, escalation_count, source_message_id)
     VALUES (?, ?, ?, ?, ?, ?, 1.0, NULL, 0, ?)`,
  ).run(
    id,
    item.group_folder,
    item.chat_jid,
    item.description,
    item.created_at,
    item.resolved_at ?? null,
    item.source_message_id ?? null,
  );
}

export function resolveDebt(id: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(`UPDATE temporal_debt SET resolved_at = ? WHERE id = ?`).run(now, id);
}

export function getUnresolvedDebt(groupFolder: string): DebtItem[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM temporal_debt
       WHERE group_folder = ? AND resolved_at IS NULL
       ORDER BY score DESC`,
    )
    .all(groupFolder) as DebtItem[];
}

export function computeDebtScore(
  item: Pick<DebtItem, 'created_at' | 'escalation_count'>,
  now?: Date,
): number {
  const reference = now ?? new Date();
  const ageInDays =
    (reference.getTime() - new Date(item.created_at).getTime()) /
    (1000 * 60 * 60 * 24);
  const score = ageInDays * Math.pow(1.5, item.escalation_count);
  return Math.min(100, Math.max(0, score));
}

export function updateDebtScores(): void {
  const db = getDb();
  const allUnresolved = db
    .prepare(`SELECT * FROM temporal_debt WHERE resolved_at IS NULL`)
    .all() as DebtItem[];
  const update = db.prepare(
    `UPDATE temporal_debt SET score = ? WHERE id = ?`,
  );
  for (const item of allUnresolved) {
    const score = computeDebtScore(item);
    update.run(score, item.id);
  }
}

export function getHighDebtItems(threshold: number, limit?: number): DebtItem[] {
  const db = getDb();
  if (limit !== undefined) {
    return db
      .prepare(
        `SELECT * FROM temporal_debt
         WHERE resolved_at IS NULL AND score >= ?
         ORDER BY score DESC
         LIMIT ?`,
      )
      .all(threshold, limit) as DebtItem[];
  }
  return db
    .prepare(
      `SELECT * FROM temporal_debt
       WHERE resolved_at IS NULL AND score >= ?
       ORDER BY score DESC`,
    )
    .all(threshold) as DebtItem[];
}

let debtMonitorRunning = false;

export function startDebtMonitorLoop(
  sendMessage: (jid: string, text: string) => Promise<void>,
  options?: { pollIntervalMs?: number; escalationThreshold?: number },
): void {
  if (debtMonitorRunning) {
    logger.debug('Debt monitor loop already running, skipping duplicate start');
    return;
  }
  debtMonitorRunning = true;

  const pollIntervalMs = options?.pollIntervalMs ?? 3600000;
  const escalationThreshold = options?.escalationThreshold ?? 30;

  const loop = async () => {
    try {
      updateDebtScores();
      const highDebtItems = getHighDebtItems(escalationThreshold);
      const now = new Date();
      const db = getDb();
      const update = db.prepare(
        `UPDATE temporal_debt
         SET escalation_count = escalation_count + 1, last_escalated_at = ?
         WHERE id = ?`,
      );

      for (const item of highDebtItems) {
        const lastEscalated = item.last_escalated_at
          ? new Date(item.last_escalated_at).getTime()
          : null;
        const twentyFourHoursMs = 24 * 60 * 60 * 1000;
        const readyToEscalate =
          lastEscalated === null ||
          now.getTime() - lastEscalated >= twentyFourHoursMs;

        if (item.score >= escalationThreshold && readyToEscalate) {
          await sendMessage(
            item.chat_jid,
            `⚠️ Unresolved item: "${item.description}" (urgency: ${Math.round(item.score)})`,
          );
          update.run(now.toISOString(), item.id);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in debt monitor loop');
    }

    setTimeout(loop, pollIntervalMs);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetDebtMonitorForTests(): void {
  debtMonitorRunning = false;
}
