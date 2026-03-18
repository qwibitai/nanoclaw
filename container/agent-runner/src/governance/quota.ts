/**
 * Subscription quota tracking and throttle logic.
 * Tracks invocations per day by type (autonomous vs CEO).
 * Model weighting: haiku=0.1, sonnet=1.0, opus=5.0.
 * Throttle at 60%, pause at 90%. CEO sessions always available (40% reserve).
 */

import fs from 'fs';
import path from 'path';
import { QuotaEntry, QuotaStatus } from './types.js';

const ATLAS_STATE_DIR = '/workspace/extra/atlas-state';
const QUOTA_FILE = path.join(ATLAS_STATE_DIR, 'autonomy', 'quota-tracking.jsonl');

// Estimated daily limit in weighted units.
// Conservative start — adjust based on observed rate limits.
const DAILY_LIMIT_ESTIMATE = 200;
const THROTTLE_THRESHOLD = 0.60;
const PAUSE_THRESHOLD = 0.90;

const MODEL_WEIGHTS: Record<string, number> = {
  haiku: 0.1,
  sonnet: 1.0,
  opus: 5.0,
};

function getModelWeight(model: string): number {
  // Match partial names (e.g., "claude-sonnet-4-20250514" → sonnet)
  for (const [key, weight] of Object.entries(MODEL_WEIGHTS)) {
    if (model.toLowerCase().includes(key)) return weight;
  }
  return 1.0;  // Default to sonnet weight
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

  const usagePercent = totalWeighted / DAILY_LIMIT_ESTIMATE;

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
  if (taskType === 'ceo_session') return true;  // Never throttle CEO

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
