import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from './config.js';
import { createTask, getDb, getTasksForGroup } from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';

export interface EmergenceReport {
  id: number;
  generated_at: string;
  pattern_summary: string;
  groups_analyzed: string[];
  delivered: boolean;
}

/**
 * Builds a prompt instructing the synthesis agent to find cross-group patterns.
 */
export function buildEmergencePrompt(
  groupSummaries: Record<string, string>,
): string {
  const keys = Object.keys(groupSummaries);
  if (keys.length === 0) {
    return 'Analyze patterns across groups. No groups provided.';
  }

  const sections = keys
    .map((folder) => `Group: ${folder}\nSummary: ${groupSummaries[folder]}`)
    .join('\n\n');

  return `You are a synthesis agent. Analyze the following group summaries and identify cross-group patterns, recurring themes, and emergent insights.\n\n${sections}\n\nProvide a concise pattern summary highlighting what appears across multiple groups.`;
}

/**
 * Schedules the weekly emergence task. Idempotent.
 */
export function scheduleEmergenceTask(
  mainGroupJid: string,
  queue: GroupQueue,
  sendMessage: (jid: string, text: string) => Promise<void>,
): void {
  const existing = getDb()
    .prepare('SELECT id FROM scheduled_tasks WHERE id = ?')
    .get('emergence-weekly');
  if (existing) {
    logger.debug(
      { taskId: 'emergence-weekly' },
      'Emergence task already scheduled, skipping',
    );
    return;
  }

  const cronExpr = '0 5 * * 0';
  const nextRun = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE })
    .next()
    .toISOString();

  const now = new Date().toISOString();

  createTask({
    id: 'emergence-weekly',
    group_folder: 'consolidation',
    chat_jid: mainGroupJid,
    prompt:
      'Generate a cross-group emergence report identifying patterns and themes across all active groups.',
    schedule_type: 'cron',
    schedule_value: cronExpr,
    context_mode: 'isolated',
    next_run: nextRun,
    status: 'active',
    created_at: now,
  });

  logger.info(
    { nextRun, cronExpr, mainGroupJid },
    'Emergence weekly task scheduled',
  );
}

/**
 * Saves a new emergence report and returns the new row's ID.
 */
export function saveEmergenceReport(
  patternSummary: string,
  groupsAnalyzed: string[],
): number {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO emergence_reports (generated_at, pattern_summary, groups_analyzed, delivered)
       VALUES (?, ?, ?, 0)`,
    )
    .run(now, patternSummary, JSON.stringify(groupsAnalyzed));
  return result.lastInsertRowid as number;
}

/**
 * Marks an emergence report as delivered.
 */
export function markEmergenceReportDelivered(id: number): void {
  getDb()
    .prepare('UPDATE emergence_reports SET delivered = 1 WHERE id = ?')
    .run(id);
}

/**
 * Returns all undelivered emergence reports, newest first.
 */
export function getUndeliveredEmergenceReports(): EmergenceReport[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM emergence_reports WHERE delivered = 0 ORDER BY generated_at DESC`,
    )
    .all() as Array<{
    id: number;
    generated_at: string;
    pattern_summary: string;
    groups_analyzed: string;
    delivered: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    generated_at: row.generated_at,
    pattern_summary: row.pattern_summary,
    groups_analyzed: JSON.parse(row.groups_analyzed) as string[],
    delivered: row.delivered === 1,
  }));
}
