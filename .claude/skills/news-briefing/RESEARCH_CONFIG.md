# News Briefing Research Configuration

## Article Date Range

**Current Setting:** Articles from TODAY and YESTERDAY

**Logic:**
- Search for articles published in the last 24-48 hours
- Include both today's date and yesterday's date
- Deduplication system prevents showing the same article twice

**Why this approach:**
- Catches late-breaking news from yesterday evening
- Catches early morning news that might not have today's timestamp yet
- More comprehensive coverage
- Deduplication ensures no duplicates across daily briefings

## Example:
If briefing runs on March 10, 2026 at 7:00 AM:
- Include articles from March 10, 2026
- Include articles from March 9, 2026
- Exclude articles already shown in March 9 briefing (via deduplication)

## Implementation:
Research agent should use queries like:
- "AI news March 9-10 2026"
- "breaking news March 2026 latest"
- "stock market today March 10"

And accept articles with:
- `published_date = "2026-03-10"` OR
- `published_date = "2026-03-09"`

Deduplication happens automatically in compile_briefing.py using article_id matching.
