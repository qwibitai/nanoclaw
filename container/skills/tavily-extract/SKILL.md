---
name: tavily-extract
description: Extract clean page content from one or more known URLs with Tavily, including JavaScript-heavy pages, when the user already has a page in mind.
allowed-tools: Bash(tvly *)
---

# Tavily Extract

Use `tvly extract` when you already know the URL and want the page content.

## Before you start

```bash
tvly --status
```

If the command is unavailable or not authenticated, stop and tell the user Tavily is not configured.

## When to use

- The user gives you a URL
- Search results identified the exact page you need
- You need clean markdown or text from a JS-rendered page

## Quick commands

```bash
tvly extract "https://example.com/article" --json
tvly extract "https://example.com/page1" "https://example.com/page2" --json
tvly extract "https://example.com/docs" --query "authentication API" --chunks-per-source 3 --json
tvly extract "https://app.example.com" --extract-depth advanced --json
tvly extract "https://example.com/article" -o article.md
```

## Tips

- Use `--query` with `--chunks-per-source` when you only need the relevant parts of a long page.
- Try `--extract-depth basic` first and fall back to `advanced` for dynamic sites.
- Batch up to 20 URLs per request.
- If you do not know the URL yet, start with `tvly search` or `tvly map`.
