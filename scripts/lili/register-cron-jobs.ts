/**
 * Register Lili's cron jobs as recurring 'task' messages in her session
 * inbox. Mirror of scripts/lobby/register-cron-jobs.ts, with one difference:
 * the first run is scheduled at the *next* cron occurrence (interpreted in
 * America/Sao_Paulo, same as host-sweep), not `now + offset` — so registering
 * the jobs doesn't fire all of them at once.
 *
 * Usage:
 *   npx tsx scripts/lili/register-cron-jobs.ts --session <session-id>
 *
 * Reads cron-jobs.json + the shared _override-block.md + each promptFile,
 * builds content = JSON.stringify({prompt: <override>+<prompt>}), inserts each
 * as a recurring row with kind='task' (idempotent via INSERT OR REPLACE).
 */
import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';
import { toSqliteUtc } from '../../src/db/sqlite-utc.js';

const LILI_GROUP_ID = 'ag-1777716884403-tzmkqz';

export interface RegisterOptions {
  inboundDbPath: string;
  configPath: string;
  promptsDir: string;
}

interface JobConfig {
  id: string;
  kind: string;
  recurrence: string;
  promptFile: string;
}

export function registerCronJobs(opts: RegisterOptions): number {
  const config = JSON.parse(fs.readFileSync(opts.configPath, 'utf8')) as { jobs: JobConfig[] };
  const overridePath = path.join(opts.promptsDir, '_override-block.md');
  const overrideBlock = fs.readFileSync(overridePath, 'utf8');

  const db = new Database(opts.inboundDbPath);

  const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  let seq = maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);

  for (const job of config.jobs) {
    const procedural = fs.readFileSync(path.join(opts.promptsDir, job.promptFile), 'utf8');
    const prompt = overrideBlock + '\n\n' + procedural;
    const content = JSON.stringify({ prompt });

    // First run = next cron occurrence in BRT (matches host-sweep's recurrence
    // logic), so registering doesn't immediately fire every job.
    const interval = CronExpressionParser.parse(job.recurrence, { tz: 'America/Sao_Paulo' });
    const processAfter = toSqliteUtc(interval.next().toDate());
    const timestamp = toSqliteUtc(new Date());

    db.prepare(
      `INSERT OR REPLACE INTO messages_in
       (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after, recurrence)
       VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, ?)`,
    ).run(job.id, seq, job.kind, timestamp, content, processAfter, job.recurrence);

    seq += 2;
  }

  db.close();
  return config.jobs.length;
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const sessionIdx = args.indexOf('--session');
  if (sessionIdx === -1 || !args[sessionIdx + 1]) {
    console.error('Usage: npx tsx scripts/lili/register-cron-jobs.ts --session <session-id>');
    process.exit(1);
  }
  const sessionId = args[sessionIdx + 1];

  const inboundDbPath = path.join(process.cwd(), 'data', 'v2-sessions', LILI_GROUP_ID, sessionId, 'inbound.db');
  if (!fs.existsSync(inboundDbPath)) {
    console.error(`Inbound DB not found: ${inboundDbPath}`);
    console.error(
      `Make sure the session exists. Run: sqlite3 data/v2.db "SELECT id FROM sessions WHERE agent_group_id='${LILI_GROUP_ID}';"`,
    );
    process.exit(1);
  }

  const configPath = path.join(process.cwd(), 'scripts', 'lili', 'cron-jobs.json');
  const promptsDir = path.join(process.cwd(), 'groups', 'lili', 'scheduled-jobs');

  const count = registerCronJobs({ inboundDbPath, configPath, promptsDir });

  console.log(`✅ ${count} cron jobs registered in ${inboundDbPath}`);
  console.log(
    '   Verify: sqlite3 ' +
      inboundDbPath +
      ' "SELECT id, kind, recurrence, datetime(process_after) FROM messages_in WHERE recurrence IS NOT NULL;"',
  );
}
