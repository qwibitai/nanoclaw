import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogEntryStatus = 'reminded' | 'taken' | 'missed' | 'snoozed';

export interface LogEntry {
  date: string; // YYYY-MM-DD in deps.tz timezone
  time: string; // HH:MM:SS in deps.tz timezone
  status: LogEntryStatus;
}

export interface MedicationConfig {
  schedule: string; // cron expression
  chatJid: string;
  active: boolean;
}

export interface MedicationDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  logPath: string;
  configPath: string;
  tz: string;
}

export type ParsedReply =
  | { type: 'taken' }
  | { type: 'snooze' }
  | { type: 'later'; hhmm: string }; // "HH:MM", already validated

export type DayStatus = 'none' | 'reminded' | 'snoozed' | 'taken' | 'missed';

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

function isValidHHMM(hhmm: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!match) return false;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

/**
 * Parse a user reply into a typed action.
 * Returns null if the text is not recognised as a medication reply.
 */
export function parseReply(text: string): ParsedReply | null {
  const lower = text.trim().toLowerCase();

  if (lower === 'taken') return { type: 'taken' };
  if (lower === 'snooze') return { type: 'snooze' };

  const laterMatch = /^later\s+(\d{1,2}:\d{2})$/.exec(lower);
  if (laterMatch) {
    const [h, m] = laterMatch[1].split(':');
    const hhmm = `${h.padStart(2, '0')}:${m}`;
    if (isValidHHMM(hhmm)) return { type: 'later', hhmm };
  }

  return null;
}

/**
 * Returns the effective status for today using the given timezone.
 * Priority: taken > missed > snoozed > reminded > none
 */
export function getTodayStatus(log: LogEntry[], tz: string): DayStatus {
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: tz });
  const todayEntries = log.filter((e) => e.date === today);

  if (todayEntries.some((e) => e.status === 'taken')) return 'taken';
  if (todayEntries.some((e) => e.status === 'missed')) return 'missed';
  if (todayEntries.some((e) => e.status === 'snoozed')) return 'snoozed';
  if (todayEntries.some((e) => e.status === 'reminded')) return 'reminded';
  return 'none';
}

/**
 * Read the medication log. Returns [] if file is missing or unreadable.
 */
export function readLog(logPath: string): LogEntry[] {
  try {
    if (!fs.existsSync(logPath)) return [];
    return JSON.parse(fs.readFileSync(logPath, 'utf-8')) as LogEntry[];
  } catch {
    return [];
  }
}

/**
 * Append a status entry to the log. Writes atomically via tmp-file rename.
 * Dates and times are computed in the given timezone.
 */
export function appendToLog(
  logPath: string,
  status: LogEntryStatus,
  tz: string,
): void {
  const log = readLog(logPath);
  const now = new Date();
  const date = now.toLocaleDateString('sv-SE', { timeZone: tz }); // YYYY-MM-DD
  const time = now.toLocaleTimeString('sv-SE', { timeZone: tz }); // HH:MM:SS

  log.push({ date, time, status });

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const tmp = `${logPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(log, null, 2));
  fs.renameSync(tmp, logPath);
}

// ---------------------------------------------------------------------------
// Timezone helpers
// ---------------------------------------------------------------------------

/**
 * Convert a date+time string expressed in the given timezone to UTC milliseconds.
 * e.g. localTimeToUtcMs("2026-02-21", "19:00:00", "Europe/Oslo") → 18:00 UTC ms
 */
function localTimeToUtcMs(
  dateStr: string,
  timeStr: string,
  tz: string,
): number {
  // Step 1: treat date+time as UTC (approximate)
  const candidate = new Date(`${dateStr}T${timeStr}Z`);

  // Step 2: find what the candidate UTC time looks like in the target TZ
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const tzStr = formatter.format(candidate).replace(' ', 'T');

  // Step 3: correct — shift candidate by the TZ offset
  const offsetMs = candidate.getTime() - new Date(tzStr + 'Z').getTime();
  const corrected = new Date(candidate.getTime() + offsetMs);

  // Step 4: second iteration to handle DST edge cases
  const tzStr2 = formatter.format(corrected).replace(' ', 'T');
  const offsetMs2 = corrected.getTime() - new Date(tzStr2 + 'Z').getTime();
  return corrected.getTime() + offsetMs2;
}

// ---------------------------------------------------------------------------
// MedicationService
// ---------------------------------------------------------------------------

export class MedicationService {
  private reminderTimer: ReturnType<typeof setTimeout> | null = null;
  private followupTimer: ReturnType<typeof setTimeout> | null = null;
  private config: MedicationConfig | null = null;

  constructor(private deps: MedicationDeps) {}

  // ---- Lifecycle -----------------------------------------------------------

  start(): void {
    this.config = this._loadConfig();
    this._crashRecovery();
    this._scheduleNextReminder();
    logger.info('MedicationService started');
  }

  stop(): void {
    if (this.reminderTimer) {
      clearTimeout(this.reminderTimer);
      this.reminderTimer = null;
    }
    if (this.followupTimer) {
      clearTimeout(this.followupTimer);
      this.followupTimer = null;
    }
    logger.info('MedicationService stopped');
  }

  // ---- IPC-triggered actions -----------------------------------------------

  async fireReminder(): Promise<void> {
    this.reminderTimer = null;
    const config = this.config;
    if (!config?.active || !config.chatJid) {
      logger.warn('fireReminder: service not active or chatJid missing');
      return;
    }

    try {
      await this.deps.sendMessage(
        config.chatJid,
        'Time for your medication 💊 Reply: taken, snooze (9 min), later HH:MM',
      );
      appendToLog(this.deps.logPath, 'reminded', this.deps.tz);
    } catch (err) {
      logger.error({ err }, 'Failed to send medication reminder');
    }

    // Arm 15-minute follow-up
    if (this.followupTimer) clearTimeout(this.followupTimer);
    this.followupTimer = setTimeout(
      () => this._fireFollowup(),
      15 * 60 * 1000,
    );

    // Schedule the next daily reminder
    this._scheduleNextReminder();
  }

  async logTaken(): Promise<void> {
    appendToLog(this.deps.logPath, 'taken', this.deps.tz);
    if (this.followupTimer) {
      clearTimeout(this.followupTimer);
      this.followupTimer = null;
    }
    logger.info('Medication logged as taken');
  }

  async snooze(): Promise<void> {
    appendToLog(this.deps.logPath, 'snoozed', this.deps.tz);
    if (this.followupTimer) clearTimeout(this.followupTimer);
    this.followupTimer = setTimeout(
      () => this.fireReminder(),
      9 * 60 * 1000,
    );
    logger.info('Medication snoozed for 9 minutes');
  }

  async scheduleLater(hhmm: string): Promise<void> {
    const today = new Date().toLocaleDateString('sv-SE', {
      timeZone: this.deps.tz,
    });
    const targetUtcMs = localTimeToUtcMs(today, `${hhmm}:00`, this.deps.tz);
    const delayMs = targetUtcMs - Date.now();

    if (delayMs <= 0) {
      throw new Error(`Target time ${hhmm} has already passed today`);
    }

    if (this.followupTimer) clearTimeout(this.followupTimer);
    this.followupTimer = setTimeout(() => this.fireReminder(), delayMs);
    logger.info({ hhmm, delayMs }, 'Medication reminder scheduled for later');
  }

  async setSchedule(cron: string): Promise<void> {
    // Throws if cron is invalid
    CronExpressionParser.parse(cron, { tz: this.deps.tz });

    if (!this.config) {
      this.config = { schedule: cron, chatJid: '', active: true };
    } else {
      this.config.schedule = cron;
    }
    this._saveConfig(this.config);

    if (this.reminderTimer) {
      clearTimeout(this.reminderTimer);
      this.reminderTimer = null;
    }
    this._scheduleNextReminder();
    logger.info({ cron }, 'Medication schedule updated');
  }

  getStatus(): { today: DayStatus; log: LogEntry[] } {
    const log = readLog(this.deps.logPath);
    return { today: getTodayStatus(log, this.deps.tz), log };
  }

  // ---- Private helpers -----------------------------------------------------

  _loadConfig(): MedicationConfig | null {
    try {
      if (!fs.existsSync(this.deps.configPath)) return null;
      return JSON.parse(
        fs.readFileSync(this.deps.configPath, 'utf-8'),
      ) as MedicationConfig;
    } catch (err) {
      logger.error({ err }, 'Failed to load medication config');
      return null;
    }
  }

  private _saveConfig(cfg: MedicationConfig): void {
    const tmp = `${this.deps.configPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
    fs.renameSync(tmp, this.deps.configPath);
  }

  _crashRecovery(): void {
    const log = readLog(this.deps.logPath);
    const today = new Date().toLocaleDateString('sv-SE', {
      timeZone: this.deps.tz,
    });
    const todayEntries = log.filter((e) => e.date === today);

    // Find the last "reminded" with no subsequent "taken" or "missed"
    let lastReminderIdx = -1;
    for (let i = todayEntries.length - 1; i >= 0; i--) {
      if (todayEntries[i].status === 'reminded') {
        lastReminderIdx = i;
        break;
      }
    }
    if (lastReminderIdx === -1) return;

    const afterReminder = todayEntries.slice(lastReminderIdx + 1);
    const resolved = afterReminder.some(
      (e) => e.status === 'taken' || e.status === 'missed',
    );
    if (resolved) return;

    // Reminder fired without resolution — compute time elapsed
    const entry = todayEntries[lastReminderIdx];
    const reminderUtcMs = localTimeToUtcMs(entry.date, entry.time, this.deps.tz);
    const windowMs = 15 * 60 * 1000;
    const elapsed = Date.now() - reminderUtcMs;

    if (elapsed < windowMs) {
      const remaining = windowMs - elapsed;
      this.followupTimer = setTimeout(
        () => this._fireFollowup(),
        remaining,
      );
      logger.info(
        { remainingMs: remaining },
        'Crash recovery: armed follow-up timer',
      );
    } else {
      appendToLog(this.deps.logPath, 'missed', this.deps.tz);
      logger.info('Crash recovery: 15-min window passed, logged missed');
    }
  }

  private _scheduleNextReminder(): void {
    if (!this.config?.active) return;

    const delay = this._computeDelayUntilNextCron(this.config.schedule);
    if (delay === null) {
      logger.warn(
        { schedule: this.config.schedule },
        'Cannot compute next reminder time',
      );
      return;
    }

    this.reminderTimer = setTimeout(() => this.fireReminder(), delay);
    logger.info(
      { nextAt: new Date(Date.now() + delay).toISOString() },
      'Medication reminder scheduled',
    );
  }

  _computeDelayUntilNextCron(cronExpr: string): number | null {
    try {
      const interval = CronExpressionParser.parse(cronExpr, {
        tz: this.deps.tz,
      });
      const next = interval.next().toDate();
      return Math.max(0, next.getTime() - Date.now());
    } catch (err) {
      logger.error({ err, cronExpr }, 'Invalid cron expression');
      return null;
    }
  }

  private async _fireFollowup(): Promise<void> {
    this.followupTimer = null;
    const config = this.config;
    if (!config?.chatJid) return;

    try {
      await this.deps.sendMessage(
        config.chatJid,
        'Reminder: did you take your medication? 💊',
      );
      appendToLog(this.deps.logPath, 'missed', this.deps.tz);
    } catch (err) {
      logger.error({ err }, 'Failed to send medication follow-up');
    }
  }
}
