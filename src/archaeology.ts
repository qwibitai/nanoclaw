import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, TIMEZONE } from './config.js';
import { createTask, getDb, getTasksForGroup } from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface ContainerLogEntry {
  timestamp: string;
  group: string;
  durationMs: number;
  exitCode: number;
  hadOutput: boolean;
  toolsUsed: string[];
  wasTimeout: boolean;
}

export interface ArchaeologyReport {
  groupFolder: string;
  generatedAt: string;
  slowTaskCount: number;
  silentFailureCount: number;
  toolUsageSummary: Record<string, number>;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  anomalies: string[];
}

/**
 * Parse a single container log file content into a structured entry.
 */
export function parseContainerLog(logContent: string): ContainerLogEntry {
  const firstLine = logContent.split('\n')[0] ?? '';

  const tsMatch = firstLine.match(/^\[(\S+)\]/);
  const timestamp = tsMatch ? tsMatch[1] : new Date().toISOString();

  const groupMatch = logContent.match(/Group:\s*(\S+)/);
  const group = groupMatch ? groupMatch[1] : 'unknown';

  const durationMatch = logContent.match(/Duration:\s*(\d+)ms/);
  const durationMs = durationMatch ? parseInt(durationMatch[1], 10) : 0;

  const exitCodeMatch = logContent.match(/Exit code:\s*(\d+)/);
  const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : 0;

  const hadOutput = /Had Streaming Output: true/i.test(logContent);

  const wasTimeout = /TIMEOUT/i.test(logContent);

  const toolsUsed: string[] = [];
  const toolRegex = /"type":"tool_use","name":"(\w+)"/g;
  let toolMatch: RegExpExecArray | null;
  while ((toolMatch = toolRegex.exec(logContent)) !== null) {
    toolsUsed.push(toolMatch[1]);
  }

  return {
    timestamp,
    group,
    durationMs,
    exitCode,
    hadOutput,
    toolsUsed,
    wasTimeout,
  };
}

/**
 * Compute a percentile value from an array of numbers.
 * Returns null for empty arrays.
 */
export function computePercentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) return sorted[lower];

  const fraction = index - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

/**
 * Analyze all log files in a directory and produce an archaeology report.
 */
export function analyzeGroupLogs(
  groupFolder: string,
  logsDir: string,
  options?: { slowThresholdMs?: number; lookbackDays?: number },
): ArchaeologyReport {
  const slowThresholdMs = options?.slowThresholdMs ?? 60000;
  const lookbackDays = options?.lookbackDays ?? 30;
  const generatedAt = new Date().toISOString();

  const emptyReport: ArchaeologyReport = {
    groupFolder,
    generatedAt,
    slowTaskCount: 0,
    silentFailureCount: 0,
    toolUsageSummary: {},
    p50DurationMs: null,
    p95DurationMs: null,
    anomalies: [],
  };

  if (!fs.existsSync(logsDir)) {
    return emptyReport;
  }

  let logFiles: string[];
  try {
    logFiles = fs
      .readdirSync(logsDir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => path.join(logsDir, f));
  } catch {
    return emptyReport;
  }

  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  const entries: ContainerLogEntry[] = [];
  for (const filePath of logFiles) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) continue;
      const content = fs.readFileSync(filePath, 'utf-8');
      entries.push(parseContainerLog(content));
    } catch (err) {
      logger.warn({ filePath, err }, 'Failed to parse log file');
    }
  }

  if (entries.length === 0) {
    return emptyReport;
  }

  let slowTaskCount = 0;
  let silentFailureCount = 0;
  const toolUsageSummary: Record<string, number> = {};
  const durations: number[] = [];
  let timeoutCount = 0;

  for (const entry of entries) {
    durations.push(entry.durationMs);

    if (entry.durationMs > slowThresholdMs) {
      slowTaskCount++;
    }

    if (entry.exitCode !== 0 && !entry.hadOutput) {
      silentFailureCount++;
    }

    if (entry.wasTimeout) {
      timeoutCount++;
    }

    for (const tool of entry.toolsUsed) {
      toolUsageSummary[tool] = (toolUsageSummary[tool] ?? 0) + 1;
    }
  }

  const p50DurationMs = computePercentile(durations, 50);
  const p95DurationMs = computePercentile(durations, 95);

  const anomalies: string[] = [];

  if (timeoutCount > 0) {
    anomalies.push(`${timeoutCount} task(s) timed out`);
  }

  const failureRate = entries.filter((e) => e.exitCode !== 0).length / entries.length;
  if (failureRate > 0.3) {
    const pct = Math.round(failureRate * 100);
    anomalies.push(`High failure rate: ${pct}% of tasks exited non-zero`);
  }

  if (silentFailureCount > 0) {
    anomalies.push(`${silentFailureCount} silent failure(s) detected (non-zero exit, no output)`);
  }

  if (p95DurationMs !== null && p50DurationMs !== null && p95DurationMs > p50DurationMs * 5) {
    anomalies.push(
      `High duration variance: p95 (${p95DurationMs}ms) is more than 5x p50 (${p50DurationMs}ms)`,
    );
  }

  return {
    groupFolder,
    generatedAt,
    slowTaskCount,
    silentFailureCount,
    toolUsageSummary,
    p50DurationMs,
    p95DurationMs,
    anomalies,
  };
}

/**
 * Build a markdown performance report from an ArchaeologyReport.
 */
export function buildPerformanceMd(report: ArchaeologyReport): string {
  const lines: string[] = [];

  lines.push(`# PERFORMANCE Report - ${report.groupFolder}`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(
    `- **p50 Duration:** ${report.p50DurationMs !== null ? `${report.p50DurationMs}ms` : 'N/A'}`,
  );
  lines.push(
    `- **p95 Duration:** ${report.p95DurationMs !== null ? `${report.p95DurationMs}ms` : 'N/A'}`,
  );
  lines.push(`- **Slow Tasks:** ${report.slowTaskCount}`);
  lines.push(`- **Silent Failures:** ${report.silentFailureCount}`);
  lines.push('');
  lines.push('## Tool Usage');
  lines.push('');

  const toolEntries = Object.entries(report.toolUsageSummary);
  if (toolEntries.length === 0) {
    lines.push('_No tool usage recorded._');
  } else {
    const sorted = toolEntries.sort((a, b) => b[1] - a[1]);
    for (const [tool, count] of sorted) {
      lines.push(`- **${tool}:** ${count} call(s)`);
    }
  }

  lines.push('');
  lines.push('## Anomalies');
  lines.push('');

  if (report.anomalies.length === 0) {
    lines.push('_No anomalies detected._');
  } else {
    for (const anomaly of report.anomalies) {
      lines.push(`- ${anomaly}`);
    }
  }

  return lines.join('\n');
}

/**
 * Persist an ArchaeologyReport to the database and return the new row ID.
 */
export function saveArchaeologyReport(report: ArchaeologyReport): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO archaeology_reports
         (group_folder, generated_at, slow_task_count, silent_failure_count,
          tool_usage_summary, p50_duration_ms, p95_duration_ms, anomalies)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      report.groupFolder,
      report.generatedAt,
      report.slowTaskCount,
      report.silentFailureCount,
      JSON.stringify(report.toolUsageSummary),
      report.p50DurationMs,
      report.p95DurationMs,
      JSON.stringify(report.anomalies),
    );
  return result.lastInsertRowid as number;
}

/**
 * Schedule a weekly archaeology task for each registered group. Idempotent.
 */
export function scheduleArchaeologyTask(
  queue: GroupQueue,
  registeredGroups: () => Record<string, RegisteredGroup>,
): void {
  const groups = registeredGroups();
  const cronExpr = '0 4 * * 0';

  for (const group of Object.values(groups)) {
    const taskId = `archaeology-${group.folder}`;

    const existing = getDb()
      .prepare('SELECT id FROM scheduled_tasks WHERE id = ?')
      .get(taskId);

    if (existing) {
      logger.debug({ taskId }, 'Archaeology task already scheduled, skipping');
      continue;
    }

    const nextRun = CronExpressionParser.parse(cronExpr, { tz: TIMEZONE })
      .next()
      .toISOString();

    const now = new Date().toISOString();

    createTask({
      id: taskId,
      group_folder: group.folder,
      chat_jid: `archaeology-${group.folder}`,
      prompt: `Generate an archaeology performance report for group "${group.folder}". Analyze container log files and summarize performance metrics, slow tasks, and anomalies.`,
      schedule_type: 'cron',
      schedule_value: cronExpr,
      context_mode: 'isolated',
      next_run: nextRun,
      status: 'active',
      created_at: now,
    });

    logger.info(
      { taskId, groupFolder: group.folder, nextRun },
      'Archaeology task scheduled',
    );
  }
}
