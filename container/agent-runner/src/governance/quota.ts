/**
 * Self-calibrating subscription quota tracking and throttle logic.
 *
 * Tracks invocations per day by type (autonomous vs CEO).
 * Model weighting: haiku=0.1, sonnet=1.0, opus=5.0.
 * Throttle at 60%, pause at 90%. CEO sessions always available (40% reserve).
 *
 * Self-calibrating: starts at 1000 weighted units/day estimate.
 * When a 429 rate limit is hit, records that as the actual ceiling and adjusts down.
 * When a full day passes with no rate limit, gradually raises the estimate.
 * The quota system learns the real limit from actual usage.
 */

import fs from 'fs';
import path from 'path';
import { QuotaEntry, QuotaStatus } from './types.js';

const ATLAS_STATE_DIR = '/workspace/extra/atlas-state';
const AUTONOMY_DIR = path.join(ATLAS_STATE_DIR, 'autonomy');
const QUOTA_FILE = path.join(AUTONOMY_DIR, 'quota-tracking.jsonl');
const CALIBRATION_FILE = path.join(AUTONOMY_DIR, 'quota-calibration.json');

// Starting estimate — deliberately generous. Self-calibration tightens it.
const DEFAULT_LIMIT_ESTIMATE = 1000;
const THROTTLE_THRESHOLD = 0.60;
const PAUSE_THRESHOLD = 0.90;

// Calibration: raise by 10% per clean day, no higher than default
const CALIBRATION_RAISE_FACTOR = 1.10;
const CALIBRATION_MIN_LIMIT = 50;  // Floor — never estimate below this

const MODEL_WEIGHTS: Record<string, number> = {
  haiku: 0.1,
  sonnet: 1.0,
  opus: 5.0,
};

interface CalibrationData {
  estimated_limit: number;
  last_429_at: string | null;
  last_429_weighted_usage: number | null;
  consecutive_clean_days: number;
  last_calibration_date: string;
}

function getModelWeight(model: string): number {
  for (const [key, weight] of Object.entries(MODEL_WEIGHTS)) {
    if (model.toLowerCase().includes(key)) return weight;
  }
  return 1.0;
}

function loadCalibration(): CalibrationData {
  try {
    if (fs.existsSync(CALIBRATION_FILE)) {
      return JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf-8'));
    }
  } catch { /* use defaults */ }
  return {
    estimated_limit: DEFAULT_LIMIT_ESTIMATE,
    last_429_at: null,
    last_429_weighted_usage: null,
    consecutive_clean_days: 0,
    last_calibration_date: new Date().toISOString().split('T')[0],
  };
}

function saveCalibration(data: CalibrationData): void {
  try {
    fs.mkdirSync(path.dirname(CALIBRATION_FILE), { recursive: true });
    fs.writeFileSync(CALIBRATION_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[governance/quota] Failed to save calibration: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function getDailyLimit(): number {
  const cal = loadCalibration();
  const today = new Date().toISOString().split('T')[0];

  // If we haven't calibrated today, check if yesterday was clean
  if (cal.last_calibration_date !== today) {
    // New day — if no 429 yesterday, raise estimate slightly
    if (cal.last_429_at === null || !cal.last_429_at.startsWith(cal.last_calibration_date)) {
      cal.consecutive_clean_days++;
      // Gradually raise: 10% per clean day, capped at default
      if (cal.estimated_limit < DEFAULT_LIMIT_ESTIMATE) {
        cal.estimated_limit = Math.min(
          DEFAULT_LIMIT_ESTIMATE,
          Math.round(cal.estimated_limit * CALIBRATION_RAISE_FACTOR),
        );
      }
    } else {
      cal.consecutive_clean_days = 0;
    }
    cal.last_calibration_date = today;
    saveCalibration(cal);
  }

  return cal.estimated_limit;
}

function getTodayEntries(): QuotaEntry[] {
  try {
    if (!fs.existsSync(QUOTA_FILE)) return [];

    const today = new Date().toISOString().split('T')[0];
    const content = fs.readFileSync(QUOTA_FILE, 'utf-8');
    const entries: QuotaEntry[] = [];

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as QuotaEntry;
        if (entry.timestamp.startsWith(today)) {
          entries.push(entry);
        }
      } catch { /* skip malformed lines */ }
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * Get current quota status for today.
 */
export function getQuotaStatus(): QuotaStatus {
  const entries = getTodayEntries();
  const dailyLimit = getDailyLimit();

  let totalWeighted = 0;
  let autonomousCount = 0;
  let ceoCount = 0;

  for (const entry of entries) {
    const weight = getModelWeight(entry.model);
    totalWeighted += weight;

    if (entry.type === 'autonomous') {
      autonomousCount++;
    } else {
      ceoCount++;
    }
  }

  const usagePercent = totalWeighted / dailyLimit;

  let throttleLevel: 'normal' | 'throttled' | 'paused' = 'normal';
  if (usagePercent >= PAUSE_THRESHOLD) {
    throttleLevel = 'paused';
  } else if (usagePercent >= THROTTLE_THRESHOLD) {
    throttleLevel = 'throttled';
  }

  return {
    today_total: entries.length,
    today_autonomous: autonomousCount,
    today_ceo: ceoCount,
    weighted_usage: Math.round(usagePercent * 100) / 100,
    throttle_level: throttleLevel,
  };
}

/**
 * Check if a task should run given current quota status.
 * CEO sessions always allowed. Autonomous tasks respect throttle/pause.
 */
export function shouldRunTask(taskType: 'autonomous' | 'ceo_session'): boolean {
  if (taskType === 'ceo_session') return true;

  const status = getQuotaStatus();
  return status.throttle_level === 'normal';
}

/**
 * Log an invocation to the quota tracking file.
 */
export function logInvocation(entry: QuotaEntry): void {
  try {
    const dir = path.dirname(QUOTA_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(QUOTA_FILE, JSON.stringify(entry) + '\n', { flag: 'a' });
  } catch (err) {
    console.error(`[governance/quota] Failed to log invocation: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Record a 429 rate limit event. Calibrates the daily limit downward
 * to the weighted usage level where the limit was hit.
 */
export function recordRateLimit(): void {
  try {
    const entries = getTodayEntries();
    let totalWeighted = 0;
    for (const entry of entries) {
      totalWeighted += getModelWeight(entry.model);
    }

    const cal = loadCalibration();
    const now = new Date().toISOString();

    // Set the ceiling to where we actually hit the limit (with 10% buffer below)
    const newLimit = Math.max(CALIBRATION_MIN_LIMIT, Math.round(totalWeighted * 0.90));
    cal.estimated_limit = newLimit;
    cal.last_429_at = now;
    cal.last_429_weighted_usage = totalWeighted;
    cal.consecutive_clean_days = 0;

    saveCalibration(cal);
    console.error(`[governance/quota] Rate limit hit at ${totalWeighted} weighted units. Calibrated limit to ${newLimit}.`);
  } catch (err) {
    console.error(`[governance/quota] Failed to record rate limit: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Generate a quota alert message if a threshold was newly crossed.
 * Returns alert message or null.
 */
export function getQuotaAlert(): string | null {
  const status = getQuotaStatus();
  if (status.throttle_level === 'paused') {
    return `Quota alert: 90%+ usage (${status.today_total} invocations, ${status.weighted_usage} weighted). Autonomous tasks paused. CEO sessions only.`;
  }
  if (status.throttle_level === 'throttled') {
    return `Quota warning: 60%+ usage (${status.today_total} invocations, ${status.weighted_usage} weighted). Throttling autonomous tasks.`;
  }
  return null;
}
