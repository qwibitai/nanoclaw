/**
 * Cost Dashboard — On-demand cost reporting.
 *
 * Triggered by "cost report" command. Reads from the existing
 * session_costs table in db.ts.
 */

import { getDb } from '../db.js';
import { DAILY_BUDGET_USD } from '../config.js';
import type { GmailOps } from '../gmail-ops.js';
import { logger } from '../logger.js';
import { saveProcedure } from './procedure-store.js';

interface CostBreakdown {
  session_type: string;
  total_cost: number;
  task_count: number;
}

/**
 * Get cost breakdown by session type for a given time window.
 */
export function getCostBreakdown(sinceIso: string): CostBreakdown[] {
  const db = getDb();

  const rows = db
    .prepare(
      `SELECT session_type,
              COALESCE(SUM(estimated_cost_usd), 0) as total_cost,
              COUNT(*) as task_count
       FROM session_costs
       WHERE started_at >= ?
       GROUP BY session_type
       ORDER BY total_cost DESC`,
    )
    .all(sinceIso) as CostBreakdown[];

  return rows;
}

/**
 * Format a cost report for the last N days.
 */
export function formatCostReport(days: number = 7): string {
  const since = new Date(Date.now() - days * 86400000);
  const sinceIso = since.toISOString();
  const breakdown = getCostBreakdown(sinceIso);

  if (breakdown.length === 0) {
    return `*Cost report (last ${days} days)*\n\nNo activity recorded.`;
  }

  const lines: string[] = [`*Cost report (last ${days} days)*`, ''];

  let totalCost = 0;
  let totalTasks = 0;

  for (const row of breakdown) {
    const label =
      row.session_type.charAt(0).toUpperCase() + row.session_type.slice(1);
    lines.push(
      `${label}: $${row.total_cost.toFixed(2)} (${row.task_count} tasks)`,
    );
    totalCost += row.total_cost;
    totalTasks += row.task_count;
  }

  lines.push('');
  lines.push(`Total: $${totalCost.toFixed(2)} (${totalTasks} tasks)`);
  lines.push(`Budget: $${DAILY_BUDGET_USD.toFixed(2)}/day`);

  return lines.join('\n');
}

export type AssistantCommand =
  | { type: 'cost_report'; days: number }
  | { type: 'teach'; description: string }
  | { type: 'archive_dashboard' }
  | { type: 'archive_all' };

/**
 * Parse assistant commands from trigger-stripped message text.
 * Returns null if not a recognized command.
 */
export function parseAssistantCommand(text: string): AssistantCommand | null {
  const lower = text.trim().toLowerCase();

  // Cost report: "cost report", "cost report 30", "costs"
  const costMatch = lower.match(/^cost\s+report(?:\s+(\d+))?$/);
  if (costMatch) {
    const days = costMatch[1] ? parseInt(costMatch[1], 10) : 7;
    return { type: 'cost_report', days };
  }
  if (lower === 'costs') {
    return { type: 'cost_report', days: 7 };
  }

  // Teach mode: "teach: how to ..." or "teach how to ..."
  const teachMatch = text.trim().match(/^teach[:\s]+(.+)$/i);
  if (teachMatch) {
    return { type: 'teach', description: teachMatch[1].trim() };
  }

  // Archive all: "archive all", "/archive all", "archive queue all"
  // (check before the plain archive matcher so "all" isn't swallowed)
  if (/^\/?archive(\s+queue)?\s+all$/.test(lower)) {
    return { type: 'archive_all' };
  }

  // Archive dashboard: "archive", "/archive", "archive dashboard"
  if (/^\/?archive(\s+dashboard)?$/.test(lower)) {
    return { type: 'archive_dashboard' };
  }

  return null;
}

/**
 * Execute an assistant command and return the response text.
 *
 * `gmailOps` is required for the Gmail-first invariant on `archive_all`:
 * every gmail-sourced row is archived in Gmail before its local state is
 * resolved. Callers that can't supply gmailOps should not invoke
 * archive_all — it returns an error string rather than silently
 * local-resolving, which would put us back in the split-brain state the
 * reconciler was designed to avoid.
 */
export async function executeAssistantCommand(
  command: AssistantCommand,
  groupId?: string,
  gmailOps?: Pick<GmailOps, 'archiveThread'>,
): Promise<string> {
  switch (command.type) {
    case 'cost_report':
      return formatCostReport(command.days);

    case 'teach':
      return handleTeachCommand(command.description, groupId);

    case 'archive_dashboard':
      // Fire-and-forget: postArchiveDashboard upserts the pinned message and
      // logs/swallows its own errors. We return an ack string so the
      // chat-command router can respond immediately.
      void (async () => {
        const { postArchiveDashboard } = await import('../daily-digest.js');
        await postArchiveDashboard();
      })();
      return '🗂 Posting archive dashboard…';

    case 'archive_all':
      return archiveAllQueueItems(gmailOps);
  }
}

/**
 * Shared between callback-router (Telegram button) and the chat-command
 * entrypoint. Mirrors the Gmail-first invariant: archive each gmail-sourced
 * row in Gmail before local-resolving, leave failed rows queued so the
 * user can retry — the reconciler would re-surface them anyway if we
 * local-resolved without archiving in Gmail.
 */
async function archiveAllQueueItems(
  gmailOps?: Pick<GmailOps, 'archiveThread'>,
): Promise<string> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, source, thread_id, metadata FROM tracked_items
       WHERE state = 'queued'
         AND (queue = 'archive_candidate'
              OR (queue IS NULL AND classification = 'digest'))`,
    )
    .all() as Array<{
    id: string;
    source: string;
    thread_id: string | null;
    metadata: string | null;
  }>;

  if (rows.length === 0) return '🗂 Archive queue is already empty.';

  const succeededIds: string[] = [];
  let failed = 0;

  for (const row of rows) {
    let account: string | null = null;
    if (row.metadata) {
      try {
        const m = JSON.parse(row.metadata) as { account?: string };
        account = typeof m.account === 'string' ? m.account : null;
      } catch {
        // malformed metadata — treat as missing account
      }
    }

    // Non-gmail items: resolve locally with no Gmail call.
    if (row.source !== 'gmail' || !row.thread_id) {
      succeededIds.push(row.id);
      continue;
    }

    if (!gmailOps || !account) {
      failed++;
      continue;
    }

    try {
      await gmailOps.archiveThread(account, row.thread_id);
      succeededIds.push(row.id);
    } catch (err) {
      failed++;
      logger.warn(
        {
          itemId: row.id,
          account,
          threadId: row.thread_id,
          err: err instanceof Error ? err.message : String(err),
        },
        'archive_all (chat): Gmail archive failed, leaving item queued',
      );
    }
  }

  let archived = 0;
  if (succeededIds.length > 0) {
    const ph = succeededIds.map(() => '?').join(',');
    const info = db
      .prepare(
        `UPDATE tracked_items
         SET state = 'resolved',
             resolution_method = 'manual:archive_all',
             resolved_at = ?
         WHERE state = 'queued'
           AND id IN (${ph})`,
      )
      .run(Date.now(), ...succeededIds);
    archived = info.changes;
  }

  void (async () => {
    const { postArchiveDashboard } = await import('../daily-digest.js');
    await postArchiveDashboard();
  })();

  const base =
    archived === 0
      ? '🗂 Archive queue unchanged.'
      : `🗂 Archived ${archived} item${archived === 1 ? '' : 's'}.`;
  return failed > 0
    ? `${base} ${failed} item${failed === 1 ? '' : 's'} failed in Gmail and stayed queued — retry later.`
    : base;
}

/**
 * Handle the teach command — create a procedure from description.
 */
function handleTeachCommand(description: string, groupId?: string): string {
  // Parse the description into a procedure name and steps
  const lines = description
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const trigger = lines[0];
  const name = trigger
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

  const steps = lines.slice(1).map((line) => ({
    action: line.replace(/^\d+[.)]\s*/, ''), // Strip numbering
    details: undefined,
    expected: undefined,
  }));

  // If no explicit steps were given, store the whole description as a single step
  if (steps.length === 0) {
    steps.push({
      action: description,
      details: undefined,
      expected: undefined,
    });
  }

  const now = new Date().toISOString();
  saveProcedure({
    name,
    trigger,
    description,
    steps,
    success_count: 0,
    failure_count: 0,
    auto_execute: false,
    created_at: now,
    updated_at: now,
    groupId,
  });

  return (
    `Learned: *${trigger}*\n` +
    `Stored ${steps.length} step(s) as procedure \`${name}\`.\n` +
    `I'll suggest this procedure when you mention "${trigger}".`
  );
}
