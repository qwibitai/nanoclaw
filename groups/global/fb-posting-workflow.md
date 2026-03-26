# Facebook Page Posting — Weekly Approval Workflow

## Weekly Post Generation (Sunday 6 PM CT)
A scheduled task generates next week's 5 Facebook posts (Mon-Fri) and sends them to the group chat for owner approval.

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
6. Write all posts to `pending-posts.md` with status "awaiting-approval" — each entry must include: message text, Drive file ID for the photo (or "NO PHOTO"), place-id from `houston-places.md`, and the Instagram caption version alongside the Facebook version.
7. Send WhatsApp preview of all 5 posts for owner review

## Handling Approval Messages
When the owner replies with approval (e.g., "approved", "looks good", "approve all"):
- Update `pending-posts.md` top-level Status to "approved"
- Update each day's Status from "pending" to "approved"
- Confirm: "All 5 posts approved and queued for this week."

When the owner requests changes (e.g., "change Wednesday to..." or "I don't like Tuesday's"):
- Update the specific day's content in `pending-posts.md`
- Reply with the updated post for confirmation
- Do NOT approve other days unless the owner says so

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
3. If not approved → skip and notify: "Skipping today's post — not yet approved"
4. If already posted → skip silently

## Weekly Performance Review (Saturday 10 AM CT)
A scheduled task measures engagement on this week's posts:
1. Collect post_ids from `pending-posts.md` and `content-calendar.md`
2. Fetch insights via `read-facebook-insights.ts`
3. Compare hook types, themes, and engagement across the week
4. Update `content-learnings.md` with the week's best/worst performers and key insight
5. Update `viral-patterns.md` if new patterns emerge
6. Send WhatsApp performance summary
