/**
 * Daily-backup scheduler. Designed to be poked from the host sweep tick
 * (every 60s) — `decideShouldBackup` is pure; the host side that wires
 * it up handles I/O, locking, and notification.
 *
 * Throttling rule:
 *   1. If `now` is before today's backup window (`<HH:00` in TIMEZONE),
 *      skip.
 *   2. If `last_attempt_at` is in today's window, skip — one attempt per
 *      day, success or fail. A user who wants to retry sooner runs
 *      `pnpm run backup --force` (which bypasses the throttle).
 *   3. Otherwise, run.
 */
import { BACKUP_ENABLED, BACKUP_HOUR, TIMEZONE } from '../config.js';
import { log } from '../log.js';
import { readBackupStatus } from './state.js';

export interface DecideShouldBackupArgs {
  now: Date;
  lastAttemptAt: string | null;
  backupHour: number;
  timezone: string;
}

export interface DecideShouldBackupResult {
  run: boolean;
  reason: string;
}

export function decideShouldBackup(args: DecideShouldBackupArgs): DecideShouldBackupResult {
  const { now, lastAttemptAt, backupHour, timezone } = args;
  const todayWindowStart = startOfDailyWindow(now, backupHour, timezone);

  if (now.getTime() < todayWindowStart.getTime()) {
    return { run: false, reason: "before today's backup window" };
  }
  if (lastAttemptAt) {
    const last = new Date(lastAttemptAt).getTime();
    if (last >= todayWindowStart.getTime()) {
      return { run: false, reason: "already attempted in today's window" };
    }
  }
  return { run: true, reason: 'eligible' };
}

/**
 * Start-of-window for "today" in the configured timezone, expressed as a
 * UTC Date. Uses Intl.DateTimeFormat to extract civil-time components in
 * the target zone — avoids pulling in a date-fns/luxon dep just for this.
 */
function startOfDailyWindow(now: Date, hour: number, timezone: string): Date {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
  // Build the candidate window-start in the local zone; convert via the
  // round-trip trick (parse the formatted string back as if local time, then
  // adjust for the zone offset by binary-searching one step).
  const isoLike = `${parts.year}-${parts.month}-${parts.day}T${String(hour).padStart(2, '0')}:00:00`;
  // Use Intl to get the offset for this timezone at that local time.
  // Trick: take the wall-clock time-as-UTC, then ask what the same wall-clock
  // is in the target zone, and offset by the difference.
  const asIfUtc = new Date(`${isoLike}Z`);
  const wallInZone = fmt.formatToParts(asIfUtc).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const wallStr =
    `${wallInZone.year}-${wallInZone.month}-${wallInZone.day}T` +
    `${wallInZone.hour}:${wallInZone.minute}:${wallInZone.second}Z`;
  const wallEpoch = new Date(wallStr).getTime();
  const offsetMs = wallEpoch - asIfUtc.getTime();
  return new Date(asIfUtc.getTime() - offsetMs);
}

/**
 * Called from the host sweep loop. Cheap when not eligible. When eligible,
 * runs `runDailyBackup()`; errors are logged and swallowed so a failed
 * backup doesn't poison the rest of the sweep.
 */
export async function maybeRunDailyBackup(): Promise<void> {
  if (!BACKUP_ENABLED) return;
  const status = readBackupStatus();
  const decision = decideShouldBackup({
    now: new Date(),
    lastAttemptAt: status.last_attempt_at,
    backupHour: BACKUP_HOUR,
    timezone: TIMEZONE,
  });
  if (!decision.run) return;

  log.info('Daily backup eligible — starting', { reason: decision.reason });
  const { runDailyBackup } = await import('./index.js');
  const result = await runDailyBackup({ force: false });
  if (!result.success) {
    log.error('Daily backup failed', { error: result.error });
  } else {
    log.info('Daily backup succeeded', { archive: result.archiveName, bytes: result.bytes });
  }
}
