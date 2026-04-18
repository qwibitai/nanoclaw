/**
 * Cost Dashboard — On-demand cost reporting.
 *
 * Triggered by "cost report" command. Reads from the existing
 * session_costs table in db.ts.
 */

import { getDb } from '../db.js';
import { DAILY_BUDGET_USD } from '../config.js';
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
  | { type: 'teach'; description: string };

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

  return null;
}

/**
 * Execute an assistant command and return the response text.
 */
export function executeAssistantCommand(
  command: AssistantCommand,
  groupId?: string,
): string {
  switch (command.type) {
    case 'cost_report':
      return formatCostReport(command.days);

    case 'teach':
      return handleTeachCommand(command.description, groupId);
  }
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
