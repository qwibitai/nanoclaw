---
name: tavily-map
description: Discover URLs on a website with Tavily when you need to find where something lives on a domain before extracting or crawling content.
allowed-tools: Bash(tvly *)
---

# Tavily Map

Use `tvly map` to discover site URLs without extracting page content.

## Before you start

```bash
tvly --status
```

If the command is unavailable or not authenticated, stop and tell the user Tavily is not configured.

## When to use

- You know the site but not the exact page
- You want a URL list before deciding what to extract
- You want to narrow a crawl to the right section

## Quick commands

```bash
tvly map "https://docs.example.com" --json
tvly map "https://docs.example.com" --instructions "authentication docs" --json
tvly map "https://example.com" --select-paths "/blog/.*" --limit 500 --json
tvly map "https://example.com" --max-depth 3 --limit 200 --json
```

## Tips

- `map` finds URLs only; it does not return page content.
- Use `--instructions` when the site structure is unclear.
- Use `map` plus `extract` when you only need a few pages from a large site.
- Use `crawl` when you need many pages from the same site.
