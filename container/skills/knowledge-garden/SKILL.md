---
name: knowledge-garden
description: Save articles and web pages to a personal library with summaries and tags. Search or browse saved items. Use when the user says "save this", "add to library", "archive this", drops a bare URL with intent to save, or asks what they saved about a topic.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch
---

# Knowledge Garden — Article Library

Manage a personal article library at `/workspace/group/library/`.

## When to activate

- User says "save this", "add to library", "archive this", "remember this"
- User drops a bare URL with no other context — treat as intent to save
- User asks "what did I save about X?", "find that article on Y", "search my library"
- User asks "what have I saved lately", "show my recent saves"

Do NOT save automatically on every URL mentioned. Only save on explicit intent.

---

## Storage

One `.md` file per saved article in `/workspace/group/library/`. No separate index — the YAML frontmatter in each file is the metadata, and `grep` handles search.

```
/workspace/group/library/
  2026-03-27-understanding-ai-scaling.md
  2026-03-28-the-cost-of-living-crisis.md
  ...
```

### File format

```markdown
---
url: https://example.com/article
title: Understanding AI Scaling Laws
platform: article
date: 2026-03-27
tags: [ai, scaling, neural-networks, research]
summary: A deep dive into how AI model performance scales with compute and data. The authors argue scaling alone is insufficient without architectural improvements.
---

# Understanding AI Scaling Laws

**Source:** example.com | **Saved:** 2026-03-27

## Summary

A deep dive into how AI model performance scales with compute and data...

## Key Takeaways

- Scaling laws hold across many orders of magnitude but show diminishing returns
- Data quality matters as much as data quantity at scale
- Architectural choices interact with scaling in non-obvious ways

## Full Content

[full extracted article text]
```

### Slug format

`YYYY-MM-DD-title-slug.md` — lowercase title, spaces and special chars replaced with hyphens, truncated to ~40 chars after the date. If title unavailable: `YYYY-MM-DD-domain-HHMMSS.md`.

---

## Saving an article

### Step 1 — Check for duplicates

Before fetching, check if the URL is already saved:

```bash
grep -rl "^url: URL_HERE" /workspace/group/library/ 2>/dev/null
```

If a match is found, tell the user it's already saved and show the existing entry. Offer to update tags or summary if they want.

### Step 2 — Detect link type and extract

**Supported (articles, blogs, news, Reddit, PDFs):**

```bash
# Primary: WebFetch
# Use WebFetch on the URL — it handles HTML articles and PDFs natively
```

If the fetched body is empty or under ~200 characters, fall back to agent-browser:

```bash
agent-browser open <url>
agent-browser wait --load networkidle
agent-browser snapshot -c
agent-browser get text @main
agent-browser close
```

Note if content appears truncated due to a paywall — still save what's visible.

**Out of scope (YouTube, TikTok, Twitter/X, Instagram):**

Tell the user: "video and social media links aren't supported in the library yet — I can save just the URL and title if you want, or search the web for a written summary."

### Step 3 — Generate metadata

From the extracted content, generate:

- `title` — the article's actual title (not the URL)
- `platform` — `article`, `reddit`, `pdf`, or `other`
- `date` — today's date (YYYY-MM-DD)
- `tags` — 3–6 lowercase topic tags derived from content (e.g. `[ai, scaling, research]`)
- `summary` — 2–3 sentences covering the main point
- `takeaways` — 3–5 key ideas as bullet points (go in the body, not frontmatter)

### Step 4 — Write the file

Ensure the library directory exists:

```bash
mkdir -p /workspace/group/library
```

Write the file to `/workspace/group/library/{slug}.md` using the format shown above. Include the full extracted text under "## Full Content" — no length limit.

### Step 5 — Reply to user

Reply in WhatsApp format (single asterisks for bold, `•` bullets, no `##` headings, no `[links](url)`):

```
saved: *Title of the Article*

*Summary:* Two to three sentence summary here.

*Takeaways:*
• Key point one
• Key point two
• Key point three

_platform • date_
```

---

## Searching the library

### Quick keyword search

```bash
# Search across all text (titles, tags, summaries, content)
grep -ril "keyword" /workspace/group/library/

# Search only frontmatter tags
grep -rl "tags:.*keyword" /workspace/group/library/

# List all saved titles
grep -rh "^title:" /workspace/group/library/ | sed 's/title: //'
```

### Semantic search

For fuzzy or topic-based queries, read the frontmatter of each file (first 15 lines) to get metadata without loading full content, then reason over it:

```bash
for f in /workspace/group/library/*.md; do head -15 "$f"; echo "---FILE: $f---"; done
```

Once you've identified matching files, read them in full if the user wants the content.

### Reply format for search results

List matches with title, one-line summary, and URL. If nothing matches, say so and offer to search the web instead.

---

## Listing recent saves

```bash
ls -t /workspace/group/library/*.md 2>/dev/null | head -10
```

Then read the frontmatter of each to show title, date, and summary.

---

## Edge cases

- **Paywalled content:** Use agent-browser fallback. Save what's visible and note "content may be truncated (paywall)" in the summary.
- **PDF links:** WebFetch handles PDFs — extract the text directly.
- **No extractable content:** Save the URL and title only, set summary to "content not extractable".
- **Reddit:** WebFetch usually works. If it returns the login page, use agent-browser.
- **Duplicate URL:** Report the existing saved entry to the user. Don't overwrite unless asked.
