---
name: viral-content
description: Monitor trending content, learn viral patterns, and create high-engagement posts for SNAK Group. Use when asked to create viral content, analyze trends, or remix popular formats.
allowed-tools: Bash(npx tsx /workspace/project/tools/social/trend-scraper.ts *), Bash(npx tsx /workspace/project/tools/social/post-tweet.ts *), Bash(npx tsx /workspace/project/tools/social/post-facebook.ts *), Bash(npx tsx /workspace/project/tools/social/post-linkedin.ts *), Bash(npx tsx /workspace/project/tools/social/read-facebook-insights.ts *)
---

# Viral Content Engine

## Daily Trend Scan (8 AM)

Run the trend scraper for each platform with relevant queries. Rotate through these query sets:

**Coffee & Beverage:**
- "office coffee", "workplace coffee", "coffee machine office"

**Vending & Technology:**
- "vending machine", "smart vending", "vending technology"

**Workplace & HR:**
- "employee satisfaction breakroom", "workplace amenities"
- "workplace perks", "office perks employees"

**Ice & Equipment:**
- "ice machine", "commercial ice"

### Scan Commands

```bash
# Twitter/X scans
npx tsx /workspace/project/tools/social/trend-scraper.ts scan --platform twitter --query "office coffee" --limit 20
npx tsx /workspace/project/tools/social/trend-scraper.ts scan --platform twitter --query "vending machine" --limit 20
npx tsx /workspace/project/tools/social/trend-scraper.ts scan --platform twitter --query "workplace amenities" --limit 20

# LinkedIn scans
npx tsx /workspace/project/tools/social/trend-scraper.ts scan --platform linkedin --query "office coffee" --limit 20
npx tsx /workspace/project/tools/social/trend-scraper.ts scan --platform linkedin --query "vending technology" --limit 20
npx tsx /workspace/project/tools/social/trend-scraper.ts scan --platform linkedin --query "employee satisfaction breakroom" --limit 20

# Facebook competitor scans (use page IDs from competitors.md)
npx tsx /workspace/project/tools/social/trend-scraper.ts scan --platform facebook --query "<competitor_page_id>" --limit 10
```

## Weekly Competitor & Inspiration Scan (Before Sunday Post Generation)

Before generating the weekly posts, scan all three tiers of Facebook pages to learn what's working:

### Tier Priority
- **Tier 1 (Direct Competitors)**: Scan every page, every week. Look for gaps and positioning.
- **Tier 2 (Local Houston Crushers)**: Scan 3-5 pages per week (rotate through the list). These teach you what hooks and formats work for Houston audiences — the most valuable tier for content quality.
- **Tier 3 (National Brands)**: Scan 1-2 pages per week (rotate). Learn formats and structures worth adapting.

### Process
1. Read `competitors.md` for the active group (SNAK or Sheridan)
2. Scan each selected page:
   ```bash
   npx tsx /workspace/project/tools/social/trend-scraper.ts scan --platform facebook --query "<page_id>" --limit 10
   ```
3. Run analysis to see updated patterns:
   ```bash
   npx tsx /workspace/project/tools/social/trend-scraper.ts analyze
   ```
4. Note high-engagement posts across all tiers — what hooks, formats, photos, and topics are working?
5. Pay special attention to Tier 2 — if a Houston junk removal company gets 200 reactions on a before/after post, that format works for our audience too
6. Feed observations into `viral-patterns.md` and use them to inform the week's content
7. Update the "Latest Scan Notes" section in `competitors.md` with key findings per tier

After scanning, run analysis to update pattern knowledge:

```bash
npx tsx /workspace/project/tools/social/trend-scraper.ts analyze
```

## Pattern Learning

After scanning, run `analyze` to identify what's working. Update the viral-patterns knowledge by noting:

- **Hook structures** that get high engagement (stat-lead, question, POV, etc.)
- **Content formats** that perform best (thread, carousel, poll, single)
- **Visual styles** trending (before/after, POV, testimonial)
- **Engagement triggers** (questions, polls, challenges)

Review current patterns knowledge:

```bash
npx tsx /workspace/project/tools/social/trend-scraper.ts patterns
```

The patterns file lives at `groups/main/viral-patterns.md` — update it as new insights emerge.

## Content Remixing

Take trending formats and adapt them for SNAK Group. Examples:

### POV / Story Format
> "POV: You walk into work and there's a fresh espresso machine in the breakroom"

### Thread / Carousel Format
> "We've placed 50+ machines and here's what we learned (thread)"
> 1. Location matters more than the machine
> 2. Variety beats premium every time
> 3. ...

### Data / Stat-Lead Format
> "Companies with quality breakroom amenities see 23% less turnover. Here's why your vending matters more than you think."

### Before/After Format
> Breakroom transformation photos — old setup vs. new SNAK installation

### Customer Spotlight
> Quick case study in social format — real numbers, real results

### Cross-Posting
Adapt each piece for the target platform, then post:

```bash
# LinkedIn (long-form, professional)
npx tsx /workspace/project/tools/social/post-linkedin.ts --text "..."

# Twitter/X (concise, punchy)
npx tsx /workspace/project/tools/social/post-tweet.ts --text "..."

# Facebook (community-oriented)
npx tsx /workspace/project/tools/social/post-facebook.ts --message "..."
```

Never post identical content across platforms — adapt length, tone, and hashtags.

## Viral Attempt Schedule

- **Frequency**: 2-3 "viral attempt" posts per week mixed into regular content
- **Best days**: Wednesday and Friday for experimental content
- **A/B testing**: Try the same core message in two different formats
  - Example: Same insight as a stat-lead single post AND as a thread
  - Compare engagement after 48 hours

## Performance Tracking

After each viral attempt:

1. **Check engagement** after 24-48 hours
2. **Log results**: format used, hook type, engagement metrics
3. **Feed insights** back into pattern learning — update `groups/main/viral-patterns.md`
4. **Double down** on formats that work
5. **Retire** formats that consistently underperform

### Fetch Your Own Post Performance

```bash
npx tsx /workspace/project/tools/social/read-facebook-insights.ts \
  --post-ids "POST_ID_1,POST_ID_2"
```

Returns reactions, comments, shares, reach, impressions, clicks per post.
Use this to measure YOUR posts' engagement and compare hook types.

### Trend Analysis Command

```bash
npx tsx /workspace/project/tools/social/trend-scraper.ts analyze
```

This outputs:
- Top performing hook types (by average engagement)
- Top performing format types
- Common keywords/tags in high-engagement posts
- Best posting times
- Platform-level breakdown
