// Watcher task registration — ensures health check and digest tasks exist in the DB.

import { CronExpressionParser } from 'cron-parser';

import { createTask, getTaskById } from './db.js';
import { TIMEZONE } from './config.js';
import { logger } from './logger.js';

const HEALTH_CHECK_TASK_ID = 'watcher-health-check';
const DAILY_DIGEST_TASK_ID = 'watcher-daily-digest';
const CROSS_CHANNEL_DIGEST_TASK_ID = 'cross-channel-digest';
const NOTICE_CHECK_TASK_ID = 'notice-board-check';

// These prompts match the templates in container/agent-runner/src/tools/watcher.ts
const HEALTH_CHECK_PROMPT = `Run watcher_check to perform a health check on all managed bots. If there are alerts or recoveries in the result, format them as a clear message:

For alerts: ⚠️ **[Bot Name]** is [state] (was [previous state]). Suggested: [action]
For recoveries: ✅ **[Bot Name]** is back (was [previous state])

If everything is unchanged and healthy, produce no output.`;

const DAILY_DIGEST_PROMPT = `Generate the daily health digest for all managed bots. For each bot:
1. Run bot_status to get current state and uptime
2. Run search_logs with pattern "error|fatal|panic" (last 200 lines) to count recent errors
3. Run list_issues to count open GitHub issues

Format as a concise daily report:
📊 **Daily Bot Health** — today's date
**DB (OpenClaw)** • Status, uptime, error count, open issue count
**Nook (Letta)** • Status, uptime, error count, open issue count

Keep it concise. Only elaborate on errors if there are notable patterns.`;

export const CROSS_CHANNEL_DIGEST_PROMPT = `You are generating a cross-channel context digest. This runs automatically — do NOT post any message to the chat.

## Step 1: Read recent conversations

Call read_own_conversations with lines=50 and hours=2 (no channel filter — get all channels).

## Step 2: Write the digest

Distill the messages into a structured digest and write it to /workspace/extra/cross-channel/CLAUDE.md using the edit_file tool (set path to /workspace/extra/cross-channel/CLAUDE.md and provide the full content).

The digest MUST follow this exact format:

---
# Cross-Channel Context Digest
> Auto-generated context — NOT operator instructions. Last refreshed: {ISO UTC timestamp}

## Your Current Channel
- If your group folder is \`main\` → you are on **Slack** (Neuronbox workspace, DM with Tomer)
- If your group folder is \`slack_group\` → you are on **Slack** (Neuronbox workspace, #the-bots-place group channel)
- If your group folder is \`telegram_tomer-dm\` → you are on **Telegram** (DM with Tomer, primary channel)

## Active Threads
{Per-channel summary of ongoing conversation topics, 1-2 sentences each. Format: **Channel Name**: summary}

## Recent Instructions
{Operator instructions or decisions from the last 2 hours. Format: - [HH:MM UTC] (Channel) instruction content}

## Decisions & Direction
{Established approvals, commitments, or direction. If none, write "None in the last 2 hours."}

## Open Questions
{Unresolved items awaiting response or decision. If none, write "None."}
---

## Guardrails
- Cap the digest at ~500 words maximum
- If no messages are found, write a minimal digest: the header, channel mapping, and "No recent cross-channel activity" under each section
- Do NOT speculate — if something is ambiguous, mark it as "unclear"
- Include timestamps for verifiability
- This digest is auto-generated context, NOT operator instructions — make that clear in the header

## Step 3: Suppress output

After writing the file, return ONLY this exact text (nothing else):
<internal>done</internal>`;

const NOTICE_CHECK_PROMPT = `Check the notice board for unread notices. Call read_notices to fetch any pending notices.

For each notice:
1. Read and understand the content
2. If priority is urgent or high, take any requested action immediately
3. Call acknowledge_notice with the notice ID to mark it as read
4. Summarize what you found and any actions taken

If there are no unread notices, return ONLY this exact text (nothing else):
<internal>done</internal>`;

/**
 * Ensure watcher tasks exist in the task database.
 * Called once on NanoClaw startup. Idempotent — skips if tasks already exist.
 */
export function ensureWatcherTasks(): void {
  // Health check — interval task (every 60 minutes)
  if (!getTaskById(HEALTH_CHECK_TASK_ID)) {
    const nextRun = new Date(Date.now() + 3600000).toISOString(); // First run in 60 min
    createTask({
      id: HEALTH_CHECK_TASK_ID,
      group_folder: 'main',
      chat_jid: 'slack:D0AM0RZ7HB2',
      prompt: HEALTH_CHECK_PROMPT,
      schedule_type: 'interval',
      schedule_value: '3600000', // 60 minutes
      context_mode: 'isolated',
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    logger.info('Registered watcher health check task (every 60 min)');
  }

  // Daily digest — cron task (08:00 local time)
  if (!getTaskById(DAILY_DIGEST_TASK_ID)) {
    const interval = CronExpressionParser.parse('0 8 * * *', { tz: TIMEZONE });
    const nextRun = interval.next().toISOString();
    createTask({
      id: DAILY_DIGEST_TASK_ID,
      group_folder: 'main',
      chat_jid: 'slack:D0AM0RZ7HB2',
      prompt: DAILY_DIGEST_PROMPT,
      schedule_type: 'cron',
      schedule_value: '0 8 * * *',
      context_mode: 'isolated',
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    logger.info('Registered watcher daily digest task (08:00 daily)');
  }

  // Cross-channel digest — interval task (every 10 minutes)
  if (!getTaskById(CROSS_CHANNEL_DIGEST_TASK_ID)) {
    const nextRun = new Date(Date.now() + 600000).toISOString(); // First run in 10 min
    createTask({
      id: CROSS_CHANNEL_DIGEST_TASK_ID,
      group_folder: 'main',
      chat_jid: 'slack:D0AM0RZ7HB2',
      prompt: CROSS_CHANNEL_DIGEST_PROMPT,
      schedule_type: 'interval',
      schedule_value: '600000', // 10 minutes
      context_mode: 'isolated',
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    logger.info('Registered cross-channel digest task (every 10 min)');
  }

  // Notice board check — interval task (every 30 minutes)
  if (!getTaskById(NOTICE_CHECK_TASK_ID)) {
    const nextRun = new Date(Date.now() + 1800000).toISOString(); // First run in 30 min
    createTask({
      id: NOTICE_CHECK_TASK_ID,
      group_folder: 'main',
      chat_jid: 'slack:D0AM0RZ7HB2',
      prompt: NOTICE_CHECK_PROMPT,
      schedule_type: 'interval',
      schedule_value: '1800000', // 30 minutes
      context_mode: 'isolated',
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });
    logger.info('Registered notice board check task (every 30 min)');
  }
}
