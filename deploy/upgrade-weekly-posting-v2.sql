-- Weekly Facebook Posting v2 — Tiered Competitor Intelligence
-- Run on VPS: sqlite3 /home/nanoclaw/nanoclaw/store/messages.db < deploy/upgrade-weekly-posting-v2.sql
--
-- TIMEZONE: All cron expressions are in America/Chicago (Central Time).
-- This upgrades the Sunday weekly generation to scan all 3 tiers of competitors.md

-- ============================================================
-- 1. Update Weekly Post Generation — Now with Tiered Competitor Scan
-- ============================================================

-- Snak Group — updated with tiered competitor scanning
UPDATE scheduled_tasks SET prompt = 'Generate next week''s Facebook posts for the Snak Group page. Follow this exact process:

STEP 1 — COMPETITOR & INSPIRATION SCAN
Read competitors.md. It has 3 tiers of Facebook pages to scan:
- *Tier 1 (Direct Competitors)*: Scan ALL pages. Note gaps in their content you can exploit.
- *Tier 2 (Local Houston Businesses Crushing It)*: Scan 3-5 pages (rotate through the list each week). These are your best teachers — learn what hooks, photo styles, and formats get Houston audiences to engage. A BBQ food truck getting 200 reactions on a behind-the-scenes post teaches you more than a vending company posting into the void.
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
- Vary hook types across the week — don''t use the same hook type twice
- Never repeat a topic used in the last 2 weeks (check the log)
- If a Tier 2 business got high engagement on a specific format this week (before/after, question, POV, stat-lead), use that format for at least one post
- Select a photo from asset-catalog.md for each post using the theme-to-photo mapping. Record the Drive file ID.
- Include place-id from houston-places.md

STEP 4 — WRITE PENDING-POSTS.MD
Write all 5 posts to pending-posts.md using this exact format:

# Pending Posts — Week of [Monday date YYYY-MM-DD]

Generated: [timestamp]
Status: awaiting-approval
Competitor Insights: [1-2 sentence summary of what you learned from this week''s scan]

## Monday [YYYY-MM-DD] — [Theme]
**Status**: pending
**Post ID**:
**Drive File ID**: [photo file ID from asset-catalog.md]
**Place ID**: [from houston-places.md]
**Content**:
[post text here]

**Hook Type**: [hook type]
**Inspired By**: [which tier/page inspired this format, or "original"]
**Link**: [url or empty]

---

(repeat for Tuesday through Friday)

STEP 5 — NOTIFY OWNER
Send a WhatsApp message to the group with all 5 posts previewed. Format as a clean list showing each day''s theme and full post content. End with: "Reply ''approved'' to approve all, or tell me which days to change."'
WHERE id = 'snak-fb-posts-weekly';

-- Sheridan Rentals — updated with tiered competitor scanning
UPDATE scheduled_tasks SET prompt = 'Generate next week''s Facebook posts for the Sheridan Rentals page. Follow this exact process:

STEP 1 — COMPETITOR & INSPIRATION SCAN
Read competitors.md. It has 3 tiers of Facebook pages to scan:
- *Tier 1 (Direct Competitors)*: Scan ALL pages. Note gaps in their content you can exploit.
- *Tier 2 (Local Houston Businesses Crushing It)*: Scan 3-5 pages (rotate through the list each week). These are your best teachers — learn what hooks, photo styles, and formats get Houston audiences to engage. If a junk removal company gets great engagement on before/after content, that same format works for trailer rentals.
- *Tier 3 (National Brands)*: Scan 1-2 pages. Learn polished formats worth adapting to local scale.

For each page: npx tsx tools/social/trend-scraper.ts scan --platform facebook --query "<page_id>" --limit 10
Then: npx tsx tools/social/trend-scraper.ts analyze

Write key observations to the "Latest Scan Notes" section of competitors.md (date + tier + findings).

STEP 2 — READ INPUTS
Read brand-voice.md, content-calendar.md (check log to avoid repeating topics within 2 weeks), viral-patterns.md (check groups/main/ if not in group folder), and asset-catalog.md.

STEP 3 — GENERATE 5 POSTS (Monday-Friday)
For each day, create a post following the content calendar themes:
- Monday: Fleet Spotlight — showcase one piece of equipment with pricing
- Tuesday: Local Flavor / Tips — camping spots near Houston, hauling tips, Tomball events
- Wednesday: Customer Use Case — real scenarios (project car pickup, family RV trip, moving day)
- Thursday: Seasonal / Promotional — tie into current season, availability alerts
- Friday: Engagement / Fun — polls, questions, weekend plans

Rules per post:
- Under 300 characters
- 2-3 hashtags (mix branded + local/seasonal from brand-voice.md)
- Include booking link (sheridantrailerrentals.us/form/) on fleet spotlight and promo posts
- Casual Texas friendly tone — like talking to a neighbor
- Use viral patterns AND Tier 2 scan insights to choose hook types — vary across the week
- Never repeat a topic used in the last 2 weeks (check the log)
- If a Tier 2 business got high engagement on a specific format this week, adapt that format for at least one post
- Select a photo from asset-catalog.md for each post using the theme-to-photo mapping. Record the Drive file ID.
- Include place-id from houston-places.md (default: Tomball)

STEP 4 — WRITE PENDING-POSTS.MD
Write all 5 posts to pending-posts.md using this exact format:

# Pending Posts — Week of [Monday date YYYY-MM-DD]

Generated: [timestamp]
Status: awaiting-approval
Competitor Insights: [1-2 sentence summary of what you learned from this week''s scan]

## Monday [YYYY-MM-DD] — [Theme]
**Status**: pending
**Post ID**:
**Drive File ID**: [photo file ID from asset-catalog.md]
**Place ID**: [from houston-places.md]
**Content**:
[post text here]

**Hook Type**: [hook type]
**Inspired By**: [which tier/page inspired this format, or "original"]
**Link**: [url or empty]

---

(repeat for Tuesday through Friday)

STEP 5 — NOTIFY OWNER
Send a WhatsApp message to the group with all 5 posts previewed. Format as a clean list showing each day''s theme and full post content. End with: "Reply ''approved'' to approve all, or tell me which days to change."'
WHERE id = 'sheridan-fb-posts-weekly';
