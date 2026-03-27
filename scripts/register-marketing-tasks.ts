#!/usr/bin/env npx tsx
/**
 * Register missing marketing scheduled tasks and unpause GBP tasks.
 * Run from project root: npx tsx scripts/register-marketing-tasks.ts
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

function upsertTask(task: {
  id: string;
  group_folder: string;
  prompt: string;
  schedule_value: string;
  execution_mode?: string;
  model?: string;
}) {
  const existing = db.prepare('SELECT id FROM scheduled_tasks WHERE id = ?').get(task.id);
  if (existing) {
    db.prepare('UPDATE scheduled_tasks SET prompt = ?, schedule_value = ?, status = ?, next_run = datetime("now", "+1 hour") WHERE id = ?')
      .run(task.prompt, task.schedule_value, 'active', task.id);
    console.log('Updated: ' + task.id);
  } else {
    // Find the chat_jid for this group
    const group = db.prepare('SELECT jid FROM registered_groups WHERE name LIKE ? OR folder = ? LIMIT 1')
      .get('%' + task.group_folder + '%', task.group_folder) as { jid: string } | undefined;
    const chatJid = group?.jid || 'unknown';

    db.prepare(`INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, execution_mode, model)
      VALUES (?, ?, ?, ?, 'cron', ?, 'full', datetime('now', '+1 hour'), 'active', datetime('now'), ?, ?)`)
      .run(task.id, task.group_folder, chatJid, task.prompt, task.schedule_value, task.execution_mode || 'cli', task.model || null);
    console.log('Created: ' + task.id);
  }
}

// 1. Unpause GBP monthly tasks
db.prepare("UPDATE scheduled_tasks SET status = 'active', next_run = datetime('now', '+1 hour') WHERE id IN ('sheridan-gbp-monthly', 'snak-gbp-monthly') AND status = 'paused'").run();
console.log('Unpaused: sheridan-gbp-monthly, snak-gbp-monthly');

// 2. GBP review responses — Mon & Thu 10am CT
upsertTask({
  id: 'snak-gbp-reviews',
  group_folder: 'snak-group',
  prompt: `Check Google Business Profile for new reviews using the gbp skill.

1. Run: npx tsx tools/gbp/gbp.ts reviews --unreplied-only
2. For 5-star reviews: auto-reply with a thank-you (use review response templates from the gbp skill)
3. For 4-star reviews: draft a reply and email it to snakgroupteam@snakgroup.biz for approval before posting
4. For 1-3 star reviews: draft a careful reply following the negative review template and email it to snakgroupteam@snakgroup.biz for approval — do NOT auto-reply

Email subject: "GBP Reviews — [count] new reviews"
Send to: snakgroupteam@snakgroup.biz`,
  schedule_value: '0 10 * * 1,4',
});

upsertTask({
  id: 'sheridan-gbp-reviews',
  group_folder: 'sheridan-rentals',
  prompt: `Check Google Business Profile for new reviews using the gbp skill.

1. Run: npx tsx tools/gbp/gbp.ts reviews --unreplied-only
2. For 5-star reviews: auto-reply with a thank-you
3. For 4-star reviews: draft a reply and email to snakgroupteam@snakgroup.biz for approval
4. For 1-3 star reviews: draft a reply and email to snakgroupteam@snakgroup.biz for approval — do NOT auto-reply

Email subject: "Sheridan GBP Reviews — [count] new reviews"
Send to: snakgroupteam@snakgroup.biz`,
  schedule_value: '0 10 * * 1,4',
});

// 3. Marketplace renewal — Sheridan, Monday 7am CT
upsertTask({
  id: 'sheridan-marketplace-renew',
  group_folder: 'sheridan-rentals',
  prompt: `Check Facebook Marketplace listings for Sheridan Rentals using the fb-marketplace skill.

1. Read marketplace-listings.md for current active listings
2. Check if any listings are older than 7 days — if so, renew them using fb-marketplace.ts renew-listing
3. If no active listings exist, create the 3 standard listings (RV Camper, Car Hauler, Landscaping Trailer) using templates from the fb-marketplace skill
4. Rotate the title variation for renewed listings (see skill for title options)
5. Update marketplace-listings.md with new listing IDs and dates

Work silently. Only email snakgroupteam@snakgroup.biz if a listing creation fails.`,
  schedule_value: '0 7 * * 1',
});

// 4. Google Ads weekly review — Monday 9am CT (both businesses)
upsertTask({
  id: 'snak-google-ads-weekly',
  group_folder: 'snak-group',
  prompt: `Run the weekly Google Ads performance review using the google-ads skill.

1. Run: npx tsx tools/ads/google-ads.ts report --days 7
2. Check CPA against threshold ($50/qualified lead for Snak Group)
3. If any campaign CPA > 2x threshold for 7 days, pause it
4. If CTR < 1% for 7 days, flag for ad copy refresh
5. Summarize: impressions, clicks, CTR, conversions, cost, CPA per campaign

Email the report to snakgroupteam@snakgroup.biz
Subject: "Snak Group Google Ads Weekly — [Date]"
Do NOT send via WhatsApp.`,
  schedule_value: '0 9 * * 1',
});

upsertTask({
  id: 'sheridan-google-ads-weekly',
  group_folder: 'sheridan-rentals',
  prompt: `Run the weekly Google Ads performance review using the google-ads skill.

1. Run: npx tsx tools/ads/google-ads.ts report --days 7
2. Check CPA against threshold ($30/booking inquiry for Sheridan)
3. If any campaign CPA > 2x threshold, pause it
4. Summarize: impressions, clicks, CTR, conversions, cost, CPA per campaign

Email the report to snakgroupteam@snakgroup.biz
Subject: "Sheridan Google Ads Weekly — [Date]"
Do NOT send via WhatsApp.`,
  schedule_value: '0 9 * * 1',
});

// 5. Monthly SEO audit (1st of month) — already have weekly, add monthly comprehensive
upsertTask({
  id: 'snak-seo-monthly',
  group_folder: 'snak-group',
  prompt: `Run the monthly comprehensive SEO audit for Snak Group using the seo skill.

1. Run full site audit: npx tsx tools/seo/seo-audit.ts audit --url "https://snakgroup.biz"
2. Run keyword tracking: npx tsx tools/seo/seo-audit.ts keywords --domain "snakgroup.biz" --keywords "vending machine houston,office coffee service houston,smart cooler houston,break room vending houston,free vending machine houston"
3. Run Core Web Vitals: npx tsx tools/seo/seo-audit.ts check-speed --url "https://snakgroup.biz" --strategy mobile
4. Run schema check: npx tsx tools/seo/seo-audit.ts check-schema --url "https://snakgroup.biz"
5. Run directory report: npx tsx tools/seo/directory-manager.ts report --business "snak-group"
6. Compare results to previous month in seo-assets.md
7. Update seo-assets.md with latest scores and rankings

Email full report to snakgroupteam@snakgroup.biz
Subject: "Snak Group Monthly SEO Report — [Month Year]"`,
  schedule_value: '0 9 1 * *',
});

upsertTask({
  id: 'sheridan-seo-monthly',
  group_folder: 'sheridan-rentals',
  prompt: `Run the monthly comprehensive SEO audit for Sheridan Rentals using the seo skill.

1. Run full site audit: npx tsx tools/seo/seo-audit.ts audit --url "https://sheridantrailerrentals.us"
2. Run keyword tracking with target keywords from keyword-strategy.md
3. Run Core Web Vitals: npx tsx tools/seo/seo-audit.ts check-speed --url "https://sheridantrailerrentals.us" --strategy mobile
4. Run schema check: npx tsx tools/seo/seo-audit.ts check-schema --url "https://sheridantrailerrentals.us"
5. Run directory report: npx tsx tools/seo/directory-manager.ts report --business "sheridan-rentals"
6. Update seo-assets.md with latest scores

Email full report to snakgroupteam@snakgroup.biz
Subject: "Sheridan SEO Report — [Month Year]"`,
  schedule_value: '0 10 1 * *',
});

// 6. Asset catalog bootstrap — one-time task for Andy to populate Drive photos
upsertTask({
  id: 'bootstrap-asset-catalogs',
  group_folder: 'main',
  prompt: `One-time setup: Populate the asset catalogs for both businesses from Google Drive.

FOR SNAK GROUP:
1. Search Google Drive for photos: npx tsx tools/drive/drive.ts search --name "snak" --mime "image/jpeg"
   Also search: "vending", "coffee", "cooler", "vitro", "ice machine", "smart cooler"
2. For each photo found, note the file ID, name, and what it shows
3. Update groups/snak-group/asset-catalog.md — fill in the Drive Folder ID and populate the photo tables by category

FOR SHERIDAN RENTALS:
1. Search Google Drive: npx tsx tools/drive/drive.ts search --name "sheridan" --mime "image/jpeg"
   Also search: "trailer", "rv", "camper", "hauler", "tomball"
2. Update groups/sheridan-rentals/asset-catalog.md with found photos

FOR INSTAGRAM LOCATIONS:
1. npx tsx tools/social/post-instagram.ts --search-location "Houston, TX"
2. npx tsx tools/social/post-instagram.ts --search-location "Tomball, TX"
3. npx tsx tools/social/post-instagram.ts --search-location "The Woodlands, TX"
4. npx tsx tools/social/post-instagram.ts --search-location "Katy, TX"
5. Update groups/global/houston-places.md with discovered Instagram location IDs

FOR DIRECTORIES:
1. npx tsx tools/seo/directory-manager.ts init --business "snak-group"
2. npx tsx tools/seo/directory-manager.ts init --business "sheridan-rentals"

This is a one-time task. Mark it as completed when done.`,
  schedule_value: '',
  execution_mode: 'cli',
});

// Mark the bootstrap as a one-time task
db.prepare("UPDATE scheduled_tasks SET schedule_type = 'once' WHERE id = 'bootstrap-asset-catalogs'").run();

db.close();
console.log('\nAll marketing tasks registered.');
