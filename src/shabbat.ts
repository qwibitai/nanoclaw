import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

interface ShabbatWindow {
  start: string;
  end: string;
  type: 'shabbat' | 'yomtov' | 'shabbat+yomtov';
  label: string;
}

interface ShabbatSchedule {
  location: string;
  coordinates: number[];
  elevation: number;
  tzeisBufferMinutes: number;
  generatedAt: string;
  expiresAt: string;
  windowCount: number;
  windows: ShabbatWindow[];
}

let schedule: ShabbatSchedule | null = null;
let windowStarts: number[] = [];
let windowEnds: number[] = [];

const EXPIRY_WARNING_DAYS = 30;

function loadSchedule(s: ShabbatSchedule): void {
  schedule = s;
  windowStarts = s.windows.map((w) => new Date(w.start).getTime());
  windowEnds = s.windows.map((w) => new Date(w.end).getTime());
}

/**
 * Load the Shabbat schedule from disk. Called once at startup.
 * If the file doesn't exist, Shabbat mode is disabled (no restrictions).
 */
export function initShabbatSchedule(): void {
  const filePath = path.resolve(process.cwd(), 'data', 'shabbat-schedule.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed: ShabbatSchedule = JSON.parse(raw);
    loadSchedule(parsed);
    logger.info(
      { windowCount: parsed.windowCount, expiresAt: parsed.expiresAt },
      'Shabbat schedule loaded',
    );

    const expiresAt = new Date(parsed.expiresAt).getTime();
    const warningThreshold = Date.now() + EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000;
    if (expiresAt < warningThreshold) {
      logger.warn(
        { expiresAt: parsed.expiresAt },
        'Shabbat schedule expires soon! Run: npm run generate-zmanim',
      );
    }
  } catch {
    logger.info('No Shabbat schedule found, Shabbat mode disabled');
  }
}

/**
 * Check if the current time falls within a Shabbat or Yom Tov window.
 * Uses binary search for O(log n) lookup.
 */
export function isShabbatOrYomTov(): boolean {
  if (!schedule || windowStarts.length === 0) return false;

  const now = Date.now();

  let lo = 0;
  let hi = windowStarts.length - 1;
  let candidate = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (windowStarts[mid] <= now) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (candidate === -1) return false;
  return now < windowEnds[candidate];
}

/** @internal — for tests only */
export function _loadScheduleForTest(s: ShabbatSchedule): void {
  loadSchedule(s);
}
