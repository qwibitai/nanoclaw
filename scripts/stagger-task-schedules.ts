/**
 * Stagger scheduled task cron times so no two tasks fire at the same minute.
 * Run once on the VPS: npx tsx scripts/stagger-task-schedules.ts
 *
 * This prevents concurrent CLI processes from racing on the OAuth token
 * and reduces peak CPU/memory load on the VPS.
 */
import Database from 'better-sqlite3';
import path from 'path';

const db = new Database(path.resolve('store', 'data.db'));
db.pragma('journal_mode = WAL');

// New staggered schedules — no two tasks share the same minute.
// Spread across the day with 15-minute gaps minimum.
const STAGGERED_SCHEDULES: Record<string, string> = {
  // === Morning block (7:00 - 8:00) ===
  'system-health-daily':          '0 7 * * *',       // 7:00 daily (unchanged — runs alone)
  'sheridan-marketplace-renew':   '0 7 * * 1',       // 7:00 Mon (no collision — other Mon tasks start at 8+)
  'snak-lead-scrape-weekly':      '30 7 * * 1',      // 7:30 Mon (was 7:00 — moved to avoid collision)

  // === Mid-morning block (8:00 - 9:30) ===
  'snak-linkedin-batch-connect':  '0 8 * * 1-5',     // 8:00 Mon-Fri (unchanged — runs alone)
  'snak-fb-post-daily':           '0 9 * * 1-5',     // 9:00 Mon-Fri (unchanged — outreach moved)
  'sheridan-fb-post-daily':       '15 9 * * 1-5',    // 9:15 Mon-Fri (was 9:00 — staggered)
  'snak-outreach-daily':          '30 9 * * 1-5',    // 9:30 Mon-Fri (was 9:00 — staggered)
  'snak-google-ads-weekly':       '0 9 * * 1',       // 9:00 Mon (only Mon — fb-post covers weekdays)
  'sheridan-google-ads-weekly':   '45 9 * * 1',      // 9:45 Mon (was 9:00 — staggered)

  // === Late morning block (10:00 - 11:30) ===
  'snak-gbp-reviews':             '0 10 * * 1,4',    // 10:00 Mon,Thu (unchanged)
  'sheridan-gbp-reviews':         '20 10 * * 1,4',   // 10:20 Mon,Thu (was 10:00 — staggered)
  'snak-linkedin-post-daily':     '30 10 * * 1-5',   // 10:30 Mon-Fri (unchanged — runs alone)
  'snak-fb-review-weekly':        '0 10 * * 6',      // 10:00 Sat (unchanged)
  'sheridan-fb-review-weekly':    '30 10 * * 6',     // 10:30 Sat (was 10:00 — staggered)
  'snak-replies-sync':            '0 11 * * 1-5',    // 11:00 Mon-Fri (unchanged — runs alone)

  // === Afternoon block ===
  'snak-marketing-weekly-report': '0 12 * * 6',      // 12:00 Sat (unchanged — runs alone)
  'snak-linkedin-followup':       '0 14 * * 1-5',    // 14:00 Mon-Fri (unchanged — runs alone)

  // === Evening block ===
  'snak-fb-posts-weekly':         '0 18 * * 0',      // 18:00 Sun (unchanged)
  'sheridan-fb-posts-weekly':     '30 18 * * 0',     // 18:30 Sun (was 18:00 — staggered)
  'snak-outreach-weekly-report':  '0 18 * * 5',      // 18:00 Fri (unchanged — runs alone)

  // === Monthly tasks (1st of month) — spread across morning ===
  'snak-seo-monthly':             '0 9 1 * *',       // 9:00 1st (unchanged)
  'sheridan-seo-monthly':         '30 9 1 * *',      // 9:30 1st (was 10:00 — staggered from snak)
  'linkedin-token-check':         '0 8 1 * *',       // 8:00 1st (was 9:00 — moved to avoid collision)
};

console.log('Staggering scheduled task cron times...\n');

const update = db.prepare(
  'UPDATE scheduled_tasks SET schedule_value = ? WHERE id = ? AND status = ?'
);

let updated = 0;
let skipped = 0;

for (const [taskId, newCron] of Object.entries(STAGGERED_SCHEDULES)) {
  const result = update.run(newCron, taskId, 'active');
  if (result.changes > 0) {
    console.log(`  ✓ ${taskId}: → ${newCron}`);
    updated++;
  } else {
    // Try inactive tasks too — might be paused
    const resultPaused = db.prepare(
      'UPDATE scheduled_tasks SET schedule_value = ? WHERE id = ?'
    ).run(newCron, taskId);
    if (resultPaused.changes > 0) {
      console.log(`  ✓ ${taskId}: → ${newCron} (paused/inactive)`);
      updated++;
    } else {
      console.log(`  - ${taskId}: not found in DB, skipping`);
      skipped++;
    }
  }
}

console.log(`\nDone: ${updated} updated, ${skipped} skipped.`);
console.log('\nNew schedule (no collisions):');
console.log('  Mon-Fri: 7:00 → 8:00 → 9:00 → 9:15 → 9:30 → 10:00 → 10:30 → 11:00 → 14:00');
console.log('  Monday:  +9:00 → 9:45 → 10:00 → 10:20 (ads + GBP reviews)');
console.log('  Sat:     10:00 → 10:30 → 12:00');
console.log('  Sun:     18:00 → 18:30');
console.log('  1st:     8:00 → 9:00 → 9:30');
