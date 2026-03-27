#!/usr/bin/env npx tsx
/**
 * One-time: Update daily digest tasks to send via email instead of WhatsApp.
 * Run from project root: npx tsx scripts/update-digest-tasks.ts
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

// 1. Update snak-daily-briefing — full inventory picture, email only
const snakBriefing = `Generate and email the comprehensive daily business briefing to snakgroupteam@snakgroup.biz. Include ALL sections below. Do NOT send this to WhatsApp unless specifically requested.

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

Email subject: "Snak Group Daily Briefing — [Today's Date]"
Send to: snakgroupteam@snakgroup.biz
Do NOT send to WhatsApp. Email only.`;

db.prepare('UPDATE scheduled_tasks SET prompt = ? WHERE id = ?')
  .run(snakBriefing, 'snak-daily-briefing');
console.log('Updated: snak-daily-briefing');

// 2. Update snak-vending-daily — work silently, email not WhatsApp
const vendingDaily = `Run the daily vending inventory review. Work silently — no WhatsApp messages unless something critical needs immediate attention.

STEP 1: Log into HahaVending and Vendera (credentials in CLAUDE.md). Pull yesterday's sales data from both platforms. Merge into unified per-product totals. Track per-machine data too — which machines reported and individual revenue.

STEP 2: Run IDDI inventory check for products near expiration (expiring --days 7) and redistribution opportunities.

STEP 3: Read snak group inventory tracker Google Sheets (all 3 tabs). Update Sales Performance with yesterday's sales. Update Warehouse Inventory: subtract sold units. Update color codes.

STEP 4: Run reconcile full --yo-offset 2 to cross-examine all sources.

STEP 5: Run demand-forecast generate to update trend analysis.

STEP 6: Run trend-alerts check for any critical/warning alerts.

STEP 7: Update platform-status for each platform with success or failure status.

STEP 8: Use web search to check Sam's Club prices for reorder items. Update pricing in Google Sheets if changed.

RESULTS GO TO EMAIL, NOT WHATSAPP. The daily briefing task reads the output files and includes inventory data in the morning email to snakgroupteam@snakgroup.biz.

Only send a WhatsApp message if something CRITICAL needs immediate attention — machine completely down, all platforms failing, etc. Otherwise work silently.`;

db.prepare('UPDATE scheduled_tasks SET prompt = ? WHERE id = ?')
  .run(vendingDaily, 'snak-vending-daily');
console.log('Updated: snak-vending-daily');

// 3. Update daily-digest-8am (main) — email to snakgroupteam@snakgroup.biz
const dailyDigest = `Generate the daily morning digest for Blayk and EMAIL it to snakgroupteam@snakgroup.biz using the send-email tool. Do NOT send to WhatsApp unless Blayk specifically requests it there.

Subject: "Daily Digest — [Today's Date]"

**SNAK GROUP (Vending):**
- Check IDDI for yesterday's sales totals, any expiring products in the next 7 days, and low-stock alerts
- Read demand-forecast.json, trend-alerts-history.json, blacklist-state.json, business-health.json for current inventory intelligence
- Check Google Sheets for recent sales performance trends
- Check the CRM pipeline: any new leads, pending deals, or deals needing follow-up
- Check Gmail inbox for any unread customer emails about vending

**SHERIDAN RENTALS (Trailers/RVs):**
- Query the bookings database for today's pickups and returns
- List upcoming reservations for the next 7 days
- Flag any unpaid bookings or overdue payments
- Check the 3 equipment calendars for availability gaps

**ACROSS BOTH:**
- Check Google Calendar for today's appointments
- Summarize any unanswered Quo SMS messages from either business line
- Note any unread Gmail messages requiring attention

Format as a clean, scannable email. Use sections with headers. Keep it concise but complete. If a data source is unavailable, note it briefly and move on.

Send to: snakgroupteam@snakgroup.biz using the send-email tool. Do NOT send via WhatsApp.`;

db.prepare('UPDATE scheduled_tasks SET prompt = ? WHERE id = ?')
  .run(dailyDigest, 'daily-digest-8am');
console.log('Updated: daily-digest-8am');

// 4. Also update the weekly vending automation (Friday 7pm) to email
const weeklyVending = db.prepare("SELECT id, prompt FROM scheduled_tasks WHERE id = '487917c4'").get() as { id: string; prompt: string } | undefined;
if (weeklyVending) {
  const weeklyPrompt = `Weekly vending inventory automation (Friday end-of-week). Use the vending-inventory skill to pull this week's full sales from HahaVending and Vendera, update Google Sheets, run reconciliation, demand forecast, and trend alerts.

Send the complete weekly vending report via EMAIL to snakgroupteam@snakgroup.biz using the send-email tool. Subject: "Weekly Vending Report — [Date]"

Do NOT send via WhatsApp unless Blayk specifically requests it. The email should include: shopping list, well-stocked items, blacklist warnings, newly blacklisted products with replacement suggestions, coming off blacklist, machine performance, and sales highlights.

Also run profitability analysis if Product Costs tab exists in Google Sheets. Include profitability winners and losers in the report.`;

  db.prepare('UPDATE scheduled_tasks SET prompt = ? WHERE id = ?')
    .run(weeklyPrompt, weeklyVending.id);
  console.log('Updated: ' + weeklyVending.id + ' (weekly vending)');
}

// 5. Also update snak-blacklist-weekly to email
const blacklistWeekly = db.prepare("SELECT id FROM scheduled_tasks WHERE id = 'snak-blacklist-weekly'").get() as { id: string } | undefined;
if (blacklistWeekly) {
  const blacklistPrompt = `Run the weekly blacklist review.

STEP 1: Read Google Sheets snak group inventory tracker — Sales Performance tab for the last 4 weeks of color data per product.
STEP 2: Run reconcile blacklist --yo-offset 2 to get current blacklist state.
STEP 3: Read blacklist-state.json for products approaching, on, or coming off blacklist.
STEP 4: For newly blacklisted products, search Sam's Club and Costco for replacement product suggestions with prices.

EMAIL the blacklist report to snakgroupteam@snakgroup.biz using send-email. Subject: "Snak Group Blacklist Review — [Date]"
Do NOT send via WhatsApp unless specifically requested.`;

  db.prepare('UPDATE scheduled_tasks SET prompt = ? WHERE id = ?')
    .run(blacklistPrompt, blacklistWeekly.id);
  console.log('Updated: snak-blacklist-weekly');
}

db.close();
console.log('\nAll tasks updated to email to snakgroupteam@snakgroup.biz');
