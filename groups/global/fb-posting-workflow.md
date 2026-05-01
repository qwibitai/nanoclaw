# Facebook Page Posting — Weekly Approval Workflow

## Weekly Post Generation (Sunday 6 PM CT)
A scheduled task generates next week's 5 Facebook posts (Mon-Fri), plus TikTok versions and GBP posts, and sends them to the group chat for owner approval.

When the task fires:
1. **Tiered competitor & inspiration scan**: Read `competitors.md` which has 3 tiers:
   - **Tier 1 (Direct Competitors)**: Scan ALL pages — find content gaps to exploit
   - **Tier 2 (Local Houston Crushers)**: Scan 3-5 pages (rotate weekly) — learn hooks, photo styles, and formats that get Houston audiences to engage. This is the most valuable tier.
   - **Tier 3 (National Brands)**: Scan 1-2 pages — learn polished formats worth adapting
   Use `trend-scraper.ts scan --platform facebook --query "<page_id>"` for each. Note what's getting engagement and update "Latest Scan Notes" in competitors.md.
2. Read `brand-voice.md`, `content-calendar.md` (check log to avoid topic repeats within 2 weeks), `viral-patterns.md`, and `asset-catalog.md`
3. Generate 5 posts following the content calendar themes, using viral pattern hook types (vary across the week)
4. **Select a photo** for each post from `asset-catalog.md` using the theme-to-photo mapping. Record the Drive file ID alongside each post.
   - **If asset-catalog.md has no photos yet**: Note "NO PHOTO" in the Drive File ID column of `pending-posts.md` and generate the post as text-only. When photos become available, update `asset-catalog.md` and future posts will automatically include them.
5. **For each Facebook post, also generate an Instagram caption version**: same photo reference, but longer caption (150-300 chars), include 15-20 relevant hashtags from the hashtag strategy in `brand-voice.md`, and note the Instagram location ID from `houston-places.md`.
6. **For posts with video content, generate a TikTok version**: short-form caption (under 150 chars), trending hashtags, hook-in-first-3-seconds format. Skip TikTok for posts without video. Note the TikTok version in `pending-posts.md` alongside Facebook/Instagram versions.
7. **Generate 2 GBP posts for the week** (e.g., Tuesday + Thursday for Snak, Monday + Wednesday for Sheridan). GBP posts should be 100-300 words, include a CTA link (website or booking page), and target 1-2 local keywords from `keyword-strategy.md`. Add these to `pending-posts.md` with a "gbp" tag.
8. Write all posts to `pending-posts.md` with status "awaiting-approval" — each entry must include: message text, Drive file ID for the photo (or "NO PHOTO"), place-id from `houston-places.md`, Instagram caption version, TikTok version (if video), and GBP posts for the week.
9. Send WhatsApp preview of all posts for owner review

## Auto-Approval Rule (Moderate Authority)

Per `groups/global/authority.md` Andy operates at Moderate authority: routine themed posts auto-act. Apply the following rule when generating the weekly preview:

**Auto-approve and mark `Status: approved` immediately** if ALL of these are true:
- The post follows the day's content-calendar theme verbatim (Mon=Fleet Spotlight, Tue=Local Flavor/Tips, Wed=Customer Use Case, Thu=Seasonal/Promotional, Fri=Engagement/Fun)
- The post does NOT introduce a new offer, discount, price point, positioning claim, or product
- The post photo (Drive file ID) is from the existing `asset-catalog.md` mapping for that theme
- No competitor name is mentioned, no location-specific claim that isn't in `keyword-strategy.md`

**Escalate (status `awaiting-approval`)** for any of:
- Promo/pricing posts (Thursday Seasonal/Promotional posts that include a price or discount)
- Posts that mention a competitor or compare directly
- Posts with a video TikTok version (since video introduces brand voice risk that themed templates don't cover)
- Posts that include a new claim about response time, capacity, or coverage area

For escalated posts, send the WhatsApp preview as before. Add a **silent-veto rule**: if Blayke does not respond within 12 hours, treat the escalated post as auto-approved on the next daily-posting run. This prevents queue buildup while still giving Blayke a real veto window. Log silent-veto approvals in `lessons.md` so we can track which categories Blayke never vetoes (graduate them to auto-approve).

## Handling Owner Approval Messages
When Blayke replies with approval (e.g., "approved", "looks good", "approve all"):
- Update `pending-posts.md` top-level Status to "approved"
- Update each escalated day's Status from "awaiting-approval" to "approved"
- Confirm: "All N posts approved and queued for this week."

When Blayke requests changes (e.g., "change Wednesday to..." or "I don't like Tuesday's"):
- Update the specific day's content in `pending-posts.md`
- Reply with the updated post for confirmation
- Do NOT approve other days unless Blayke says so

## Daily Posting (Weekdays 9 AM CT)
A scheduled task reads `pending-posts.md` and posts today's approved content:
1. Find today's entry by date
2. If approved:
   a. If Drive file ID is present (not "NO PHOTO"):
      - Download the photo from Drive: `drive.ts download --file-id <id> --output /tmp/fb-photo.jpg`
      - Post with photo and location: `post-facebook.ts --message "..." --source /tmp/fb-photo.jpg --place-id <place_id>`
   b. If Drive file ID is "NO PHOTO":
      - Post text-only with geo-tag: `post-facebook.ts --message "..." --place-id <place_id>`
      - Do NOT pass `--source`. Text-only posts should follow the "40-80 chars + engagement hook" format.
   c. Record the post_id in `pending-posts.md` and `content-calendar.md` log
   d. **After posting to Facebook, also post to Instagram** using `post-instagram.ts` with the Instagram caption version and the same image. Record the Instagram post_id in `pending-posts.md`.
   e. **If today has a TikTok version** (video content): Post via `post-tiktok.ts` with the TikTok caption and video URL. Stagger 30-60 min after Instagram.
   f. **If today has a GBP post scheduled**: Post via `gbp.ts post` with summary, photo URL, and CTA link. GBP posts can go out any time (no stagger needed).
3. If not approved → skip and notify: "Skipping today's post — not yet approved"
4. If already posted → skip silently

## Weekly Performance Review (Saturday 10 AM CT)
A scheduled task measures engagement on this week's posts across all platforms:
1. Collect post_ids from `pending-posts.md` and `content-calendar.md`
2. Fetch Facebook insights via `read-facebook-insights.ts`
3. Fetch Instagram insights via `read-instagram-insights.ts` for all Instagram post_ids
4. Fetch GBP insights via `gbp.ts insights --days 7` for post views and actions
5. Note TikTok engagement (views, likes, comments) if TikTok posts were made
6. Compare hook types, themes, and engagement across all platforms
7. Update `content-learnings.md` with the week's best/worst performers per platform and key insights
8. Update `viral-patterns.md` if new patterns emerge
9. Send WhatsApp performance summary covering all platforms
