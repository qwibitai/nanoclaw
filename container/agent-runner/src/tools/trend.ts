// Trend Analysis — daily snapshot collection, trend history I/O,
// and deterministic detectors that produce proactive proposals.
// Proposals are informational only — no auto-fix, no playbooks.

import fs from 'fs';
import path from 'path';

import type { HealthState } from './watcher.js';

// ─── Types ──────────────────────────────────────────────

export interface StateTransition {
  from: string;
  to: string;
  timestamp: string; // ISO timestamp
}

export interface BotTrendMetrics {
  restartCount: number;
  errorCount: number;
  uptimePercent: number;
  stateTransitions: StateTransition[];
  unreachableEpisodes: number;
  healthState: HealthState;
}

export interface TrendSnapshot {
  date: string; // YYYY-MM-DD
  bots: Record<string, BotTrendMetrics>;
}

export interface DetectorThreshold {
  [key: string]: number;
}

export interface DetectorConfig {
  enabled: boolean;
  windowDays: number;
  threshold: DetectorThreshold;
  minDataDays: number;
}

export interface TrendConfig {
  retentionDays: number;
  detectors: Record<string, DetectorConfig>;
}

export interface ProactiveProposal {
  detector: string;
  bot: string; // bot identifier or "fleet" for cross-bot
  severity: 'info';
  summary: string;
  details: string;
  suggestedAction: string;
}

// ─── Defaults ───────────────────────────────────────────

export const DEFAULT_TREND_CONFIG: TrendConfig = {
  retentionDays: 30,
  detectors: {
    'restart-frequency': {
      enabled: true,
      windowDays: 7,
      threshold: { restartCount: 4 },
      minDataDays: 3,
    },
    'error-rate-trend': {
      enabled: true,
      windowDays: 5,
      threshold: { consecutiveIncreasingDays: 3 },
      minDataDays: 3,
    },
    'uptime-anomaly': {
      enabled: true,
      windowDays: 7,
      threshold: { avgUptimePercentBelow: 95 },
      minDataDays: 5,
    },
    'cross-bot-correlation': {
      enabled: true,
      windowDays: 1,
      threshold: { minBotsAffected: 2 },
      minDataDays: 1,
    },
  },
};

// ─── Config I/O ─────────────────────────────────────────

/**
 * Read trend config from a JSON file. Returns defaults if missing or invalid.
 * Auto-creates file with defaults if missing.
 */
export function readTrendConfig(filePath: string): TrendConfig {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);

    // Validate structure
    if (typeof parsed !== 'object' || parsed === null) {
      return { ...DEFAULT_TREND_CONFIG };
    }
    if (typeof parsed.retentionDays !== 'number' || parsed.retentionDays < 1) {
      return { ...DEFAULT_TREND_CONFIG };
    }
    if (typeof parsed.detectors !== 'object' || parsed.detectors === null) {
      return { ...DEFAULT_TREND_CONFIG };
    }

    // Validate each detector
    for (const [key, det] of Object.entries(parsed.detectors)) {
      const d = det as any;
      if (typeof d.enabled !== 'boolean' ||
          typeof d.windowDays !== 'number' ||
          typeof d.threshold !== 'object' ||
          typeof d.minDataDays !== 'number') {
        // Malformed detector — fall back to defaults for the whole config
        return { ...DEFAULT_TREND_CONFIG };
      }
    }

    return parsed as TrendConfig;
  } catch {
    // Auto-create with defaults if missing
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(DEFAULT_TREND_CONFIG, null, 2));
    } catch { /* best-effort */ }
    return { ...DEFAULT_TREND_CONFIG };
  }
}

// ─── Trend History I/O ──────────────────────────────────

/**
 * Read trend history from a JSON file. Returns empty array if missing or corrupt.
 */
export function readTrendHistory(filePath: string): TrendSnapshot[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Basic validation: each entry must have date and bots
    for (const snap of parsed) {
      if (typeof snap.date !== 'string' || typeof snap.bots !== 'object') {
        return [];
      }
    }
    return parsed as TrendSnapshot[];
  } catch {
    return [];
  }
}

/**
 * Write a trend snapshot to history. Idempotent — replaces if today's date exists.
 * Prunes entries older than retentionDays. Atomic write (tmp + rename).
 */
export function writeTrendSnapshot(
  filePath: string,
  snapshot: TrendSnapshot,
  retentionDays: number = 30,
): void {
  let history = readTrendHistory(filePath);

  // Replace if same date exists (idempotent)
  history = history.filter(s => s.date !== snapshot.date);
  history.push(snapshot);

  // Sort by date ascending
  history.sort((a, b) => a.date.localeCompare(b.date));

  // Prune old snapshots
  history = pruneTrendHistory(history, retentionDays, snapshot.date);

  // Atomic write
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(history, null, 2));
  fs.renameSync(tmpPath, filePath);
}

/**
 * Prune trend history, removing snapshots older than retentionDays from referenceDate.
 * Returns the pruned array (does not mutate input).
 */
export function pruneTrendHistory(
  history: TrendSnapshot[],
  retentionDays: number,
  referenceDate?: string,
): TrendSnapshot[] {
  const refDate = referenceDate ? new Date(referenceDate) : new Date();
  const cutoff = new Date(refDate);
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return history.filter(s => s.date >= cutoffStr);
}

// ─── Snapshot Collection ────────────────────────────────

export interface DigestBotData {
  bot: string;
  healthState: HealthState;
  restartCount: number;
  errorCount: number;
  uptimePercent: number;
  stateTransitions: StateTransition[];
  unreachableEpisodes: number;
}

/**
 * Collect a trend snapshot from daily digest data.
 * The caller (daily digest prompt / trend_snapshot tool) provides per-bot metrics.
 */
export function collectTrendSnapshot(
  botData: DigestBotData[],
  date?: string,
): TrendSnapshot {
  const snapshotDate = date ?? new Date().toISOString().slice(0, 10);
  const bots: Record<string, BotTrendMetrics> = {};

  for (const bd of botData) {
    bots[bd.bot] = {
      restartCount: bd.restartCount,
      errorCount: bd.errorCount,
      uptimePercent: bd.uptimePercent,
      stateTransitions: bd.stateTransitions,
      unreachableEpisodes: bd.unreachableEpisodes,
      healthState: bd.healthState,
    };
  }

  return { date: snapshotDate, bots };
}

// ─── Trend Detectors ────────────────────────────────────

/**
 * Get the most recent N snapshots from history (sorted by date desc within window).
 */
function getWindowSnapshots(
  history: TrendSnapshot[],
  windowDays: number,
  referenceDate?: string,
): TrendSnapshot[] {
  const refDate = referenceDate ?? history[history.length - 1]?.date;
  if (!refDate) return [];

  const ref = new Date(refDate);
  const cutoff = new Date(ref);
  cutoff.setDate(cutoff.getDate() - windowDays);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  return history.filter(s => s.date > cutoffStr && s.date <= refDate);
}

/**
 * Get all bot identifiers present across a set of snapshots.
 */
function allBotIds(snapshots: TrendSnapshot[]): string[] {
  const ids = new Set<string>();
  for (const snap of snapshots) {
    for (const bot of Object.keys(snap.bots)) {
      ids.add(bot);
    }
  }
  return Array.from(ids);
}

/**
 * Restart Frequency Detector.
 * Fires when a bot's total restart count over windowDays exceeds the threshold.
 */
export function detectRestartFrequency(
  history: TrendSnapshot[],
  config: DetectorConfig,
  filterBot?: string,
): ProactiveProposal[] {
  const window = getWindowSnapshots(history, config.windowDays);
  if (window.length < config.minDataDays) return [];

  const threshold = config.threshold.restartCount ?? 4;
  const proposals: ProactiveProposal[] = [];
  const bots = filterBot ? [filterBot] : allBotIds(window);

  for (const bot of bots) {
    let total = 0;
    const perDay: string[] = [];

    for (const snap of window) {
      const metrics = snap.bots[bot];
      if (metrics) {
        total += metrics.restartCount;
        if (metrics.restartCount > 0) {
          perDay.push(`${snap.date}=${metrics.restartCount}`);
        }
      }
    }

    if (total >= threshold) {
      proposals.push({
        detector: 'restart-frequency',
        bot,
        severity: 'info',
        summary: `${bot} has restarted ${total} times in the past ${config.windowDays} days.`,
        details: `Restart count by day: ${perDay.join(', ')}. Total: ${total} in ${window.length} days (threshold: ${threshold}).`,
        suggestedAction: `I can check ${bot}'s logs for crash patterns.`,
      });
    }
  }

  return proposals;
}

/**
 * Error Rate Trend Detector.
 * Fires when a bot has N consecutive days of increasing error count.
 */
export function detectErrorRateTrend(
  history: TrendSnapshot[],
  config: DetectorConfig,
  filterBot?: string,
): ProactiveProposal[] {
  const window = getWindowSnapshots(history, config.windowDays);
  if (window.length < config.minDataDays) return [];

  const consecutiveThreshold = config.threshold.consecutiveIncreasingDays ?? 3;
  const proposals: ProactiveProposal[] = [];
  const bots = filterBot ? [filterBot] : allBotIds(window);

  // Sort window by date ascending for streak detection
  const sorted = [...window].sort((a, b) => a.date.localeCompare(b.date));

  for (const bot of bots) {
    let streak = 0;
    let maxStreak = 0;
    let prevCount: number | null = null;
    const errorCounts: string[] = [];

    for (const snap of sorted) {
      const metrics = snap.bots[bot];
      if (!metrics) {
        streak = 0;
        prevCount = null;
        continue;
      }

      errorCounts.push(`${snap.date}=${metrics.errorCount}`);

      if (prevCount !== null && metrics.errorCount > prevCount) {
        streak++;
      } else {
        streak = 0;
      }

      if (streak > maxStreak) maxStreak = streak;
      prevCount = metrics.errorCount;
    }

    if (maxStreak >= consecutiveThreshold) {
      proposals.push({
        detector: 'error-rate-trend',
        bot,
        severity: 'info',
        summary: `${bot}'s error rate has been climbing for ${maxStreak} consecutive days.`,
        details: `Error counts: ${errorCounts.join(', ')}. Streak of ${maxStreak} consecutive increasing days (threshold: ${consecutiveThreshold}).`,
        suggestedAction: `I can search ${bot}'s logs for the most common error patterns.`,
      });
    }
  }

  return proposals;
}

/**
 * Uptime Anomaly Detector.
 * Fires when a bot's average uptimePercent over windowDays falls below the threshold.
 */
export function detectUptimeAnomaly(
  history: TrendSnapshot[],
  config: DetectorConfig,
  filterBot?: string,
): ProactiveProposal[] {
  const window = getWindowSnapshots(history, config.windowDays);
  if (window.length < config.minDataDays) return [];

  const uptimeThreshold = config.threshold.avgUptimePercentBelow ?? 95;
  const proposals: ProactiveProposal[] = [];
  const bots = filterBot ? [filterBot] : allBotIds(window);

  for (const bot of bots) {
    let totalUptime = 0;
    let count = 0;
    const perDay: string[] = [];

    for (const snap of window) {
      const metrics = snap.bots[bot];
      if (metrics) {
        totalUptime += metrics.uptimePercent;
        count++;
        perDay.push(`${snap.date}=${metrics.uptimePercent.toFixed(1)}%`);
      }
    }

    if (count === 0) continue;
    const avg = totalUptime / count;

    if (avg < uptimeThreshold) {
      proposals.push({
        detector: 'uptime-anomaly',
        bot,
        severity: 'info',
        summary: `${bot}'s average uptime is ${avg.toFixed(1)}% over the past ${config.windowDays} days.`,
        details: `Per-day uptime: ${perDay.join(', ')}. Average: ${avg.toFixed(1)}% (threshold: <${uptimeThreshold}%).`,
        suggestedAction: `I can investigate ${bot}'s downtime patterns and check for recurring issues.`,
      });
    }
  }

  return proposals;
}

/**
 * Cross-Bot Correlation Detector.
 * Fires when multiple bots experience the same issue type in the same daily snapshot.
 */
export function detectCrossBotCorrelation(
  history: TrendSnapshot[],
  config: DetectorConfig,
  _filterBot?: string, // ignored — cross-bot by definition
): ProactiveProposal[] {
  const window = getWindowSnapshots(history, config.windowDays);
  if (window.length < config.minDataDays) return [];

  const minBots = config.threshold.minBotsAffected ?? 2;
  const proposals: ProactiveProposal[] = [];

  // Issue types to check
  const issueTypes: Array<{ name: string; check: (m: BotTrendMetrics) => boolean }> = [
    { name: 'unreachable', check: (m) => m.unreachableEpisodes > 0 },
    { name: 'down', check: (m) => m.healthState === 'down' },
    { name: 'degraded', check: (m) => m.healthState === 'degraded' },
  ];

  // Track which issue types we've already reported (deduplicate across snapshots)
  const reported = new Set<string>();

  for (const snap of window) {
    const botIds = Object.keys(snap.bots);

    for (const issue of issueTypes) {
      if (reported.has(issue.name)) continue;

      const affected = botIds.filter(bot => issue.check(snap.bots[bot]));
      if (affected.length >= minBots) {
        reported.add(issue.name);
        proposals.push({
          detector: 'cross-bot-correlation',
          bot: 'fleet',
          severity: 'info',
          summary: `${affected.length} bots had ${issue.name} issues on ${snap.date}.`,
          details: `Affected bots: ${affected.join(', ')}. Issue type: ${issue.name}. This may indicate a shared infrastructure problem.`,
          suggestedAction: `I can compare error logs across both bots to look for a common cause.`,
        });
      }
    }
  }

  return proposals;
}

// ─── Run All Detectors ──────────────────────────────────

type DetectorFn = (
  history: TrendSnapshot[],
  config: DetectorConfig,
  filterBot?: string,
) => ProactiveProposal[];

const DETECTOR_REGISTRY: Record<string, DetectorFn> = {
  'restart-frequency': detectRestartFrequency,
  'error-rate-trend': detectErrorRateTrend,
  'uptime-anomaly': detectUptimeAnomaly,
  'cross-bot-correlation': detectCrossBotCorrelation,
};

export interface TrendAnalysisResult {
  proposals: ProactiveProposal[];
  analyzedDays: number;
  botsAnalyzed: string[];
}

/**
 * Run all enabled detectors against trend history.
 * Returns proposals and analysis metadata.
 */
export function runTrendAnalysis(
  history: TrendSnapshot[],
  config: TrendConfig,
  filterBot?: string,
): TrendAnalysisResult {
  const proposals: ProactiveProposal[] = [];
  const botSet = new Set<string>();

  for (const snap of history) {
    for (const bot of Object.keys(snap.bots)) {
      botSet.add(bot);
    }
  }

  for (const [name, detConfig] of Object.entries(config.detectors)) {
    if (!detConfig.enabled) continue;

    const detector = DETECTOR_REGISTRY[name];
    if (!detector) continue;

    const results = detector(history, detConfig, filterBot);
    proposals.push(...results);
  }

  return {
    proposals,
    analyzedDays: history.length,
    botsAnalyzed: filterBot ? [filterBot] : Array.from(botSet),
  };
}
