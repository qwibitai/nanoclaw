-- Competitor & Inspiration Page Auto-Discovery — Monthly Task
-- Run on VPS: sqlite3 /home/nanoclaw/nanoclaw/store/messages.db < deploy/upgrade-competitor-discovery.sql
--
-- TIMEZONE: Cron expressions are in America/Chicago (Central Time).

-- ============================================================
-- Monthly Competitor Discovery (1st of each month, 7 AM CT)
-- ============================================================

-- Snak Group — discover new vending/coffee competitors + high-engagement local businesses
INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, execution_mode, fallback_to_container)
VALUES (
  'snak-competitor-discovery',
  'snak-group',
  '__scheduled__',
  'Discover new Facebook pages to monitor for content inspiration. Follow this exact process:

STEP 1 — READ CURRENT LIST
Read competitors.md to see what pages we already track across all 3 tiers.

STEP 2 — SEARCH FOR NEW TIER 1 PAGES (Direct Competitors)
Use agent-browser to search Facebook for:
- "vending machine Houston" / "office coffee Houston" / "micro market Houston"
- "breakroom service Houston" / "vending service Texas"
Look for active business pages (posted in last 30 days) that we don''t already track.
For each new find, note: company name, Facebook URL, page ID (from URL), follower count, last post date.

STEP 3 — SEARCH FOR NEW TIER 2 PAGES (Local Houston Businesses Crushing It)
Use agent-browser to search Facebook for high-engagement local Houston service businesses:
- Search "Houston TX" + various local service categories: HVAC, plumbing, landscaping, auto repair, gym, restaurant, food truck, cleaning service, moving company, pet grooming, car wash
- Look for pages with 2K+ followers AND recent posts with 50+ reactions
- These are NOT competitors — they are content teachers. We learn their hook types, visual styles, and engagement tactics.
Prioritize businesses that:
- Post consistently (3+ times per week)
- Get real engagement (comments + shares, not just likes)
- Use photos/video effectively
- Have strong local Houston identity

STEP 4 — SEARCH FOR NEW TIER 3 PAGES (National Brands)
Search for national vending, coffee service, and workplace amenity brands with active Facebook pages.
Look for polished content formats worth adapting.

STEP 5 — UPDATE COMPETITORS.MD
Add any new pages found to the appropriate tier in competitors.md.
Remove any pages that have gone inactive (no posts in 60+ days).
Note the date of this discovery scan.

STEP 6 — REPORT
Send a WhatsApp summary: how many new pages found per tier, any notable finds, any pages removed for inactivity.

Focus on quality over quantity. 5 active pages with great content beats 20 dead pages.',
  'cron',
  '0 7 1 * *',
  'group',
  datetime('now'),
  'active',
  datetime('now'),
  'cli',
  1
);

-- Sheridan Rentals — discover new trailer/RV competitors + high-engagement local businesses
INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, execution_mode, fallback_to_container)
VALUES (
  'sheridan-competitor-discovery',
  'sheridan-rentals',
  '__scheduled__',
  'Discover new Facebook pages to monitor for content inspiration. Follow this exact process:

STEP 1 — READ CURRENT LIST
Read competitors.md to see what pages we already track across all 3 tiers.

STEP 2 — SEARCH FOR NEW TIER 1 PAGES (Direct Competitors)
Use agent-browser to search Facebook for:
- "trailer rental Houston" / "RV rental Houston" / "trailer rental Tomball"
- "car hauler rental Texas" / "equipment rental Houston" / "camper rental Houston"
Look for active business pages (posted in last 30 days) that we don''t already track.
For each new find, note: company name, Facebook URL, page ID (from URL), follower count, last post date.

STEP 3 — SEARCH FOR NEW TIER 2 PAGES (Local Houston Businesses Crushing It)
Use agent-browser to search Facebook for high-engagement local Houston service businesses:
- Search "Houston TX" or "Tomball TX" + various local service categories: auto repair, car dealership, campground, outdoor recreation, moving company, landscaping, home repair, pest control, cleaning
- Look for pages with 2K+ followers AND recent posts with 50+ reactions
- These are NOT competitors — they are content teachers. We learn their hook types, visual styles, and engagement tactics.
Prioritize businesses that:
- Post consistently (3+ times per week)
- Get real engagement (comments + shares, not just likes)
- Use photos/video effectively
- Have strong local Tomball/Houston identity
- Serve similar customer demographics (homeowners, families, outdoor enthusiasts)

STEP 4 — SEARCH FOR NEW TIER 3 PAGES (National Brands)
Search for national trailer rental, RV rental, and equipment rental brands with active Facebook pages.
Look for polished content formats worth adapting.

STEP 5 — UPDATE COMPETITORS.MD
Add any new pages found to the appropriate tier in competitors.md.
Remove any pages that have gone inactive (no posts in 60+ days).
Note the date of this discovery scan.

STEP 6 — REPORT
Send a WhatsApp summary: how many new pages found per tier, any notable finds, any pages removed for inactivity.

Focus on quality over quantity. 5 active pages with great content beats 20 dead pages.',
  'cron',
  '0 7 1 * *',
  'group',
  datetime('now'),
  'active',
  datetime('now'),
  'cli',
  1
);
