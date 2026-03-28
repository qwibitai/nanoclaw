import { CronExpressionParser } from 'cron-parser';

import { getDb, createTask, getTasksForGroup } from './db.js';
import { CONSOLIDATION_FOLDER } from './consolidation-runner.js';
import { TIMEZONE } from './config.js';
import { logger } from './logger.js';
import { GroupQueue } from './group-queue.js';

export interface CircadianConfig {
  cronExpr: string; // default: '0 3 * * *' (3am daily)
  timezone: string;
  digestTargetJid?: string;
}

/**
 * Schedules the nightly circadian consolidation task.
 * Idempotent: if an active cron task already exists for the consolidation
 * folder, this function returns immediately without creating a duplicate.
 */
export function scheduleCircadianTask(
  config: CircadianConfig,
  queue: GroupQueue,
  sendMessage: (jid: string, text: string) => Promise<void>,
): void {
  const existing = getTasksForGroup(CONSOLIDATION_FOLDER).find(
    (t) => t.schedule_type === 'cron' && t.status === 'active',
  );
  if (existing) {
    logger.debug(
      { taskId: existing.id },
      'Circadian consolidation task already scheduled, skipping',
    );
    return;
  }

  const tz = config.timezone || TIMEZONE;
  const parsedNextRun = CronExpressionParser.parse(config.cronExpr, {
    tz,
  })
    .next()
    .toISOString();

  const now = new Date().toISOString();
  const currentDate = now.split('T')[0];

  createTask({
    id: 'circadian-' + Date.now(),
    group_folder: CONSOLIDATION_FOLDER,
    chat_jid: config.digestTargetJid || '',
    prompt: buildCircadianPrompt([], currentDate),
    schedule_type: 'cron',
    schedule_value: config.cronExpr,
    context_mode: 'isolated',
    next_run: parsedNextRun,
    status: 'active',
    created_at: now,
  });

  logger.info(
    { nextRun: parsedNextRun, cronExpr: config.cronExpr },
    'Circadian consolidation task scheduled',
  );
}

/**
 * Builds the prompt sent to the consolidation agent during the nightly
 * circadian cycle.
 */
export function buildCircadianPrompt(
  groupFolders: string[],
  currentDate: string,
): string {
  return `You are the NanoClaw consolidation agent running the nightly circadian cycle for ${currentDate}.

Your tasks:
1. Review and update CLAUDE.md for each group based on recent conversations
2. Prune stale or contradicted memories
3. Update NARRATIVE.md with recent events
4. Update the semantic concept graph in groups/global/semantic-graph.json
5. Generate a morning digest summarizing key insights and pending items

Groups to process: ${groupFolders.length > 0 ? groupFolders.join(', ') : 'all registered groups'}`;
}

/**
 * Inserts a new consolidation_runs row with status='running' and
 * returns the new row id.
 */
export function recordConsolidationRun(
  jobType: 'circadian' | 'emergence' | 'archaeology',
  groupFolder: string | null,
): number {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO consolidation_runs (run_at, job_type, group_folder, status, started_at)
       VALUES (?, ?, ?, 'running', ?)`,
    )
    .run(now, jobType, groupFolder, now);
  return result.lastInsertRowid as number;
}

/**
 * Updates an existing consolidation_runs row after completion or failure.
 */
export function updateConsolidationRun(
  id: number,
  status: 'success' | 'error',
  resultSummary?: string,
  error?: string,
): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE consolidation_runs
     SET status = ?, completed_at = ?, result_summary = ?, error = ?
     WHERE id = ?`,
  ).run(status, now, resultSummary ?? null, error ?? null, id);
}

/**
 * Returns the most recent consolidation run for the given job type,
 * or undefined if none exists.
 */
export function getLastConsolidationRun(
  jobType: string,
): { run_at: string; status: string } | undefined {
  const db = getDb();
  return db
    .prepare(
      `SELECT run_at, status FROM consolidation_runs
       WHERE job_type = ?
       ORDER BY run_at DESC
       LIMIT 1`,
    )
    .get(jobType) as { run_at: string; status: string } | undefined;
}
