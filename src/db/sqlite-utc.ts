/**
 * Format a Date as 'YYYY-MM-DD HH:MM:SS' in UTC — matches the output of
 * SQLite's datetime('now') so string comparisons like
 *   WHERE process_after <= datetime('now')
 * compare correctly. Do NOT use Date.toISOString() for any TEXT column you
 * intend to compare against datetime('now'): 'T' > ' ' in ASCII, so an ISO
 * timestamp never satisfies the predicate until well after its intended time.
 * See commit 1c20a71 (Plan 2 fix in scripts/finance/register-cron-jobs.ts)
 * and Plan 2.6 spec §2 (Bug C) for full context.
 */
export function toSqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}
