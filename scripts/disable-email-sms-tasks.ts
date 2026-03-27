#!/usr/bin/env npx tsx
/**
 * One-time migration: Remove email/SMS sending instructions from all scheduled tasks.
 * Andy should only respond via WhatsApp and Facebook Messenger.
 * Run from project root: npx tsx scripts/disable-email-sms-tasks.ts
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const dbPath = path.join(process.cwd(), 'store', 'messages.db');
if (!fs.existsSync(dbPath)) {
  console.error('Database not found at ' + dbPath);
  process.exit(1);
}

const db = new Database(dbPath);

// Helper: update a task prompt by ID
function updateTask(id: string, prompt: string): boolean {
  const result = db.prepare('UPDATE scheduled_tasks SET prompt = ? WHERE id = ?').run(prompt, id);
  if (result.changes > 0) {
    console.log(`Updated: ${id}`);
    return true;
  } else {
    console.log(`Skipped (not found): ${id}`);
    return false;
  }
}

let updated = 0;

// 1. daily-digest-8am — send via WhatsApp, not email
updateTask('daily-digest-8am', `Generate the daily morning digest for Blayk. Cover BOTH businesses comprehensively:

**SNAK GROUP (Vending):**
- Check IDDI for yesterday's sales totals, any expiring products in the next 7 days, and low-stock alerts
- Read demand-forecast.json, trend-alerts-history.json, blacklist-state.json, business-health.json for current inventory intelligence
- Check Google Sheets for recent sales performance trends
- Check the CRM pipeline: any new leads, pending deals, or deals needing follow-up

**SHERIDAN RENTALS (Trailers/RVs):**
- Query the bookings database for today's pickups and returns
- List upcoming reservations for the next 7 days
- Flag any unpaid bookings or overdue payments
- Check the 3 equipment calendars for availability gaps

**ACROSS BOTH:**
- Check Google Calendar for today's appointments

Format as a clean, scannable snapshot. Use sections with headers. Keep it concise but complete. If a data source is unavailable, note it briefly and move on.

Send the digest via WhatsApp only. Do NOT send emails or SMS.`) && updated++;

// 2. snak-daily-briefing — WhatsApp only, no email
updateTask('snak-daily-briefing', `Generate the comprehensive daily business briefing. Include ALL sections below. Send via WhatsApp only. Do NOT send emails or SMS.

1. *Overnight Leads* — Check CRM for new contacts in the last 24 hours. Show name, company, source, and current deal stage.

2. *Follow-ups Due* — Run crm-query follow-up to find stale leads. List each with last contact date and touch count.

3. *Pipeline Health* — Run pipeline health --group snak-group. Show counts per stage and total deal value.

4. *Upcoming Appointments* — Check Google Calendar for the next 7 days. List each with date, time, and business name.

5. *Vending Inventory Status* — This is critical. Include ALL of the following:
   a. Run IDDI inventory to check current stock levels across all machines
   b. Run IDDI expiring --days 7 to check for products near expiration
   c. Run IDDI redistribution to check for optimization opportunities
   d. Read demand-forecast.json — summarize trending up and trending down products
   e. Read trend-alerts-history.json — include any critical or warning alerts
   f. Read blacklist-state.json — note any products approaching blacklist or newly blacklisted
   g. Read platform-status.json — note if any platform has been failing
   h. Read profitability.json if it exists — note top winners and money losers
   i. Read business-health.json if it exists — include the overall health score and grade

6. *Sales Snapshot* — If demand-forecast.json exists, include:
   - Top 5 sellers this week by units and revenue
   - Any dead stock with 0 sales for 2+ weeks
   - Products with velocity surges or drops

7. *Machine Performance* — If available from yesterday's vending daily, include:
   - Machines reporting vs not reporting
   - Any zero-sales machines flagged as potential issues

8. *Open Issues* — Check playbook.md for any flagged items or unresolved questions.

9. *What Andy Learned* — Summarize new patterns, common objections, or interesting questions from yesterday's conversations.

Send via WhatsApp only. Do NOT send emails or SMS.`) && updated++;

// 3. snak-vending-daily — work silently, output to WhatsApp only if critical
updateTask('snak-vending-daily', `Run the daily vending inventory review. Work silently — no messages unless something critical needs immediate attention.

STEP 1: Log into HahaVending and Vendera (credentials in CLAUDE.md). Pull yesterday's sales data from both platforms. Merge into unified per-product totals. Track per-machine data too — which machines reported and individual revenue.

STEP 2: Run IDDI inventory check for products near expiration (expiring --days 7) and redistribution opportunities.

STEP 3: Read snak group inventory tracker Google Sheets (all 3 tabs). Update Sales Performance with yesterday's sales. Update Warehouse Inventory: subtract sold units. Update color codes.

STEP 4: Run reconcile full --yo-offset 2 to cross-examine all sources.

STEP 5: Run demand-forecast generate to update trend analysis.

STEP 6: Run trend-alerts check for any critical/warning alerts.

STEP 7: Update platform-status for each platform with success or failure status.

STEP 8: Use web search to check Sam's Club prices for reorder items. Update pricing in Google Sheets if changed.

RESULTS: The daily briefing task reads the output files and includes inventory data in the morning WhatsApp digest.

Only send a WhatsApp message if something CRITICAL needs immediate attention — machine completely down, all platforms failing, etc. Otherwise work silently. Do NOT send emails or SMS.`) && updated++;

// 4. follow-up-check — WhatsApp only
updateTask('follow-up-check', `Check for stale customer inquiries that need follow-up:

1. Run: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action stale --days 3
   This returns conversions stuck in 'inquiry' or 'quoted' stage.
2. Also check for quoted leads stale >5 days: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action stale --days 5
3. For each stale entry, compose a brief, friendly follow-up message
4. Send follow-ups via WhatsApp ONLY. Do NOT send emails or SMS. Skip any conversions that originated from email or SMS channels.
5. Update the conversion with: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action update --id "<conv_id>" --notes "follow-up sent on [date]"
6. Report summary: how many follow-ups sent, which businesses

Be natural and helpful — not pushy. Reference their original inquiry. Example:
"Hi [name], just wanted to check in about the vending machine placement we discussed.
Still happy to help if you're interested! Let me know if you have any questions."

For Sheridan Rentals:
"Hi [name], following up on your trailer rental inquiry. We still have availability
if you're interested. Happy to answer any questions about the equipment."`) && updated++;

// 5. review-solicitation — WhatsApp only
updateTask('review-solicitation', `Check for recently completed services that should get a review request:

1. Query completed conversions: npx tsx /workspace/project/tools/conversions/track-conversion.ts --action query --stage completed
   Filter results to entries updated in the last 48 hours.
2. For each one, send a brief review request via WhatsApp ONLY. Do NOT send emails or SMS. Skip any conversions that originated from email or SMS channels.
3. Update to 'reviewed': npx tsx /workspace/project/tools/conversions/track-conversion.ts --action update --id "<conv_id>" --stage reviewed --notes "review requested on [date]"

For Snak Group:
"Thanks for choosing Snak Group for your breakroom vending! If you're enjoying the service,
we'd really appreciate a quick Google review — it helps other businesses find us.
[Include Google review link if available]"

For Sheridan Rentals:
"Thanks for renting with Sheridan! Hope everything went smoothly. If you have a moment,
a Google review would mean a lot to us.
[Include Google review link if available]"

Only send ONE review request per customer. Check notes for "review requested" before sending.`) && updated++;

// 6. Weekly vending task (variable ID — find by prompt content)
const weeklyVending = db.prepare(
  "SELECT id FROM scheduled_tasks WHERE prompt LIKE '%weekly vending%' OR prompt LIKE '%Weekly vending%' OR id = '487917c4'"
).get() as { id: string } | undefined;

if (weeklyVending) {
  updateTask(weeklyVending.id, `Weekly vending inventory automation (Friday end-of-week). Use the vending-inventory skill to pull this week's full sales from HahaVending and Vendera, update Google Sheets, run reconciliation, demand forecast, and trend alerts.

Send the complete weekly vending report via WhatsApp. Do NOT send emails or SMS.

The report should include: shopping list, well-stocked items, blacklist warnings, newly blacklisted products with replacement suggestions, coming off blacklist, machine performance, and sales highlights.

Also run profitability analysis if Product Costs tab exists in Google Sheets. Include profitability winners and losers in the report.`) && updated++;
}

// 7. snak-blacklist-weekly — WhatsApp only
updateTask('snak-blacklist-weekly', `Run the weekly blacklist review.

STEP 1: Read Google Sheets snak group inventory tracker — Sales Performance tab for the last 4 weeks of color data per product.
STEP 2: Run reconcile blacklist --yo-offset 2 to get current blacklist state.
STEP 3: Read blacklist-state.json for products approaching, on, or coming off blacklist.
STEP 4: For newly blacklisted products, search Sam's Club and Costco for replacement product suggestions with prices.

Send the blacklist report via WhatsApp. Do NOT send emails or SMS.`) && updated++;

// 8. Catch-all: update any remaining tasks that mention "email" sending
const emailTasks = db.prepare(
  "SELECT id, prompt FROM scheduled_tasks WHERE prompt LIKE '%send%email%' OR prompt LIKE '%EMAIL%snakgroupteam%' OR prompt LIKE '%send-email%'"
).all() as { id: string; prompt: string }[];

for (const task of emailTasks) {
  // Replace email sending instructions with WhatsApp
  let newPrompt = task.prompt
    .replace(/Send (?:the |this |a )?(?:complete |full )?(?:report|results?|briefing|digest|summary|review request|follow-up)s? (?:via |through )?(?:EMAIL|email) to snakgroupteam@snakgroup\.biz[^.]*\./gi,
      'Send via WhatsApp only. Do NOT send emails or SMS.')
    .replace(/Do NOT send (?:this )?(?:to|via) WhatsApp[^.]*\./gi, '')
    .replace(/Email (?:the |this )?(?:report|results?|briefing|digest|blacklist report)[^.]*\./gi,
      'Send via WhatsApp only. Do NOT send emails or SMS.')
    .replace(/using (?:the )?send-email(?: tool)?/gi, 'via WhatsApp')
    .replace(/Email only\./gi, 'WhatsApp only. Do NOT send emails or SMS.')
    .replace(/RESULTS GO TO EMAIL, NOT WHATSAPP\./gi, 'Send results via WhatsApp only. Do NOT send emails or SMS.')
    .replace(/Email subject:[^\n]*/gi, '');

  if (newPrompt !== task.prompt) {
    updateTask(task.id, newPrompt) && updated++;
  }
}

db.close();
console.log(`\nDone. Updated ${updated} tasks to WhatsApp-only delivery.`);
console.log('Email and SMS sending has been disabled for all scheduled tasks.');
