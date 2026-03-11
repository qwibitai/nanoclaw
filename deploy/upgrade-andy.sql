-- Andy Business Agent Upgrade — Scheduled Tasks
-- Run on VPS: sqlite3 /home/nanoclaw/nanoclaw/store/messages.db < deploy/upgrade-andy.sql

-- Schema migration: add model/budget columns for per-task overrides
-- (safe to re-run — ALTER TABLE fails silently if column exists in the app migration)

-- Stage 3: Automated Follow-up Tasks (weekdays 11 AM CT = 17:00 UTC)

-- Snak Group follow-ups
INSERT OR IGNORE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'snak-followup-daily',
  'snak-group',
  '__scheduled__',
  'Run daily follow-up check. Use crm-query to find leads needing follow-up (follow-up --days 3 --limit 5). For each lead, check their pipeline stage to tailor the message. Check the contact''s channel_source — if WhatsApp, reply via send_message; if email, use send-email; if SMS, skip (note for manual follow-up). Keep follow-ups short, warm, and conversational. Max 3 total touches per lead. After sending each follow-up, log the outreach. Do NOT send a progress report — just do the work silently.',
  'cron',
  '0 17 * * 1-5',
  'group',
  datetime('now'),
  'active',
  datetime('now')
);

-- Sheridan Rentals follow-ups
INSERT OR IGNORE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'sheridan-followup-daily',
  'sheridan-rentals',
  '__scheduled__',
  'Run daily follow-up check. Use crm-query to find leads needing follow-up (follow-up --days 3 --limit 5). For each lead, check their pipeline stage to tailor the message. Check the contact''s channel_source — if WhatsApp, reply via send_message; if email, use send-email; if SMS, skip (note for manual follow-up). Keep follow-ups short, warm, and conversational. Max 3 total touches per lead. After sending each follow-up, log the outreach. Do NOT send a progress report — just do the work silently.',
  'cron',
  '0 17 * * 1-5',
  'group',
  datetime('now'),
  'active',
  datetime('now')
);

-- Stage 4: Enhanced Daily Briefings
-- Update existing digest tasks to 8 AM CT (14:00 UTC) with enhanced prompts
-- If no existing digest exists, create new ones

-- Snak Group daily briefing
INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'snak-daily-briefing',
  'snak-group',
  '__scheduled__',
  'Generate and email the daily business briefing to the owner. Include ALL of these sections:

1. *Overnight Leads* — Check CRM for new contacts in the last 24 hours. Show name, company, source, and current deal stage.

2. *Follow-ups Due* — Run crm-query follow-up to find stale leads. List each with last contact date and touch count.

3. *Pipeline Health* — Run pipeline health --group snak-group. Show counts per stage and total deal value.

4. *Upcoming Appointments* — Check Google Calendar for the next 7 days. List each with date, time, and business name.

5. *IDDI Alerts* — Run iddi expiring --days 7 to check for products near expiration. Run iddi redistribution to check for optimization opportunities. Summarize any flags.

6. *Open Issues* — Check playbook.md for any flagged items or unresolved questions.

7. *What Andy Learned* — Summarize new patterns, common objections, or interesting questions from yesterday''s conversations.

Email subject: "Snak Group Daily Briefing — [Today''s Date]"
Send to the owner email in owner-info.md.',
  'cron',
  '0 14 * * 1-5',
  'group',
  datetime('now'),
  'active',
  datetime('now')
);

-- Sheridan Rentals daily briefing
INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
VALUES (
  'sheridan-daily-briefing',
  'sheridan-rentals',
  '__scheduled__',
  'Generate and email the daily business briefing to the owner. Include ALL of these sections:

1. *Tomorrow''s Pickups & Returns* — Check all 3 Google Calendars (RV Camper, Car Hauler, Landscaping Trailer) for tomorrow''s events. List each with equipment type, customer name, and time.

2. *This Week''s Bookings* — Summary of all bookings for the next 7 days, grouped by equipment type.

3. *Overnight Inquiries* — Check CRM for new contacts in the last 24 hours. Show name, source, and what they''re asking about.

4. *Pending Follow-ups* — Run crm-query follow-up to find stale leads. List each with last contact date.

5. *Pipeline Health* — Run pipeline health --group sheridan-rentals. Show counts per stage.

6. *Revenue Estimate* — Count this week''s confirmed bookings and multiply by typical rates (RV $150/night, Car Hauler $65/day, Landscaping $50/day). Show estimated gross revenue.

Email subject: "Sheridan Rentals Daily Briefing — [Today''s Date]"
Send to the owner email in owner-info.md.',
  'cron',
  '0 14 * * 1-5',
  'group',
  datetime('now'),
  'active',
  datetime('now')
);

-- Stage 5: Per-task model/budget overrides
-- Upgrade daily briefings to Sonnet — they need complex multi-tool reasoning
-- (Calendar + CRM + IDDI + Sheets + email in a single run)
UPDATE scheduled_tasks SET model = 'claude-sonnet-4-6', budget_usd = 0.50
  WHERE id IN ('snak-daily-briefing', 'sheridan-daily-briefing');

-- Vending inventory tasks need Sonnet + higher budget for browser automation
-- (login to Vendera/HahaVending, navigate complex UIs, extract data, reconcile)
UPDATE scheduled_tasks SET model = 'claude-sonnet-4-6', budget_usd = 0.50
  WHERE id LIKE '%vending%' OR id LIKE '%inventory%';

-- Stage 6: CLI execution mode (Max subscription)
-- Add columns if they don't exist (safe to re-run — errors are ignored by sqlite3)
-- Note: sqlite3 CLI doesn't support try/catch, so we use INSERT trick to test.
-- If the app has already run (which adds columns via ALTER TABLE), these are no-ops.
ALTER TABLE scheduled_tasks ADD COLUMN execution_mode TEXT DEFAULT 'cli';
ALTER TABLE scheduled_tasks ADD COLUMN fallback_to_container INTEGER DEFAULT 1;

-- All scheduled tasks default to CLI (free with Max sub), with container fallback
UPDATE scheduled_tasks SET execution_mode = 'cli', fallback_to_container = 1;
