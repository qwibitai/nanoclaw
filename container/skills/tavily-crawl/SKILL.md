---
name: tavily-crawl
description: Crawl and extract many pages from one site with Tavily when the user wants an entire docs section, a site export, or multi-page context from the same domain.
allowed-tools: Bash(tvly *)
---

# Tavily Crawl

Use `tvly crawl` to extract content from many pages on the same site.

## Before you start

```bash
tvly --status
```

If the command is unavailable or not authenticated, stop and tell the user Tavily is not configured.

## When to use

- The user wants a docs section or many pages from the same domain
- You need offline markdown files in the group workspace
- A single extract is too narrow

## Quick commands

```bash
tvly crawl "https://docs.example.com" --json
tvly crawl "https://docs.example.com" --output-dir ./docs/
tvly crawl "https://docs.example.com" --max-depth 2 --limit 50 --json
tvly crawl "https://example.com" --select-paths "/api/.*,/guides/.*" --exclude-paths "/blog/.*" --json
tvly crawl "https://docs.example.com" --instructions "Find authentication docs" --chunks-per-source 3 --json
```

## Tips

- Start with conservative limits.
- Use `--instructions` plus `--chunks-per-source` for agent-facing summaries instead of full-page dumps.
- Use `--output-dir` when the goal is to save local markdown files.
- If you only need a few pages, use `map` plus `extract` instead.
