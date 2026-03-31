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
  schedule_value: '20 10 * * 1,4', // Staggered: snak-gbp at :00, sheridan-gbp at :20
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
  schedule_value: '45 9 * * 1', // Staggered: snak-ads at 9:00, sheridan-ads at 9:45
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
  schedule_value: '30 9 1 * *', // Staggered: snak-seo at 9:00, sheridan-seo at 9:30
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

// ============================================================
// FACEBOOK AUTOMATION (6 tasks)
// ============================================================

// Weekly post generation — Sunday 6 PM CT
upsertTask({
  id: 'snak-fb-posts-weekly',
  group_folder: 'snak-group',
  schedule_value: '0 18 * * 0',
  prompt: `Generate next week's Facebook posts for the Snak Group page. Follow this exact process:

STEP 1 — COMPETITOR & INSPIRATION SCAN
Read competitors.md. It has 3 tiers of Facebook pages to scan:
- *Tier 1 (Direct Competitors)*: Scan ALL pages. Note gaps in their content you can exploit.
- *Tier 2 (Local Houston Businesses Crushing It)*: Scan 3-5 pages (rotate through the list each week). These are your best teachers — learn what hooks, photo styles, and formats get Houston audiences to engage.
- *Tier 3 (National Brands)*: Scan 1-2 pages. Learn polished formats worth adapting to local scale.

For each page: npx tsx tools/social/trend-scraper.ts scan --platform facebook --query "<page_id>" --limit 10
Then: npx tsx tools/social/trend-scraper.ts analyze

Write key observations to the "Latest Scan Notes" section of competitors.md (date + tier + findings).

STEP 2 — READ INPUTS
Read brand-voice.md, content-calendar.md (check log to avoid repeating topics within 2 weeks), viral-patterns.md (check groups/main/ if not in group folder), and asset-catalog.md.

STEP 3 — GENERATE 5 POSTS (Monday-Friday)
For each day, create a post following the content calendar themes:
- Monday: Industry Insight
- Tuesday: Quick Tip
- Wednesday: Case Study
- Thursday: Thought Leadership
- Friday: Engagement

Rules per post:
- 40-100 chars with media preferred
- 2-3 hashtags from brand-voice.md
- Include snakgroup.biz link on Monday and Wednesday posts
- Use viral patterns AND Tier 2 scan insights to choose hook types
- Vary hook types across the week — don't use the same hook type twice
- Never repeat a topic used in the last 2 weeks (check the log)
- Select a photo from asset-catalog.md for each post. Record the Drive file ID.
- Include place-id from houston-places.md
- For each Facebook post, also generate an Instagram caption version: same photo, but longer caption (150-300 chars), 15-20 hashtags from brand-voice.md, note Instagram location ID from houston-places.md
- For posts with video content, generate a TikTok version: short caption (<150 chars), trending hashtags
- Generate 2 GBP posts for the week (Tue + Thu): 100-300 words, CTA link (snakgroup.biz), target local keywords

STEP 4 — WRITE PENDING-POSTS.MD
Write all posts to pending-posts.md with status "awaiting-approval". Each entry: message text, Drive file ID, place-id, Instagram caption version, TikTok version (if video), GBP posts.

STEP 5 — NOTIFY OWNER
Send a WhatsApp message with all 5 posts previewed. End with: "Reply 'approved' to approve all, or tell me which days to change."`,
});

upsertTask({
  id: 'sheridan-fb-posts-weekly',
  group_folder: 'sheridan-rentals',
  schedule_value: '30 18 * * 0', // Staggered: snak-fb-posts at 18:00, sheridan at 18:30
  prompt: `Generate next week's Facebook posts for the Sheridan Rentals page. Follow this exact process:

STEP 1 — COMPETITOR & INSPIRATION SCAN
Read competitors.md. It has 3 tiers of Facebook pages to scan:
- *Tier 1 (Direct Competitors)*: Scan ALL pages.
- *Tier 2 (Local Houston Businesses Crushing It)*: Scan 3-5 pages (rotate weekly).
- *Tier 3 (National Brands)*: Scan 1-2 pages.

For each page: npx tsx tools/social/trend-scraper.ts scan --platform facebook --query "<page_id>" --limit 10
Then: npx tsx tools/social/trend-scraper.ts analyze

Write key observations to competitors.md "Latest Scan Notes".

STEP 2 — READ INPUTS
Read brand-voice.md, content-calendar.md, viral-patterns.md, and asset-catalog.md.

STEP 3 — GENERATE 5 POSTS (Monday-Friday)
Themes:
- Monday: Fleet Spotlight — showcase one piece of equipment with pricing
- Tuesday: Local Flavor / Tips — camping spots near Houston, hauling tips, Tomball events
- Wednesday: Customer Use Case — real scenarios (project car pickup, family RV trip, moving day)
- Thursday: Seasonal / Promotional — tie into current season, availability alerts
- Friday: Engagement / Fun — polls, questions, weekend plans

Rules:
- Under 300 characters
- 2-3 hashtags (branded + local/seasonal from brand-voice.md)
- Include booking link (sheridantrailerrentals.us/form/) on fleet spotlight and promo posts
- Casual Texas friendly tone
- Use viral patterns AND Tier 2 scan insights for hook types — vary across the week
- Never repeat a topic used in the last 2 weeks
- Select photo from asset-catalog.md, record Drive file ID
- Include place-id from houston-places.md (default: Tomball)
- Generate Instagram caption versions and GBP posts (Mon + Wed)

STEP 4 — WRITE PENDING-POSTS.MD
Write all posts with status "awaiting-approval".

STEP 5 — NOTIFY OWNER
Send WhatsApp preview. End with: "Reply 'approved' to approve all, or tell me which days to change."`,
});

// Daily posting — M-F 9 AM CT
upsertTask({
  id: 'snak-fb-post-daily',
  group_folder: 'snak-group',
  schedule_value: '0 9 * * 1-5',
  prompt: `Post today's approved Facebook content for Snak Group. Follow fb-posting-workflow.md exactly:

1. Read pending-posts.md, find today's entry by date
2. If status is "approved":
   a. If Drive file ID present: download photo with drive.ts download, then post with photo and place-id via post-facebook.ts
   b. If "NO PHOTO": post text-only with place-id
   c. Record post_id in pending-posts.md and content-calendar.md log
   d. Post Instagram version with post-instagram.ts using Instagram caption and same photo
   e. If TikTok version exists: post via post-tiktok.ts (stagger 30-60 min after Instagram)
   f. If GBP post scheduled for today: post via gbp.ts post
3. If not approved: skip and notify "Skipping today's post — not yet approved"
4. If already posted: skip silently

Work silently on success. Only message the group if something fails or needs attention.`,
});

upsertTask({
  id: 'sheridan-fb-post-daily',
  group_folder: 'sheridan-rentals',
  schedule_value: '15 9 * * 1-5', // Staggered: snak-fb at 9:00, sheridan-fb at 9:15
  prompt: `Post today's approved Facebook content for Sheridan Rentals. Follow fb-posting-workflow.md exactly:

1. Read pending-posts.md, find today's entry by date
2. If status is "approved":
   a. If Drive file ID present: download photo with drive.ts download, then post with photo and place-id via post-facebook.ts
   b. If "NO PHOTO": post text-only with place-id
   c. Record post_id in pending-posts.md and content-calendar.md log
   d. Post Instagram version with post-instagram.ts using Instagram caption and same photo
   e. If GBP post scheduled for today: post via gbp.ts post
3. If not approved: skip and notify "Skipping today's post — not yet approved"
4. If already posted: skip silently

Work silently on success. Only message the group if something fails or needs attention.`,
});

// Weekly performance review — Saturday 10 AM CT
upsertTask({
  id: 'snak-fb-review-weekly',
  group_folder: 'snak-group',
  schedule_value: '0 10 * * 6',
  prompt: `Measure this week's social media engagement for Snak Group across all platforms:

1. Collect post_ids from pending-posts.md and content-calendar.md
2. Fetch Facebook insights: npx tsx tools/social/read-facebook-insights.ts --post-ids <ids>
3. Fetch Instagram insights: npx tsx tools/social/read-instagram-insights.ts --post-ids <ids>
4. Fetch GBP insights: npx tsx tools/gbp/gbp.ts insights --days 7
5. Compare hook types, themes, and engagement across all platforms
6. Update content-learnings.md with this week's best/worst performers and key insights
7. Update viral-patterns.md if new patterns emerge (e.g., a hook type that consistently outperforms)
8. Send WhatsApp performance summary covering all platforms:
   - Best performing post (platform, hook type, engagement)
   - Worst performing post
   - Key insight for next week
   - Total reach/impressions across platforms`,
});

upsertTask({
  id: 'sheridan-fb-review-weekly',
  group_folder: 'sheridan-rentals',
  schedule_value: '30 10 * * 6', // Staggered: snak-review at 10:00, sheridan at 10:30
  prompt: `Measure this week's social media engagement for Sheridan Rentals across all platforms:

1. Collect post_ids from pending-posts.md and content-calendar.md
2. Fetch Facebook insights: npx tsx tools/social/read-facebook-insights.ts --post-ids <ids>
3. Fetch Instagram insights: npx tsx tools/social/read-instagram-insights.ts --post-ids <ids>
4. Fetch GBP insights: npx tsx tools/gbp/gbp.ts insights --days 7
5. Compare hook types, themes, and engagement
6. Update content-learnings.md with best/worst performers and key insights
7. Update viral-patterns.md if new patterns emerge
8. Send WhatsApp performance summary`,
});

// ============================================================
// LINKEDIN AUTOMATION (3 tasks)
// ============================================================

// Batch connection requests — M-F 8 AM CT
upsertTask({
  id: 'snak-linkedin-batch-connect',
  group_folder: 'snak-group',
  schedule_value: '0 8 * * 1-5',
  prompt: `Run daily LinkedIn batch connection outreach for Snak Group.

npx tsx tools/social/linkedin-connect.ts batch --limit 15

This tool automatically:
- Pulls contacts with LinkedIn URLs who haven't been connected yet
- Prioritizes by lead score
- Sends personalized connection requests with company name
- Waits 30 seconds between requests to avoid rate limits
- Updates CRM contact notes with "LinkedIn connection sent" timestamp

Work silently. Only message the group if errors occur or if there are no eligible contacts left.`,
});

// LinkedIn content posting — M-F 10:30 AM CT (staggered 90 min after Facebook)
upsertTask({
  id: 'snak-linkedin-post-daily',
  group_folder: 'snak-group',
  schedule_value: '30 10 * * 1-5',
  prompt: `Post today's LinkedIn content for Snak Group.

1. Read pending-posts.md for today's approved Facebook post
2. Adapt the post to LinkedIn format:
   - Professional tone (not casual social media tone)
   - 800-1300 characters (longer than Facebook)
   - No hashtags in the body — add 3-5 industry hashtags at the end
   - Add a thought-leadership angle or business insight
   - Include a call to engage (question, opinion prompt)
   - If the Facebook post has a link, include it
3. Post via: npx tsx tools/social/post-linkedin.ts --message "..." --visibility PUBLIC

If no approved post for today, skip silently.
Work silently on success.`,
});

// LinkedIn follow-up messages — M-F 2 PM CT
upsertTask({
  id: 'snak-linkedin-followup',
  group_folder: 'snak-group',
  schedule_value: '0 14 * * 1-5',
  prompt: `Send warm follow-up messages to recently accepted LinkedIn connections.

1. Query CRM for contacts where notes contain "LinkedIn connection sent" from 3-7 days ago:
   npx tsx tools/crm/query-contacts.ts search --note-contains "LinkedIn connection sent" --limit 10

2. For each contact that was connected 3-7 days ago and hasn't received a follow-up message:
   - Craft a personalized thank-you message (under 300 chars)
   - Reference their company and what Snak Group does
   - Don't pitch — just build relationship. Example: "Thanks for connecting! I see you're at [company] — always great to connect with fellow Houston businesses. Looking forward to staying in touch."
   - Send via: npx tsx tools/social/linkedin-connect.ts message --linkedin-url "<url>" --text "..."
   - Update contact notes with "LinkedIn follow-up sent: [date]"

3. Limit to 5 messages per run to avoid rate limits (30s delay between each)

Work silently. Only message the group if errors occur.`,
});

// ============================================================
// LEAD SCRAPING (1 task)
// ============================================================

// Weekly lead generation — Monday 7 AM CT
upsertTask({
  id: 'snak-lead-scrape-weekly',
  group_folder: 'snak-group',
  schedule_value: '30 7 * * 1', // Staggered: sheridan-marketplace at 7:00, lead-scrape at 7:30
  prompt: `Run the full weekly lead generation pipeline for Snak Group. Follow the lead-finder skill exactly.

STEP 1 — GOOGLE MAPS SEARCHES (13 verticals)
Run each search with --import and --limit 60:
npx tsx tools/leads/google-maps.ts search --query "office buildings Houston TX" --limit 60 --import --tags "maps,offices,2026-W$(date +%V)"
npx tsx tools/leads/google-maps.ts search --query "coworking spaces Houston TX" --limit 60 --import --tags "maps,coworking,2026-W$(date +%V)"
npx tsx tools/leads/google-maps.ts search --query "gyms fitness centers Houston TX" --limit 60 --import --tags "maps,gyms,2026-W$(date +%V)"
npx tsx tools/leads/google-maps.ts search --query "hotels Houston TX" --limit 60 --import --tags "maps,hotels,2026-W$(date +%V)"
npx tsx tools/leads/google-maps.ts search --query "car dealerships Houston TX" --limit 60 --import --tags "maps,dealerships,2026-W$(date +%V)"
npx tsx tools/leads/google-maps.ts search --query "hospitals medical centers Houston TX" --limit 60 --import --tags "maps,hospitals,2026-W$(date +%V)"
npx tsx tools/leads/google-maps.ts search --query "universities colleges Houston TX" --limit 60 --import --tags "maps,universities,2026-W$(date +%V)"
npx tsx tools/leads/google-maps.ts search --query "schools Houston TX" --limit 60 --import --tags "maps,schools,2026-W$(date +%V)"
npx tsx tools/leads/google-maps.ts search --query "apartment complexes Houston TX" --limit 60 --import --tags "maps,apartments,2026-W$(date +%V)"
npx tsx tools/leads/google-maps.ts search --query "warehouses Houston TX" --limit 60 --import --tags "maps,warehouses,2026-W$(date +%V)"
npx tsx tools/leads/google-maps.ts search --query "manufacturers Houston TX" --limit 60 --import --tags "maps,manufacturers,2026-W$(date +%V)"
npx tsx tools/leads/google-maps.ts search --query "Amazon warehouses Houston TX" --limit 60 --import --tags "maps,amazon,2026-W$(date +%V)"
npx tsx tools/leads/google-maps.ts search --query "trucking shipping yards Houston TX" --limit 60 --import --tags "maps,trucking,2026-W$(date +%V)"

STEP 2 — WEBSITE ENRICHMENT
npx tsx tools/leads/website-scraper.ts batch --source google_maps --limit 50

STEP 3 — LEAD SCORING
npx tsx tools/crm/lead-score.ts batch --source google_maps --limit 200

STEP 4 — SERVICE-FIT TAGGING
Tag contacts by industry fit:
- coffee-primary: offices, coworking, hotels, hospitals, universities
- vending-primary: gyms, apartments, dealerships, warehouses, manufacturers, trucking, schools
- ice-machine-fit: hotels, hospitals, gyms, restaurants, dealerships
A lead can have multiple tags.

STEP 5 — WHATSAPP REPORT
Send summary to the group:
- Total new leads imported this week
- Enriched count (websites scraped successfully)
- Score distribution: hot (80+), warm (50-79), cool (20-49), cold (<20)
- Top 5 hottest leads (highest score, company name, industry)`,
});

// ============================================================
// COLD EMAIL AUTOMATION (3 tasks)
// ============================================================

// Daily outreach — M-F 9:30 AM CT (staggered from fb-post at 9:00)
upsertTask({
  id: 'snak-outreach-daily',
  group_folder: 'snak-group',
  schedule_value: '30 9 * * 1-5',
  prompt: `Run daily outreach for Snak Group. Follow the outreach-workflow skill.

1. CHECK STATS FIRST:
   npx tsx tools/crm/query-contacts.ts stats
   If bounce rate > 5%, STOP all outreach and alert the owner. Do not send more emails.

2. CHECK INSTANTLY CAMPAIGN STATUS:
   npx tsx tools/instantly/instantly.ts campaigns
   Find the active campaign for Snak Group.

3. PUSH NEW LEADS TO CAMPAIGN:
   npx tsx tools/instantly/instantly.ts add-leads --campaign-id <active_campaign_id> --source google_maps --min-score 40 --limit 10
   Only push leads with score >= 40 (warm or hot).

4. CHECK FOLLOW-UPS:
   npx tsx tools/crm/query-contacts.ts follow-up --days 3 --limit 10
   For leads needing follow-up, check their outreach history. Stop after 3 touches.

5. Work silently. Only message the group with a brief summary: "Outreach: X new leads pushed, Y follow-ups sent."`,
});

// Sync replies from Instantly — M-F 11 AM CT
upsertTask({
  id: 'snak-replies-sync',
  group_folder: 'snak-group',
  schedule_value: '0 11 * * 1-5',
  prompt: `Sync email replies from Instantly.ai and update CRM pipeline for Snak Group.

1. SYNC REPLIES:
   npx tsx tools/instantly/instantly.ts sync-replies
   This pulls replies from Instantly and updates CRM deal stages to "qualified" for respondents.

2. CHECK FOR UNSUBSCRIBE/BOUNCE:
   For any reply containing "unsubscribe", "stop", "remove me", "opt out":
   npx tsx tools/crm/unsubscribe.ts --contact-id <id> --reason opted-out

   For any bounced emails detected:
   npx tsx tools/crm/unsubscribe.ts --contact-id <id> --reason bounced

3. POSITIVE REPLIES — Create deals:
   For positive or interested replies, create a deal:
   npx tsx tools/crm/pipeline.ts create --contact-id <id> --group main --source email --notes "Replied to outreach campaign"

4. Work silently unless there are positive replies — then message the group with lead details.`,
});

// Weekly outreach report — Friday 6 PM CT
upsertTask({
  id: 'snak-outreach-weekly-report',
  group_folder: 'snak-group',
  schedule_value: '0 18 * * 5',
  prompt: `Generate the weekly outreach report for Snak Group.

1. GET CRM STATS:
   npx tsx tools/crm/query-contacts.ts stats

2. GET CAMPAIGN ANALYTICS:
   npx tsx tools/instantly/instantly.ts campaigns
   For each active campaign: npx tsx tools/instantly/instantly.ts campaign-analytics --id <campaign_id>

3. GET PIPELINE HEALTH:
   npx tsx tools/crm/pipeline.ts health --group main

4. COMPILE REPORT covering:
   - Emails sent this week (total and per day)
   - Open rate, reply rate, click rate (from Instantly analytics)
   - Bounce rate (flag if > 5%)
   - New leads added (from Monday scrape)
   - Replies received (positive, negative, unsubscribe)
   - Pipeline: deals by stage, total value
   - Top responding companies
   - Recommendations for next week

5. Send report via WhatsApp to the group.
   Also email to snakgroupteam@snakgroup.biz with subject "Snak Group Outreach Report — Week of [date]"`,
});

// ============================================================
// MONITORING & HEALTH (3 tasks)
// ============================================================

// Daily system health check — 7 AM CT
upsertTask({
  id: 'system-health-daily',
  group_folder: 'main',
  schedule_value: '0 7 * * *',
  prompt: `Run a daily health check on all Andy automation systems.

1. Check scheduled task run logs for errors in the last 24 hours.
   Query the task_run_logs table for any tasks with status 'error' since yesterday.

2. Check if critical tasks ran successfully:
   - snak-fb-post-daily (should have run yesterday at 9 AM on weekdays)
   - snak-linkedin-batch-connect (should have run yesterday at 8 AM on weekdays)
   - snak-outreach-daily (should have run yesterday at 9 AM on weekdays)
   - snak-replies-sync (should have run yesterday at 11 AM on weekdays)

3. Check CRM health:
   npx tsx tools/crm/query-contacts.ts stats
   Flag if bounce rate > 5%.

4. If any errors found: send WhatsApp alert to the main group with details.
   If everything is healthy: work silently (no message needed).`,
});

// Weekly marketing report — Saturday 12 PM CT
upsertTask({
  id: 'snak-marketing-weekly-report',
  group_folder: 'main',
  schedule_value: '0 12 * * 6',
  prompt: `Generate the comprehensive weekly marketing report covering ALL 4 pillars.

PILLAR 1 — SOCIAL MEDIA
- Facebook: total reach, engagement rate, best post (from content-learnings.md)
- Instagram: total reach, engagement rate
- LinkedIn: posts published, engagement
- GBP: views, actions, new reviews

PILLAR 2 — LEAD GENERATION
- New leads imported this week
- Score distribution: hot/warm/cool/cold
- Website enrichment success rate
- Top 5 new leads by score

PILLAR 3 — COLD EMAIL
- Emails sent, open rate, reply rate (from Instantly analytics)
- Bounce rate
- New deals created from replies
- Pipeline health: npx tsx tools/crm/pipeline.ts health --group main

PILLAR 4 — LINKEDIN OUTREACH
- Connection requests sent
- Acceptance rate (if trackable)
- Follow-up messages sent
- Posts published

SUMMARY
- Total marketing touches this week (all channels combined)
- Revenue pipeline value
- Key wins
- Areas needing attention
- Recommendations for next week

Send via WhatsApp to the main group.
Also email to snakgroupteam@snakgroup.biz with subject "Andy Weekly Marketing Report — [date]"`,
});

// LinkedIn token expiry reminder — 1st of month 9 AM CT
upsertTask({
  id: 'linkedin-token-check',
  group_folder: 'main',
  schedule_value: '0 8 1 * *', // Staggered: runs at 8 AM on 1st, seo tasks at 9:00/9:30
  prompt: `Monthly LinkedIn token expiry check.

LinkedIn access tokens expire every 60 days. Send a WhatsApp reminder to the main group:

"Monthly reminder: LinkedIn access token expires every 60 days. If LinkedIn batch connections or posting are failing, the token may need renewal.

To refresh:
1. Go to https://www.linkedin.com/developers/
2. Open your app → Auth tab
3. Generate a new token with w_member_social + r_liteprofile scopes
4. Update LINKEDIN_ACCESS_TOKEN in the .env file
5. Restart Andy

Current token was last set: [check .env file modification date if possible]"

Only send this reminder — no other action needed.`,
});

db.close();
console.log('\nAll marketing tasks registered.');
