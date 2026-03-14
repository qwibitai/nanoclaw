---
name: social-posting
description: Post content to X (Twitter), Facebook, and LinkedIn. Manage LinkedIn warm outreach and connection requests. Use when asked to post on social media, share content, manage social presence, or do LinkedIn outreach.
allowed-tools: Bash(npx tsx /workspace/project/tools/social/post-tweet.ts *), Bash(npx tsx /workspace/project/tools/social/post-facebook.ts *), Bash(npx tsx /workspace/project/tools/social/post-linkedin.ts *), Bash(npx tsx /workspace/project/tools/social/linkedin-connect.ts *), Bash(npx tsx /workspace/project/tools/social/read-facebook-insights.ts *), Bash(npx tsx /workspace/project/tools/drive/drive.ts *)
---

# Social Media Posting

## Post to X (Twitter)

```bash
npx tsx /workspace/project/tools/social/post-tweet.ts \
  --text "Your tweet content (max 280 chars)"
```

Options:
- `--text` (required): Tweet content (280 char limit)
- `--reply-to`: Tweet ID to reply to

## Post to Facebook Page

```bash
npx tsx /workspace/project/tools/social/post-facebook.ts \
  --message "Your post content"
```

Options:
- `--message` (required): Post content
- `--link`: URL to include
- `--image`: Image URL to attach (Facebook fetches it)
- `--source`: Local file path to upload (image or video) — mutually exclusive with `--image`
- `--place-id`: Facebook Place ID for location tagging

### Upload a Photo from Local File (Drive → Facebook)

```bash
# 1. Search Drive for the photo
npx tsx /workspace/project/tools/drive/drive.ts search --name "vitro coffee" --mime "image/jpeg"

# 2. Download the photo
npx tsx /workspace/project/tools/drive/drive.ts download --file-id <id> --output /tmp/fb-photo.jpg

# 3. Post with photo and location tag
npx tsx /workspace/project/tools/social/post-facebook.ts \
  --message "Your post content" \
  --source /tmp/fb-photo.jpg \
  --place-id "<houston_place_id>"
```

### Upload a Video from Local File

```bash
npx tsx /workspace/project/tools/social/post-facebook.ts \
  --message "Your post content" \
  --source /tmp/video.mp4
```

Videos route to the `/{pageId}/videos` endpoint automatically (detected by file extension).

## Post to LinkedIn

```bash
npx tsx /workspace/project/tools/social/post-linkedin.ts \
  --text "Your post content"
```

Options:
- `--text` (required): Post content
- `--link`: URL to share
- `--visibility`: "PUBLIC" (default) or "CONNECTIONS"

## LinkedIn Connection Outreach

Send personalized LinkedIn connection requests and messages.

### Send a Connection Request

```bash
npx tsx /workspace/project/tools/social/linkedin-connect.ts connect \
  --linkedin-url "https://linkedin.com/in/johndoe" \
  --note "Hi John, I noticed..." \
  --contact-id "abc123"
```

Options:
- `--linkedin-url` (required): Full LinkedIn profile URL
- `--note` (required): Connection request message (max 300 characters)
- `--contact-id` (optional): CRM contact ID to update notes with connection timestamp

### Send a Message to a Connection

```bash
npx tsx /workspace/project/tools/social/linkedin-connect.ts message \
  --linkedin-url "https://linkedin.com/in/johndoe" \
  --text "Thanks for connecting! I'd love to chat about..."
```

Options:
- `--linkedin-url` (required): Full LinkedIn profile URL
- `--text` (required): Message content

### Batch Connection Requests

Automatically sends personalized connection requests to CRM contacts with LinkedIn URLs who haven't been connected yet. Contacts are prioritized by lead score.

```bash
npx tsx /workspace/project/tools/social/linkedin-connect.ts batch \
  --limit 15
```

Options:
- `--limit` (optional): Max connections to send per run (default: 15)

Note: Batch mode includes a 30-second delay between requests to avoid LinkedIn rate limits. A run of 15 connections takes approximately 7 minutes.

## Daily Content Posting Schedule

### Monday: Industry Insight
- Coffee at work productivity stats
- Vending technology trends
- Workplace amenity innovations
- Example: "Studies show employees with quality break room amenities are 23% more productive. Here's what leading Houston companies are doing differently..."

### Tuesday: Quick Tip
- Breakroom optimization ideas
- Employee satisfaction strategies
- Vending machine placement best practices
- Example: "Quick tip: Place your vending machine within 30 seconds of the most-used work area. Convenience drives 3x more usage."

### Wednesday: Case Study / Before-After
- Location spotlight (a specific client transformation)
- Revenue or satisfaction metrics
- Before/after breakroom photos
- Example: "When [Company] upgraded their break room with our premium coffee solution, employee satisfaction scores jumped 40% in 3 months."

### Thursday: Thought Leadership
- Future of workplace amenities
- Industry predictions and analysis
- Opinion pieces on vending/coffee trends
- Example: "The future of office vending isn't just snacks -- it's data-driven personalization. Here's why smart vending is the next big thing in employee experience."

### Friday: Engagement Post
- Polls ("What's your go-to afternoon pick-me-up?")
- Questions ("What's the one thing missing from your office break room?")
- Behind-the-scenes content (restocking, machine installs, team photos)
- Fun content (coffee facts, snack debates)

## LinkedIn Warm Connection Outreach Workflow

Target: 10-20 connections per day, prioritized by lead score.

### Daily Workflow

1. **Run batch connections** (morning):
   ```bash
   npx tsx /workspace/project/tools/social/linkedin-connect.ts batch --limit 15
   ```

2. **Check for new accepted connections** and send follow-up messages to recent acceptors:
   ```bash
   npx tsx /workspace/project/tools/social/linkedin-connect.ts message \
     --linkedin-url "https://linkedin.com/in/prospect" \
     --text "Thanks for connecting! I help Houston businesses upgrade their break rooms with premium vending and coffee. Would love to learn about your current setup sometime."
   ```

3. **Post daily content** to LinkedIn (see schedule above)

4. **Engage with connections' posts** -- like and comment on prospects' content to stay visible

### Connection Request Templates

- **General**: "Hi {{first_name}}, I noticed {{company}} in the Houston area. We help businesses like yours with premium vending and coffee solutions. Would love to connect!"
- **Industry-specific**: "Hi {{first_name}}, I work with Houston {{industry}} companies on workplace amenity solutions. Would love to connect and share some insights."
- **Referral-based**: "Hi {{first_name}}, {{referrer_name}} suggested we connect. I help Houston businesses with premium vending and coffee -- would love to chat."

## Comment Engagement Guidelines

When engaging with prospects' LinkedIn posts:

1. **Add genuine value** -- don't just say "Great post!" Reference a specific point they made
2. **Share a relevant insight** or statistic that builds on their topic
3. **Ask a thoughtful follow-up question** to start a conversation
4. **Keep comments concise** -- 2-3 sentences max
5. **Avoid pitching in comments** -- build rapport first, sell later
6. **Engage consistently** -- comment on a prospect's posts 2-3 times before sending a direct message
7. **Be timely** -- comment within the first few hours of a post for maximum visibility

## Platform-Specific Guidelines

### X/Twitter
- Max 280 characters
- Use hashtags strategically (2-3 per tweet)
- Best times: 9 AM, 12 PM, 5 PM

### Facebook
- Optimal length: 40-80 characters for engagement
- **ALWAYS include a real photo** from the asset catalog — photo posts get 2x+ engagement vs text-only
- Use `--place-id` on every post for Houston geo-targeting
- Ask questions to drive engagement
- Include 1 geo hashtag (#Houston, #Tomball, etc.) per post

### LinkedIn
- Professional tone
- 1,300 characters is the sweet spot
- Use line breaks for readability
- Post industry insights and thought leadership

## Read Facebook Post Insights

```bash
npx tsx /workspace/project/tools/social/read-facebook-insights.ts \
  --post-ids "POST_ID_1,POST_ID_2"
```

Returns engagement metrics per post: reactions, comments, shares, reach, impressions, clicks.
Falls back gracefully if `read_insights` permission is unavailable (still returns reactions/comments/shares).

## Cross-Platform Posting

When posting the same content across platforms, adapt the message for each:
1. Start with the core message
2. Adjust length for each platform
3. Add platform-specific elements (hashtags for Twitter, professional tone for LinkedIn)
4. Never post identical content across all platforms
