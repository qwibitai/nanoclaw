#!/usr/bin/env tsx
/**
 * Seed the daily 6AM orchestrator scheduled task into NanoClaw's database.
 *
 * Usage:
 *   tsx scripts/seed-orchestrator.ts [--chat-jid <jid>] [--force]
 *
 * Defaults:
 *   --chat-jid: reads from registered_groups where is_main=1
 *   --force: replace existing orchestrator task if one exists
 *
 * Run this on the VPS after Phase 3 deploy, or locally for testing.
 */

import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';
import path from 'path';

const TASK_ID = 'atlas-orchestrator-daily';
const GROUP_FOLDER = 'atlas_main';
const SCHEDULE_TYPE = 'cron';
const SCHEDULE_VALUE = '0 6 * * *'; // 6AM daily
const TIMEZONE = process.env.TZ || 'America/New_York';

const ORCHESTRATOR_PROMPT = `[ORCHESTRATOR — Daily Morning Digest]

You are Atlas running the daily 6AM orchestrator task. Your job: gather system state
across all entities and produce a concise morning briefing for the CEO via Telegram.

*Step 1: Preflight* (governance module handles this — if you're reading this, you passed)

*Step 2: Gather data*

Read these files and summarize what you find:

1. Mode: /workspace/extra/atlas-state/state/mode.json
2. Graduation: /workspace/extra/atlas-state/autonomy/graduation-status.json
3. Quota: /workspace/extra/atlas-state/autonomy/quota-tracking.jsonl (today's entries)
4. Learning log: /workspace/extra/atlas-state/autonomy/learning-log.jsonl (last 24h)
5. Approval queue: list files in /workspace/extra/atlas-state/approval-queue/pending/
6. Audit logs: /workspace/extra/atlas-state/audit/ (each entity subfolder, today's file)
7. Entity profiles: /workspace/extra/atlas-entities/ (read entity-profile.md for each)
8. Agent performance: /workspace/extra/atlas-state/agent-performance/ (if exists)
9. Evolution log: /workspace/extra/atlas-state/evolution-log.jsonl (all entries since last retro — check /workspace/extra/atlas-state/state/last-retro-marker.json for cutoff, or use last 7 days if no marker)
10. Session count: /workspace/extra/atlas-state/hook-health/session-start.jsonl (count entries in last 7 days — this is how many CEO sessions happened)
11. System health: /workspace/extra/atlas-state/state/system-health.json (check for CRITICAL or WARNING status)

If a file doesn't exist, note it briefly and move on. Don't error out.

*Quiet-log check:* Compare session count (item 10) vs evolution log entries (item 9). If 5+ sessions happened but 0 friction events were logged, flag it: "Evolution log silent during N sessions — possible logging failure." This is important because a broken stop hook produces zero friction events, making everything look healthy when enforcement is actually dead.

*Step 3: Produce the digest*

Format for Telegram (no markdown headings — use *bold* for sections):

*Morning Briefing — {today's date}*

*Needs Your Attention*
{Pending approval items with context. Anomalies. Failures. Empty = "Nothing urgent."}

*Overnight Activity*
Sessions: {n} | Autonomous: {n} | Errors: {n}

*Entity Status*
- GPG: {healthy/watch/concern} — {1 line}
- Crownscape: {healthy/watch/concern} — {1 line}

*Graduation*
Milestone: {current} | Progress: {key metric}

*Evolution*
{n} friction events since last retro ({n} MAJOR, {n} MINOR) | {quiet-log warning if applicable}
{If 3+ events share a theme: "Recurring: {theme} ({n} times) — graduation candidate"}
{If system-health.json shows CRITICAL: "System health: CRITICAL — {detail}"}

*Quota*
{n} invocations | {weighted} weighted | {status}

*Priorities Today*
1. {Most important — specific, actionable}
2. {Second}
3. {Third}

Rules:
- Under 500 words
- Quantified — real numbers, not vague
- If data is missing, say "no data" not a paragraph explaining why
- If everything is healthy, keep it short: "All systems nominal"
- Priorities should reference actual pending work, not generic advice
`;

// --- Main ---

const args = process.argv.slice(2);
const force = args.includes('--force');
const chatJidIdx = args.indexOf('--chat-jid');
let chatJid = chatJidIdx >= 0 ? args[chatJidIdx + 1] : undefined;

// Find database
const dbPath = path.resolve('store', 'messages.db');
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at ${dbPath}`);
  console.error('Run this script from the NanoClaw project root.');
  process.exit(1);
}

const db = new Database(dbPath);

// Resolve chat_jid from registered groups if not provided
if (!chatJid) {
  const mainGroup = db.prepare(
    'SELECT jid FROM registered_groups WHERE is_main = 1 LIMIT 1'
  ).get() as { jid: string } | undefined;

  if (!mainGroup) {
    console.error('No main group found in registered_groups. Provide --chat-jid.');
    process.exit(1);
  }
  chatJid = mainGroup.jid;
  console.log(`Found main group: ${chatJid}`);
}

// Check if task already exists
const existing = db.prepare(
  'SELECT id, status FROM scheduled_tasks WHERE id = ?'
).get(TASK_ID) as { id: string; status: string } | undefined;

if (existing && !force) {
  console.log(`Orchestrator task already exists (status: ${existing.status}).`);
  console.log('Use --force to replace it.');
  process.exit(0);
}

// Compute next run
const interval = CronExpressionParser.parse(SCHEDULE_VALUE, { tz: TIMEZONE });
const nextRun = interval.next().toISOString();

// Upsert the task
if (existing) {
  db.prepare(`
    UPDATE scheduled_tasks
    SET prompt = ?, schedule_value = ?, next_run = ?, status = 'active'
    WHERE id = ?
  `).run(ORCHESTRATOR_PROMPT, SCHEDULE_VALUE, nextRun, TASK_ID);
  console.log(`Updated existing orchestrator task.`);
} else {
  db.prepare(`
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    TASK_ID,
    GROUP_FOLDER,
    chatJid,
    ORCHESTRATOR_PROMPT,
    SCHEDULE_TYPE,
    SCHEDULE_VALUE,
    'isolated', // Fresh context each run — no session carryover
    nextRun,
    'active',
    new Date().toISOString(),
  );
  console.log(`Created orchestrator task.`);
}

console.log(`  ID:       ${TASK_ID}`);
console.log(`  Group:    ${GROUP_FOLDER}`);
console.log(`  Chat JID: ${chatJid}`);
console.log(`  Schedule: ${SCHEDULE_VALUE} (${TIMEZONE})`);
console.log(`  Next run: ${nextRun}`);
console.log('');
console.log('Done. The orchestrator will run at 6AM daily.');

db.close();
