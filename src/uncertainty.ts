import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from './config.js';
import { createTask, getDb } from './db.js';
import { logger } from './logger.js';

export type UncertaintySource =
  | 'ambiguous_query'
  | 'missing_context'
  | 'conflicting_info'
  | 'novel_domain'
  | 'other';

export interface UncertaintyLog {
  id: number;
  group_folder: string;
  chat_jid: string;
  response_summary: string;
  confidence: number;
  uncertainty_source: UncertaintySource;
  uncertainty_detail: string | null;
  logged_at: string;
}

/**
 * Logs an uncertainty entry to the database.
 * Throws if confidence is outside [0, 1].
 */
export function logUncertainty(
  entry: Omit<UncertaintyLog, 'id' | 'logged_at'>,
): void {
  if (entry.confidence < 0 || entry.confidence > 1) {
    throw new Error(
      `confidence must be in [0, 1], got ${entry.confidence}`,
    );
  }

  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO uncertainty_logs (group_folder, chat_jid, response_summary, confidence, uncertainty_source, uncertainty_detail, logged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.group_folder,
      entry.chat_jid,
      entry.response_summary,
      entry.confidence,
      entry.uncertainty_source,
      entry.uncertainty_detail ?? null,
      now,
    );
}

/**
 * Retrieves uncertainty logs for a group folder, with optional since/limit filters.
 */
export function getUncertaintyLogs(
  groupFolder: string,
  options?: { since?: string; limit?: number },
): UncertaintyLog[] {
  let sql =
    'SELECT * FROM uncertainty_logs WHERE group_folder = ?';
  const params: unknown[] = [groupFolder];

  if (options?.since) {
    sql += ' AND logged_at > ?';
    params.push(options.since);
  }

  sql += ' ORDER BY logged_at DESC';

  if (options?.limit !== undefined) {
    sql += ` LIMIT ${options.limit}`;
  }

  return getDb().prepare(sql).all(...params) as UncertaintyLog[];
}

/**
 * Builds a human-readable uncertainty pattern report from a set of logs.
 */
export function buildUncertaintyPatternReport(
  logs: UncertaintyLog[],
): string {
  if (logs.length === 0) {
    return 'No uncertainty data available for this period.';
  }

  const avgConfidence =
    logs.reduce((sum, l) => sum + l.confidence, 0) / logs.length;

  // Find most common uncertainty source
  const sourceCounts: Record<string, number> = {};
  for (const log of logs) {
    sourceCounts[log.uncertainty_source] =
      (sourceCounts[log.uncertainty_source] ?? 0) + 1;
  }
  const mostCommonSource = Object.entries(sourceCounts).sort(
    (a, b) => b[1] - a[1],
  )[0][0];

  const lowConfidenceCount = logs.filter((l) => l.confidence < 0.5).length;

  return (
    `Uncertainty Report:\n` +
    `- Average confidence: ${avgConfidence.toFixed(2)}\n` +
    `- Most common uncertainty source: ${mostCommonSource}\n` +
    `- Total low-confidence responses: ${lowConfidenceCount} (confidence < 0.5)`
  );
}

/**
 * Schedules a weekly uncertainty report task. Idempotent.
 */
export function scheduleUncertaintyReport(
  mainGroupJid: string,
  sendMessage: (jid: string, text: string) => Promise<void>,
): void {
  const existing = getDb()
    .prepare('SELECT id FROM scheduled_tasks WHERE id = ?')
    .get('uncertainty-weekly');
  if (existing) {
    logger.debug(
      { taskId: 'uncertainty-weekly' },
      'Uncertainty report task already scheduled, skipping',
    );
    return;
  }

  const cronExpr = '0 6 * * 1';
  const nextRun = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE })
    .next()
    .toISOString();

  const now = new Date().toISOString();

  createTask({
    id: 'uncertainty-weekly',
    group_folder: 'consolidation',
    chat_jid: mainGroupJid,
    prompt:
      'Generate a weekly uncertainty report summarizing low-confidence responses and patterns.',
    schedule_type: 'cron',
    schedule_value: cronExpr,
    context_mode: 'isolated',
    next_run: nextRun,
    status: 'active',
    created_at: now,
  });

  logger.info(
    { nextRun, cronExpr, mainGroupJid },
    'Uncertainty weekly report task scheduled',
  );
}
