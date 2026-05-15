/**
 * Register the 5 finance cron jobs as recurring 'task' messages in the agent's session inbox.
 *
 * Usage:
 *   npx tsx scripts/finance/register-cron-jobs.ts --session <session-id>
 *
 * The script:
 *   1. Reads cron-jobs.json (the 5 task definitions)
 *   2. Reads _override-block.md (shared non-interactive instructions)
 *   3. Reads each prompt file referenced by promptFile
 *   4. Builds content = JSON.stringify({prompt: <override>+<prompt>})
 *   5. Inserts each as a recurring row with kind='task' (idempotent via INSERT OR REPLACE)
 *
 * TODO(formatter-bug): the container's container/agent-runner/src/formatter.ts:80-105
 * has a generic silent-drop bug — any messages_in row with `kind` not in
 * (chat | chat-sdk | task | webhook | system) produces an empty prompt. We use
 * kind='task' here to piggyback the existing envelope, but a future plan should
 * either add a 'scheduled' / 'system_task' case to the formatter or document
 * the supported kinds at the schema level.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { toSqliteUtc } from '../../src/db/sqlite-utc.js';

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
  firstRunOffsetMs: number;
}

export function registerCronJobs(opts: RegisterOptions): void {
  const config = JSON.parse(fs.readFileSync(opts.configPath, 'utf8')) as { jobs: JobConfig[] };
  const overridePath = path.join(opts.promptsDir, '_override-block.md');
  const overrideBlock = fs.readFileSync(overridePath, 'utf8');

  const db = new Database(opts.inboundDbPath);

  // Compute seq base — use even seq (per nextEvenSeq pattern from session-db.ts)
  const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  let seq = maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);

  const now = Date.now();

  for (const job of config.jobs) {
    const procedural = fs.readFileSync(path.join(opts.promptsDir, job.promptFile), 'utf8');
    const prompt = overrideBlock + '\n\n' + procedural;
    const content = JSON.stringify({ prompt });

    const processAfter = toSqliteUtc(new Date(now + job.firstRunOffsetMs));
    const timestamp = toSqliteUtc(new Date());

    db.prepare(
      `INSERT OR REPLACE INTO messages_in
       (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after, recurrence)
       VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, ?)`,
    ).run(job.id, seq, job.kind, timestamp, content, processAfter, job.recurrence);

    seq += 2;
  }

  db.close();
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const sessionIdx = args.indexOf('--session');
  if (sessionIdx === -1 || !args[sessionIdx + 1]) {
    console.error('Usage: npx tsx scripts/finance/register-cron-jobs.ts --session <session-id>');
    process.exit(1);
  }
  const sessionId = args[sessionIdx + 1];

  const inboundDbPath = path.join(process.cwd(), 'data', 'v2-sessions', 'finance', sessionId, 'inbound.db');
  if (!fs.existsSync(inboundDbPath)) {
    console.error(`Inbound DB not found: ${inboundDbPath}`);
    console.error('Make sure the session exists. Run: sqlite3 data/v2.db "SELECT id FROM sessions WHERE agent_group_id=\'finance\';"');
    process.exit(1);
  }

  const configPath = path.join(process.cwd(), '.claude', 'skills', 'add-finance', 'cron-jobs.json');
  const promptsDir = path.join(process.cwd(), '.claude', 'skills', 'add-finance', 'prompts');

  registerCronJobs({ inboundDbPath, configPath, promptsDir });

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { jobs: unknown[] };
  console.log(`✅ ${config.jobs.length} cron jobs registered in ${inboundDbPath}`);
  console.log('   Verify: sqlite3 ' + inboundDbPath + ' "SELECT id, kind, recurrence, datetime(process_after) FROM messages_in WHERE recurrence IS NOT NULL;"');
}
