-- Weekly Facebook Posting Workflow — Approval + Performance Tracking
-- Run on VPS: sqlite3 /home/nanoclaw/nanoclaw/store/messages.db < deploy/upgrade-weekly-posting.sql
--
-- TIMEZONE: All cron expressions are in America/Chicago (Central Time).

-- ============================================================
-- 1. Weekly Post Generation Tasks (Sunday 6 PM CT)
-- ============================================================

-- Snak Group — generate next week's 5 Facebook posts for owner approval
INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, execution_mode, fallback_to_container)
VALUES (
  'snak-fb-posts-weekly',
  'snak-group',
  '__scheduled__',
  'Generate next week''s Facebook posts for the Snak Group page. Follow this exact process:

STEP 1 — READ INPUTS
Read brand-voice.md, content-calendar.md (check log to avoid repeating topics within 2 weeks), and viral-patterns.md (check groups/main/ if not in group folder).

STEP 2 — GENERATE 5 POSTS (Monday-Friday)
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
- Use viral patterns to choose hook types (stat-lead, question, POV, how-to, story, etc.)
- Vary hook types across the week — don''t use the same hook type twice
- Never repeat a topic used in the last 2 weeks (check the log)

STEP 3 — WRITE PENDING-POSTS.MD
Write all 5 posts to pending-posts.md using this exact format:

# Pending Posts — Week of [Monday date YYYY-MM-DD]

Generated: [timestamp]
Status: awaiting-approval

## Monday [YYYY-MM-DD] — [Theme]
**Status**: pending
**Post ID**:
**Content**:
[post text here]

**Hook Type**: [hook type]
**Link**: [url or empty]
**Image**: [url or empty]

---

(repeat for Tuesday through Friday)

STEP 4 — NOTIFY OWNER
Send a WhatsApp message to the group with all 5 posts previewed. Format as a clean list showing each day''s theme and full post content. End with: "Reply ''approved'' to approve all, or tell me which days to change."',
  'cron',
  '0 18 * * 0',
  'group',
  datetime('now'),
  'active',
  datetime('now'),
  'cli',
  1
);

-- Sheridan Rentals — generate next week's 5 Facebook posts for owner approval
INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, execution_mode, fallback_to_container)
VALUES (
  'sheridan-fb-posts-weekly',
  'sheridan-rentals',
  '__scheduled__',
  'Generate next week''s Facebook posts for the Sheridan Rentals page. Follow this exact process:

STEP 1 — READ INPUTS
Read brand-voice.md, content-calendar.md (check log to avoid repeating topics within 2 weeks), and viral-patterns.md (check groups/main/ if not in group folder).

STEP 2 — GENERATE 5 POSTS (Monday-Friday)
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
- Use viral patterns to choose hook types — vary across the week
- Never repeat a topic used in the last 2 weeks (check the log)

STEP 3 — WRITE PENDING-POSTS.MD
Write all 5 posts to pending-posts.md using this exact format:

# Pending Posts — Week of [Monday date YYYY-MM-DD]

Generated: [timestamp]
Status: awaiting-approval

## Monday [YYYY-MM-DD] — [Theme]
**Status**: pending
**Post ID**:
**Content**:
[post text here]

**Hook Type**: [hook type]
**Link**: [url or empty]
**Image**: [url or empty]

---

(repeat for Tuesday through Friday)

STEP 4 — NOTIFY OWNER
Send a WhatsApp message to the group with all 5 posts previewed. Format as a clean list showing each day''s theme and full post content. End with: "Reply ''approved'' to approve all, or tell me which days to change."',
  'cron',
  '0 18 * * 0',
  'group',
  datetime('now'),
  'active',
  datetime('now'),
  'cli',
  1
);

-- ============================================================
-- 2. Update Daily Posting Tasks — Now Approval-Based
-- ============================================================

-- Snak Group daily posting — reads from pending-posts.md instead of generating live
UPDATE scheduled_tasks SET prompt = 'Post today''s approved Facebook content for Snak Group. Follow this exact process:

STEP 1 — CHECK PENDING POSTS
Read pending-posts.md. Find today''s entry by matching the current date.

STEP 2 — CHECK APPROVAL STATUS
- If the top-level Status is "approved" OR today''s individual Status is "approved": proceed to Step 3
- If today''s Status is "pending" or the file doesn''t exist: SKIP posting. Send a WhatsApp message: "Skipping today''s Facebook post — not yet approved. Reply ''approved'' to approve all pending posts."
- If today''s Status is "posted": SKIP silently (already posted today)
- If today''s Status is "skipped": SKIP silently

STEP 3 — POST TO FACEBOOK
Extract the Content, Link, and Image fields from today''s entry.
Post via: npx tsx tools/social/post-facebook.ts --message "[content]" [--link "[link]"] [--image "[image]"]

STEP 4 — RECORD RESULTS
Update today''s entry in pending-posts.md:
- Set **Status** to "posted"
- Set **Post ID** to the post_id returned by the tool

Update content-calendar.md log table with today''s date, day theme, topic summary, post_id, and status.

Work silently on success. Only send a WhatsApp message if posting was skipped due to missing approval.'
WHERE id = 'snak-fb-post-daily';

-- If snak-fb-post-daily doesn't exist yet, create it
INSERT OR IGNORE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, execution_mode, fallback_to_container)
VALUES (
  'snak-fb-post-daily',
  'snak-group',
  '__scheduled__',
  'Post today''s approved Facebook content for Snak Group. Follow this exact process:

STEP 1 — CHECK PENDING POSTS
Read pending-posts.md. Find today''s entry by matching the current date.

STEP 2 — CHECK APPROVAL STATUS
- If the top-level Status is "approved" OR today''s individual Status is "approved": proceed to Step 3
- If today''s Status is "pending" or the file doesn''t exist: SKIP posting. Send a WhatsApp message: "Skipping today''s Facebook post — not yet approved. Reply ''approved'' to approve all pending posts."
- If today''s Status is "posted": SKIP silently (already posted today)
- If today''s Status is "skipped": SKIP silently

STEP 3 — POST TO FACEBOOK
Extract the Content, Link, and Image fields from today''s entry.
Post via: npx tsx tools/social/post-facebook.ts --message "[content]" [--link "[link]"] [--image "[image]"]

STEP 4 — RECORD RESULTS
Update today''s entry in pending-posts.md:
- Set **Status** to "posted"
- Set **Post ID** to the post_id returned by the tool

Update content-calendar.md log table with today''s date, day theme, topic summary, post_id, and status.

Work silently on success. Only send a WhatsApp message if posting was skipped due to missing approval.',
  'cron',
  '0 9 * * 1-5',
  'group',
  datetime('now'),
  'active',
  datetime('now'),
  'cli',
  1
);

-- Sheridan daily posting — same approval-based flow
UPDATE scheduled_tasks SET prompt = 'Post today''s approved Facebook content for Sheridan Rentals. Follow this exact process:

STEP 1 — CHECK PENDING POSTS
Read pending-posts.md. Find today''s entry by matching the current date.

STEP 2 — CHECK APPROVAL STATUS
- If the top-level Status is "approved" OR today''s individual Status is "approved": proceed to Step 3
- If today''s Status is "pending" or the file doesn''t exist: SKIP posting. Send a WhatsApp message: "Skipping today''s Facebook post — not yet approved. Reply ''approved'' to approve all pending posts."
- If today''s Status is "posted": SKIP silently (already posted today)
- If today''s Status is "skipped": SKIP silently

STEP 3 — POST TO FACEBOOK
Extract the Content, Link, and Image fields from today''s entry.
Post via: npx tsx tools/social/post-facebook.ts --message "[content]" [--link "[link]"] [--image "[image]"]

STEP 4 — RECORD RESULTS
Update today''s entry in pending-posts.md:
- Set **Status** to "posted"
- Set **Post ID** to the post_id returned by the tool

Update content-calendar.md log table with today''s date, day theme, topic summary, post_id, and status.

Work silently on success. Only send a WhatsApp message if posting was skipped due to missing approval.'
WHERE id = 'sheridan-fb-post-daily';

-- ============================================================
-- 3. Weekly Performance Review Tasks (Saturday 10 AM CT)
-- ============================================================

-- Snak Group — review engagement on this week's posts
INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, execution_mode, fallback_to_container)
VALUES (
  'snak-fb-review-weekly',
  'snak-group',
  '__scheduled__',
  'Review this week''s Facebook post performance for Snak Group. Follow this exact process:

STEP 1 — GATHER POST IDS
Read pending-posts.md. Collect all post_ids from posts with Status: posted.
Also check content-calendar.md log for any post_ids from this week.

STEP 2 — FETCH INSIGHTS
For each post_id found, run:
  npx tsx tools/social/read-facebook-insights.ts --post-ids "[comma-separated ids]"

STEP 3 — ANALYZE PERFORMANCE
Compare engagement metrics across this week''s posts. Note:
- Which hook type got the most reactions/comments/shares?
- Which day/theme performed best?
- What was the average engagement (reactions + comments + shares)?
- Any posts that significantly over- or under-performed?

STEP 4 — UPDATE LEARNINGS
Read viral-patterns.md (in groups/main/ or group folder). If this week''s data reveals new insights, update it.

Create or update content-learnings.md in the group folder with a weekly entry:
## Week of [date]
- Best performer: [day] — [reactions/comments/shares] — Hook: [type]
- Worst performer: [day] — [reactions/comments/shares] — Hook: [type]
- Key insight: [what to do differently]
- Avg reactions: [number] | Avg comments: [number] | Avg shares: [number]

STEP 5 — SEND SUMMARY
Send a WhatsApp performance report showing:
- Each day''s post with its engagement numbers (reactions, comments, shares)
- Best and worst performers
- Key takeaway for next week
- Any pattern changes made',
  'cron',
  '0 10 * * 6',
  'group',
  datetime('now'),
  'active',
  datetime('now'),
  'cli',
  1
);

-- Sheridan Rentals — review engagement on this week's posts
INSERT OR REPLACE INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at, execution_mode, fallback_to_container)
VALUES (
  'sheridan-fb-review-weekly',
  'sheridan-rentals',
  '__scheduled__',
  'Review this week''s Facebook post performance for Sheridan Rentals. Follow this exact process:

STEP 1 — GATHER POST IDS
Read pending-posts.md. Collect all post_ids from posts with Status: posted.
Also check content-calendar.md log for any post_ids from this week.

STEP 2 — FETCH INSIGHTS
For each post_id found, run:
  npx tsx tools/social/read-facebook-insights.ts --post-ids "[comma-separated ids]"

STEP 3 — ANALYZE PERFORMANCE
Compare engagement metrics across this week''s posts. Note:
- Which hook type got the most reactions/comments/shares?
- Which day/theme performed best?
- What was the average engagement (reactions + comments + shares)?
- Any posts that significantly over- or under-performed?

STEP 4 — UPDATE LEARNINGS
Read viral-patterns.md (in groups/main/ or group folder). If this week''s data reveals new insights, update it.

Create or update content-learnings.md in the group folder with a weekly entry:
## Week of [date]
- Best performer: [day] — [reactions/comments/shares] — Hook: [type]
- Worst performer: [day] — [reactions/comments/shares] — Hook: [type]
- Key insight: [what to do differently]
- Avg reactions: [number] | Avg comments: [number] | Avg shares: [number]

STEP 5 — SEND SUMMARY
Send a WhatsApp performance report showing:
- Each day''s post with its engagement numbers (reactions, comments, shares)
- Best and worst performers
- Key takeaway for next week
- Any pattern changes made',
  'cron',
  '0 10 * * 6',
  'group',
  datetime('now'),
  'active',
  datetime('now'),
  'cli',
  1
);

-- ============================================================
-- 4. Register secretOverrides for multi-page Facebook posting
-- ============================================================

UPDATE registered_groups SET container_config = json_set(
  COALESCE(container_config, '{}'),
  '$.extraSecretScopes', json('["social"]'),
  '$.secretOverrides', json('{"FB_PAGE_ID":"FB_PAGE_ID_SNAK","FB_PAGE_ACCESS_TOKEN":"FB_PAGE_ACCESS_TOKEN_SNAK"}')
) WHERE folder = 'snak-group';

UPDATE registered_groups SET container_config = json_set(
  COALESCE(container_config, '{}'),
  '$.extraSecretScopes', json('["social"]'),
  '$.secretOverrides', json('{"FB_PAGE_ID":"FB_PAGE_ID_SHERIDAN","FB_PAGE_ACCESS_TOKEN":"FB_PAGE_ACCESS_TOKEN_SHERIDAN"}')
) WHERE folder = 'sheridan-rentals';
