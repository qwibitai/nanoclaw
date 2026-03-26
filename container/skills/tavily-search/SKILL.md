---
name: tavily-search
description: Search the web with Tavily when the user needs current information, sources, recent news, or pages on a topic and no exact URL is known yet.
allowed-tools: Bash(tvly *)
---

# Tavily Search

Use `tvly search` to find relevant pages and short content summaries.

## Before you start

```bash
tvly --status
```

If the command is unavailable or not authenticated, stop and tell the user Tavily is not configured.

## When to use

- The user wants current web information
- You need sources before extracting content
- You need recent news or domain-filtered results

## Quick commands

```bash
tvly search "OpenAI pricing changes" --json
tvly search "TypeScript decorators" --depth advanced --max-results 10 --json
tvly search "AI regulation news" --topic news --time-range week --json
tvly search "SEC filings" --include-domains sec.gov,reuters.com --json
tvly search "React hooks guide" --include-raw-content --max-results 3 --json
```

## Tips

- Keep the query short and search-like rather than prompt-like.
- Use `--include-domains` or `--exclude-domains` when source quality matters.
- Use `--include-raw-content` if you may not need a separate extract step.
- For a known URL, switch to `tvly extract`.
