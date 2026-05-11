/**
 * Remove the 5 finance cron jobs from the agent's session inbox.
 *
 * Usage:
 *   npx tsx scripts/finance/unregister-cron-jobs.ts --session <session-id>
 *
 * Use for teardown or to reset before re-registering.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const TASK_IDS = [
  'task-finance-sweep',
  'task-finance-daily',
  'task-finance-weekly',
  'task-finance-monthly',
  'task-finance-rollover',
];

const args = process.argv.slice(2);
const sessionIdx = args.indexOf('--session');
if (sessionIdx === -1 || !args[sessionIdx + 1]) {
  console.error('Usage: npx tsx scripts/finance/unregister-cron-jobs.ts --session <session-id>');
  process.exit(1);
}
const sessionId = args[sessionIdx + 1];

const inboundDbPath = path.join(process.cwd(), 'data', 'v2-sessions', 'finance', sessionId, 'inbound.db');
if (!fs.existsSync(inboundDbPath)) {
  console.error(`Inbound DB not found: ${inboundDbPath}`);
  process.exit(1);
}

const db = new Database(inboundDbPath);
const placeholders = TASK_IDS.map(() => '?').join(',');
const result = db.prepare(`DELETE FROM messages_in WHERE id IN (${placeholders})`).run(...TASK_IDS);
db.close();

console.log(`✅ Removed ${result.changes} cron task(s) from ${inboundDbPath}`);
