---
name: tavily-cli
description: Use Tavily inside the NanoClaw runtime container for web search, page extraction, site crawling, URL discovery, and deep research when a chat task needs current web information.
allowed-tools: Bash(tvly *)
---

# Tavily CLI

Use the `tvly` CLI for current web information from inside the NanoClaw runtime container.

## Before you start

Verify that Tavily is available and authenticated:

```bash
tvly --status
```

If `tvly` is missing or authentication fails, stop and tell the user that Tavily is not configured on this NanoClaw instance.

## Workflow

Start simple and escalate only when needed:

1. `tvly search` — discover pages when you do not have a URL yet
2. `tvly extract` — pull content from one or more known URLs
3. `tvly map` — discover URLs on a site before extracting
4. `tvly crawl` — extract many pages from one site
5. `tvly research` — produce a longer cited report

## Quick checks

```bash
tvly search "latest Anthropic API changes" --json
tvly extract "https://example.com/docs" --json
tvly map "https://docs.example.com" --json
tvly crawl "https://docs.example.com" --limit 20 --json
tvly research "AI agent framework comparison" --json
```

## Rules

- Quote all queries and URLs.
- Prefer `--json` when you need structured output.
- Save large crawl or research outputs to files in the group workspace when they would be too large for a chat response.
- Use Tavily for search and research tasks; use `agent-browser` when the task requires interactive browsing or visual page interaction.
