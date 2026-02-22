import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock logger to keep test output clean
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import {
  MedicationService,
  appendToLog,
  getTodayStatus,
  parseReply,
  readLog,
} from './medication-service.js';

const TZ = 'UTC'; // Use UTC in tests to avoid system-TZ complexity

// ---------------------------------------------------------------------------
// parseReply
// ---------------------------------------------------------------------------

describe('parseReply', () => {
  it('parses "taken"', () => {
    expect(parseReply('taken')).toEqual({ type: 'taken' });
  });

  it('parses "TAKEN" (case insensitive)', () => {
    expect(parseReply('TAKEN')).toEqual({ type: 'taken' });
  });

  it('parses "snooze"', () => {
    expect(parseReply('snooze')).toEqual({ type: 'snooze' });
  });

  it('parses "SNOOZE" (case insensitive)', () => {
    expect(parseReply('SNOOZE')).toEqual({ type: 'snooze' });
  });

  it('parses "later 21:00"', () => {
    expect(parseReply('later 21:00')).toEqual({
      type: 'later',
      hhmm: '21:00',
    });
  });

  it('parses "later 9:05" and pads to "09:05"', () => {
    expect(parseReply('later 9:05')).toEqual({ type: 'later', hhmm: '09:05' });
  });

  it('parses "later 23:59"', () => {
    expect(parseReply('later 23:59')).toEqual({
      type: 'later',
      hhmm: '23:59',
    });
  });

  it('parses "later 0:00"', () => {
    expect(parseReply('later 0:00')).toEqual({ type: 'later', hhmm: '00:00' });
  });

  it('rejects "later 25:00" (hour out of range)', () => {
    expect(parseReply('later 25:00')).toBeNull();
  });

  it('rejects "later 24:00" (hour out of range)', () => {
    expect(parseReply('later 24:00')).toBeNull();
  });

  it('rejects "later abc" (not a time)', () => {
    expect(parseReply('later abc')).toBeNull();
  });

  it('rejects "foo" (unrecognised text)', () => {
    expect(parseReply('foo')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(parseReply('')).toBeNull();
  });

  it('strips leading/trailing whitespace', () => {
    expect(parseReply('  taken  ')).toEqual({ type: 'taken' });
  });
});

// ---------------------------------------------------------------------------
// getTodayStatus
// ---------------------------------------------------------------------------

describe('getTodayStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // 2026-02-21 12:00:00 UTC
    vi.setSystemTime(new Date('2026-02-21T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "none" for empty log', () => {
    expect(getTodayStatus([], TZ)).toBe('none');
  });

  it('returns "reminded" when only reminded today', () => {
    const log = [{ date: '2026-02-21', time: '12:00:00', status: 'reminded' as const }];
    expect(getTodayStatus(log, TZ)).toBe('reminded');
  });

  it('returns "snoozed" when reminded then snoozed', () => {
    const log = [
      { date: '2026-02-21', time: '12:00:00', status: 'reminded' as const },
      { date: '2026-02-21', time: '12:01:00', status: 'snoozed' as const },
    ];
    expect(getTodayStatus(log, TZ)).toBe('snoozed');
  });

  it('returns "taken" when reminded then taken', () => {
    const log = [
      { date: '2026-02-21', time: '12:00:00', status: 'reminded' as const },
      { date: '2026-02-21', time: '12:02:00', status: 'taken' as const },
    ];
    expect(getTodayStatus(log, TZ)).toBe('taken');
  });

  it('returns "missed" when reminded then missed', () => {
    const log = [
      { date: '2026-02-21', time: '12:00:00', status: 'reminded' as const },
      { date: '2026-02-21', time: '12:15:00', status: 'missed' as const },
    ];
    expect(getTodayStatus(log, TZ)).toBe('missed');
  });

  it('"taken" takes priority over "missed"', () => {
    const log = [
      { date: '2026-02-21', time: '12:00:00', status: 'reminded' as const },
      { date: '2026-02-21', time: '12:15:00', status: 'missed' as const },
      { date: '2026-02-21', time: '12:16:00', status: 'taken' as const },
    ];
    expect(getTodayStatus(log, TZ)).toBe('taken');
  });

  it('ignores entries from other dates', () => {
    const log = [
      { date: '2026-02-20', time: '19:00:00', status: 'taken' as const },
    ];
    expect(getTodayStatus(log, TZ)).toBe('none');
  });

  it('ignores yesterday entries when computing today status', () => {
    const log = [
      { date: '2026-02-20', time: '19:00:00', status: 'reminded' as const },
      { date: '2026-02-21', time: '12:00:00', status: 'snoozed' as const },
    ];
    expect(getTodayStatus(log, TZ)).toBe('snoozed');
  });
});

// ---------------------------------------------------------------------------
// readLog / appendToLog
// ---------------------------------------------------------------------------

describe('readLog', () => {
  it('returns [] for missing file', () => {
    expect(readLog('/tmp/nonexistent-med-log-xyz.json')).toEqual([]);
  });

  it('parses existing entries', () => {
    const tmpFile = path.join(os.tmpdir(), `med-test-${Date.now()}.json`);
    const entries = [
      { date: '2026-02-21', time: '19:00:00', status: 'reminded' as const },
    ];
    fs.writeFileSync(tmpFile, JSON.stringify(entries));
    try {
      expect(readLog(tmpFile)).toEqual(entries);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });
});

describe('appendToLog', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'med-append-'));
    logPath = path.join(tmpDir, 'medication-log.json');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('creates file if missing', () => {
    vi.setSystemTime(new Date('2026-02-21T10:00:00.000Z'));
    appendToLog(logPath, 'reminded', TZ);
    const log = readLog(logPath);
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe('reminded');
    expect(log[0].date).toBe('2026-02-21');
  });

  it('appends to existing file', () => {
    vi.setSystemTime(new Date('2026-02-21T10:00:00.000Z'));
    appendToLog(logPath, 'reminded', TZ);
    vi.setSystemTime(new Date('2026-02-21T10:02:00.000Z'));
    appendToLog(logPath, 'taken', TZ);
    const log = readLog(logPath);
    expect(log).toHaveLength(2);
    expect(log[0].status).toBe('reminded');
    expect(log[1].status).toBe('taken');
  });

  it('date uses the given timezone (UTC midnight boundary)', () => {
    // 2026-02-21T23:05:00 UTC = 2026-02-22T00:05:00 in Europe/Oslo (UTC+1)
    vi.setSystemTime(new Date('2026-02-21T23:05:00.000Z'));
    appendToLog(logPath, 'reminded', 'Europe/Oslo');
    const log = readLog(logPath);
    expect(log[0].date).toBe('2026-02-22');
  });

  it('date uses the given timezone — UTC day is still previous day', () => {
    // 2026-02-21T22:55:00 UTC = 2026-02-21T23:55:00 in Europe/Oslo (same day)
    vi.setSystemTime(new Date('2026-02-21T22:55:00.000Z'));
    appendToLog(logPath, 'reminded', 'Europe/Oslo');
    const log = readLog(logPath);
    expect(log[0].date).toBe('2026-02-21');
  });
});

// ---------------------------------------------------------------------------
// MedicationService
// ---------------------------------------------------------------------------

describe('MedicationService', () => {
  let tmpDir: string;
  let logPath: string;
  let configPath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sendMessageSpy: ReturnType<typeof vi.fn>;
  let sendMessage: (jid: string, text: string) => Promise<void>;
  let service: MedicationService;

  function makeService(chatJid = 'test-jid', active = true) {
    return new MedicationService({ sendMessage, logPath, configPath, tz: TZ });
  }

  function writeConfig(overrides: Partial<{ schedule: string; chatJid: string; active: boolean }> = {}) {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        schedule: '0 19 * * *',
        chatJid: 'test-jid',
        active: true,
        ...overrides,
      }),
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // Start at a fixed point: 2026-02-21 12:00:00 UTC (well before 19:00)
    vi.setSystemTime(new Date('2026-02-21T12:00:00.000Z'));

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'med-svc-'));
    logPath = path.join(tmpDir, 'medication-log.json');
    configPath = path.join(tmpDir, 'medication-config.json');
    sendMessageSpy = vi.fn().mockResolvedValue(undefined);
    sendMessage = sendMessageSpy as unknown as (jid: string, text: string) => Promise<void>;

    writeConfig();
    service = makeService();
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true });
  });

  // ---- fireReminder --------------------------------------------------------

  it('fireReminder sends correct message text', async () => {
    service.start();
    await service.fireReminder();

    expect(sendMessageSpy).toHaveBeenCalledWith(
      'test-jid',
      'Time for your medication 💊 Reply: taken, snooze (9 min), later HH:MM',
    );
  });

  it('fireReminder appends "reminded" to log', async () => {
    service.start();
    await service.fireReminder();

    const log = readLog(logPath);
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe('reminded');
  });

  it('fireReminder arms follow-up timer at t+15min', async () => {
    service.start();
    await service.fireReminder();

    // Advance 14:59 — follow-up should NOT have fired
    await vi.advanceTimersByTimeAsync(14 * 60 * 1000 + 59 * 1000);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1); // only the initial reminder

    // Advance 1 more second — follow-up fires
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendMessageSpy).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith(
      'test-jid',
      'Reminder: did you take your medication? 💊',
    );
  });

  it('fireReminder follow-up appends "missed"', async () => {
    service.start();
    await service.fireReminder();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    const log = readLog(logPath);
    expect(log.some((e) => e.status === 'missed')).toBe(true);
  });

  // ---- logTaken ------------------------------------------------------------

  it('logTaken appends "taken" and disarms follow-up', async () => {
    service.start();
    await service.fireReminder();
    await service.logTaken();

    // Advance past 15 min — follow-up should NOT fire
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    const log = readLog(logPath);
    expect(log.some((e) => e.status === 'taken')).toBe(true);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1); // only the reminder, no follow-up
  });

  // ---- snooze --------------------------------------------------------------

  it('snooze appends "snoozed" and arms follow-up at t+9min', async () => {
    service.start();
    await service.fireReminder();
    sendMessageSpy.mockClear();

    await service.snooze();

    const log = readLog(logPath);
    expect(log.some((e) => e.status === 'snoozed')).toBe(true);

    // Advance 8:59 — no new reminder yet
    await vi.advanceTimersByTimeAsync(8 * 60 * 1000 + 59 * 1000);
    expect(sendMessageSpy).toHaveBeenCalledTimes(0);

    // Advance 1 more second — reminder fires again
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).toHaveBeenCalledWith(
      'test-jid',
      'Time for your medication 💊 Reply: taken, snooze (9 min), later HH:MM',
    );
  });

  // ---- scheduleLater -------------------------------------------------------

  it('scheduleLater arms reminder at the correct future time', async () => {
    // Current UTC: 12:00. scheduleLater("15:00") → delay = 3h = 10800000ms
    service.start();
    await service.scheduleLater('15:00');
    sendMessageSpy.mockClear();

    // Advance 2:59:59 — no reminder yet
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 59 * 60 * 1000 + 59 * 1000);
    expect(sendMessageSpy).toHaveBeenCalledTimes(0);

    // Advance 1 more second — reminder fires
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
  });

  it('scheduleLater rejects past times', async () => {
    // Current UTC: 12:00. Scheduling 10:00 should throw.
    service.start();
    await expect(service.scheduleLater('10:00')).rejects.toThrow();
  });

  // ---- State machine -------------------------------------------------------

  it('idle → reminded → taken (no follow-up)', async () => {
    service.start();
    await service.fireReminder();
    await service.logTaken();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const log = readLog(logPath);
    expect(log.map((e) => e.status)).toContain('taken');
  });

  it('idle → reminded → snoozed → reminded → taken', async () => {
    service.start();
    await service.fireReminder();
    await service.snooze();
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000); // snooze fires
    await service.logTaken();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000); // follow-up should NOT fire

    const log = readLog(logPath);
    const statuses = log.map((e) => e.status);
    expect(statuses).toContain('snoozed');
    expect(statuses).toContain('taken');
    // No duplicate follow-up message after taken
    expect(sendMessageSpy).toHaveBeenCalledTimes(2); // initial + snooze re-reminder
  });

  it('idle → reminded → follow-up → missed', async () => {
    service.start();
    await service.fireReminder();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    const log = readLog(logPath);
    expect(log.map((e) => e.status)).toContain('missed');
    expect(sendMessageSpy).toHaveBeenCalledTimes(2); // initial + follow-up
  });

  // ---- Crash recovery ------------------------------------------------------

  it('arms follow-up if "reminded" is <15min ago with no resolution', async () => {
    // Log a reminder from 5 minutes ago (UTC 11:55)
    const fiveMinAgo = new Date('2026-02-21T11:55:00.000Z');
    vi.setSystemTime(fiveMinAgo);
    appendToLog(logPath, 'reminded', TZ);
    vi.setSystemTime(new Date('2026-02-21T12:00:00.000Z')); // "now" = 5 min later

    service = makeService();
    service.start();

    // Advance 9:59 (total 14:59 since reminder) — follow-up should NOT have fired
    await vi.advanceTimersByTimeAsync(9 * 60 * 1000 + 59 * 1000);
    expect(sendMessageSpy).toHaveBeenCalledTimes(0);

    // Advance 1 more second — follow-up fires (total 15:00 since reminder)
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).toHaveBeenCalledWith(
      'test-jid',
      'Reminder: did you take your medication? 💊',
    );
  });

  it('logs "missed" immediately on start if 15-min window already passed', () => {
    // Log a reminder from 20 minutes ago
    const twentyMinAgo = new Date('2026-02-21T11:40:00.000Z');
    vi.setSystemTime(twentyMinAgo);
    appendToLog(logPath, 'reminded', TZ);
    vi.setSystemTime(new Date('2026-02-21T12:00:00.000Z'));

    service = makeService();
    service.start();

    const log = readLog(logPath);
    expect(log.some((e) => e.status === 'missed')).toBe(true);
  });

  it('does NOT arm follow-up if already taken', () => {
    const twentyMinAgo = new Date('2026-02-21T11:40:00.000Z');
    vi.setSystemTime(twentyMinAgo);
    appendToLog(logPath, 'reminded', TZ);
    appendToLog(logPath, 'taken', TZ);
    vi.setSystemTime(new Date('2026-02-21T12:00:00.000Z'));

    service = makeService();
    service.start();

    const log = readLog(logPath);
    // Should not have appended an extra "missed"
    expect(log.filter((e) => e.status === 'missed')).toHaveLength(0);
  });

  // ---- setSchedule ---------------------------------------------------------

  it('setSchedule updates config and reschedules', async () => {
    service.start();
    await service.setSchedule('0 20 * * *');

    const cfg = service._loadConfig();
    expect(cfg?.schedule).toBe('0 20 * * *');
  });

  it('setSchedule throws on invalid cron', async () => {
    service.start();
    await expect(service.setSchedule('not a cron')).rejects.toThrow();
  });

  // ---- getStatus -----------------------------------------------------------

  it('getStatus returns correct today status', async () => {
    service.start();
    await service.fireReminder();
    await service.logTaken();

    const status = service.getStatus();
    expect(status.today).toBe('taken');
    expect(status.log.length).toBeGreaterThan(0);
  });

  // ---- No config -----------------------------------------------------------

  it('fireReminder does nothing if config is missing', async () => {
    fs.unlinkSync(configPath);
    service = makeService();
    service.start();
    await service.fireReminder();

    expect(sendMessageSpy).toHaveBeenCalledTimes(0);
  });

  it('fireReminder does nothing if active is false', async () => {
    writeConfig({ active: false });
    service = makeService();
    service.start();
    await service.fireReminder();

    expect(sendMessageSpy).toHaveBeenCalledTimes(0);
  });
});
