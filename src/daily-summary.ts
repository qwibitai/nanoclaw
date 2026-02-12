/**
 * daily-summary.ts — Daily complaint summary generation and formatting.
 *
 * Standalone module that queries the complaints DB and produces a
 * WhatsApp-friendly text summary for the admin group.
 */
import type Database from 'better-sqlite3';

import { formatStatus } from './utils.js';

export interface SummaryData {
  totalOpen: number;
  byStatus: Record<string, number>;
  newToday: number;
  aging7: number;
  aging14: number;
  aging30: number;
  topCategories: Array<{ category: string; count: number }>;
  topAreas: Array<{ area: string; count: number }>;
  pendingValidations: number;
}

export function generateSummaryData(db: Database.Database): SummaryData {
  // Total open (not resolved)
  const totalOpen = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM complaints WHERE status NOT IN ('resolved')`,
      )
      .get() as { count: number }
  ).count;

  // By status
  const statusRows = db
    .prepare(
      `SELECT status, COUNT(*) as count FROM complaints WHERE status NOT IN ('resolved') GROUP BY status ORDER BY count DESC`,
    )
    .all() as Array<{ status: string; count: number }>;
  const byStatus: Record<string, number> = {};
  for (const row of statusRows) {
    byStatus[row.status] = row.count;
  }

  // New today
  const newToday = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM complaints WHERE DATE(created_at) = DATE('now')`,
      )
      .get() as { count: number }
  ).count;

  // Aging > 7 days (not resolved)
  const aging7 = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM complaints WHERE status NOT IN ('resolved') AND julianday('now') - julianday(created_at) > 7`,
      )
      .get() as { count: number }
  ).count;

  // Aging > 14 days (not resolved)
  const aging14 = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM complaints WHERE status NOT IN ('resolved') AND julianday('now') - julianday(created_at) > 14`,
      )
      .get() as { count: number }
  ).count;

  // Aging > 30 days (not resolved)
  const aging30 = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM complaints WHERE status NOT IN ('resolved') AND julianday('now') - julianday(created_at) > 30`,
      )
      .get() as { count: number }
  ).count;

  // Top categories (top 5, open only)
  const topCategories = db
    .prepare(
      `SELECT category, COUNT(*) as count FROM complaints WHERE status NOT IN ('resolved') AND category IS NOT NULL GROUP BY category ORDER BY count DESC LIMIT 5`,
    )
    .all() as Array<{ category: string; count: number }>;

  // Top areas — gracefully handle missing areas table
  let topAreas: Array<{ area: string; count: number }> = [];
  try {
    topAreas = db
      .prepare(
        `SELECT a.name as area, COUNT(*) as count FROM complaints c JOIN areas a ON c.area_id = a.id WHERE c.status NOT IN ('resolved') GROUP BY c.area_id ORDER BY count DESC LIMIT 5`,
      )
      .all() as Array<{ area: string; count: number }>;
  } catch {
    // areas table doesn't exist yet — return empty
  }

  // Pending validations
  const pendingValidations = (
    db
      .prepare(
        `SELECT COUNT(*) as count FROM complaints WHERE status = 'pending_validation'`,
      )
      .get() as { count: number }
  ).count;

  return {
    totalOpen,
    byStatus,
    newToday,
    aging7,
    aging14,
    aging30,
    topCategories,
    topAreas,
    pendingValidations,
  };
}

export function formatSummaryMessage(data: SummaryData): string {
  if (data.totalOpen === 0) {
    return 'No open complaints.';
  }

  const lines: string[] = [];

  lines.push('\u{1F4CA} Daily Complaint Summary');
  lines.push('');

  // Open complaints by status
  lines.push(`\u{1F4CB} Open Complaints: ${data.totalOpen}`);
  for (const [status, count] of Object.entries(data.byStatus)) {
    lines.push(`  - ${formatStatus(status)}: ${count}`);
  }

  // New today
  lines.push('');
  lines.push(`\u{1F195} New Today: ${data.newToday}`);

  // Pending validations (only if > 0)
  if (data.pendingValidations > 0) {
    lines.push('');
    lines.push(`\u{23F3} Pending Validation: ${data.pendingValidations}`);
  }

  // Aging
  if (data.aging7 > 0 || data.aging14 > 0 || data.aging30 > 0) {
    lines.push('');
    lines.push('\u{23F0} Aging Complaints:');
    lines.push(`  - > 7 days: ${data.aging7}`);
    lines.push(`  - > 14 days: ${data.aging14}`);
    lines.push(`  - > 30 days: ${data.aging30}`);
  }

  // Top categories
  if (data.topCategories.length > 0) {
    lines.push('');
    lines.push('\u{1F4C1} Top Categories:');
    data.topCategories.forEach((cat, i) => {
      lines.push(`  ${i + 1}. ${cat.category} (${cat.count})`);
    });
  }

  // Top areas
  if (data.topAreas.length > 0) {
    lines.push('');
    lines.push('\u{1F4CD} Top Areas:');
    data.topAreas.forEach((area, i) => {
      lines.push(`  ${i + 1}. ${area.area} (${area.count})`);
    });
  }

  return lines.join('\n');
}

export async function runDailySummary(
  db: Database.Database,
  sendMessage: (jid: string, text: string) => Promise<void>,
  adminGroupJid: string,
): Promise<void> {
  const data = generateSummaryData(db);
  const message = formatSummaryMessage(data);
  await sendMessage(adminGroupJid, message);
}
