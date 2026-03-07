#!/usr/bin/env node
/**
 * Creates or replaces nightly memory consolidation tasks for all registered groups.
 * Run this script to install or update consolidation tasks after changes to the prompt.
 *
 * Usage: node scripts/schedule-consolidation.js
 */

import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import { randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'store', 'messages.db');
const SCHEDULE = '0 23 * * *'; // 11:00 PM nightly
const TIMEZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// The consolidation prompt — given to Jorgenclaw as a scheduled task
const CONSOLIDATION_PROMPT = `This is your nightly memory consolidation. This is internal maintenance — do NOT send any message to the user.

## Your job

Review today's conversation (in your current session context) and write structured notes to your workspace. This is how you maintain continuity across sessions. Do it carefully.

---

## Step 1 — Write today's daily summary

Create or update the file: /workspace/group/conversations/YYYY-MM-DD.md
(Use today's actual date in the filename)

Use exactly this structure:

\`\`\`markdown
# YYYY-MM-DD — Daily Summary

## Topics Discussed
- [one bullet per major topic or task]

## Decisions Made
- [conclusions reached, choices confirmed, things agreed upon]

## Facts Learned
- [anything new you learned about this person — preferences, situation, context, relationships]

## Tasks Completed
- [things actually delivered or resolved today]

## Open Loops
- [things mentioned but unresolved, follow-ups needed, promises made]

## Key Context for Next Session
[2-3 sentences max. The most important things a fresh instance of you needs to know to pick up where we left off. Write this as if briefing yourself.]
\`\`\`

Rules for this file:
- Be concise. These notes are for you to scan quickly, not for display to the user.
- No raw transcripts. Synthesize, don't dump.
- If today was quiet with nothing notable, write a brief note saying so — don't skip the file.
- Check if the file already exists before creating it (earlier consolidation may have run).

---

## Step 2 — Update your memory files

Read the /workspace/group/memory/ folder. Update or create these files as needed:

**contacts.md** — Everyone mentioned in conversations. For each person:
- Name, relationship to the user
- Key facts (job, family, preferences, context)
- Last mentioned date

**preferences.md** — What you know about this user's preferences, habits, communication style, recurring interests, things they like or dislike. Update when you learn something new.

**ongoing.md** — Active projects, open questions, things in progress. Remove items that are resolved. Add new ones from today's Open Loops.

Only update a file if you actually have new information to add or corrections to make. Don't rewrite files unnecessarily.

---

## Step 3 — Update the memory index

Write /workspace/group/memory/index.md — a brief index of what each memory file contains and when it was last updated. Keep this under 30 lines. This is the first thing you should read at the start of every session to orient yourself.

---

## Important rules

- This task runs silently. Do not message the user.
- Never include raw conversation transcripts in any memory file.
- Write files that a future instance of you can read in under 30 seconds to get fully oriented.
- If the /workspace/group/memory/ folder does not exist, create it.
- Always write the daily summary even if it is brief.`;

function makeTaskId() {
  return `consolidation-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

function nextRun() {
  const interval = CronExpressionParser.parse(SCHEDULE, { tz: TIMEZONE });
  return interval.next().toISOString();
}

const db = new Database(DB_PATH);

// Get all registered groups
const groups = db.prepare('SELECT jid, name, folder FROM registered_groups').all();
console.log(`Found ${groups.length} registered groups`);

for (const group of groups) {
  // Remove any existing consolidation task for this group
  const deleted = db.prepare(
    `DELETE FROM scheduled_tasks WHERE group_folder = ? AND id LIKE 'consolidation-%'`
  ).run(group.folder);

  if (deleted.changes > 0) {
    console.log(`  [${group.folder}] Replaced ${deleted.changes} existing consolidation task(s)`);
  }

  // Insert new task
  const taskId = makeTaskId();
  db.prepare(`
    INSERT INTO scheduled_tasks
      (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, next_run, status, created_at, context_mode)
    VALUES (?, ?, ?, ?, 'cron', ?, ?, 'active', ?, 'group')
  `).run(
    taskId,
    group.folder,
    group.jid,
    CONSOLIDATION_PROMPT,
    SCHEDULE,
    nextRun(),
    new Date().toISOString(),
  );

  console.log(`  [${group.folder}] Created consolidation task ${taskId} — next run: ${nextRun()}`);
}

console.log('\nDone. Consolidation tasks scheduled at 11:00 PM nightly for all groups.');
db.close();
