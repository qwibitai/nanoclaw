---
name: firecrawl
description: Use the Firecrawl MCP for clean web scraping, full-site crawling, URL mapping, structured extraction, and search-plus-scrape. Tools live behind `mcp__firecrawl__*` (`scrape`, `crawl`, `check_crawl_status`, `map`, `search`, `extract`). Triggers on "firecrawl", "scrape this url", "crawl this site", "map this site", "extract pricing from", "extract structured data from", "ingest this page to wiki", "competitor content audit", "site crawl".
---

# Firecrawl

The `firecrawl` MCP wraps Firecrawl.dev — a web scraping API that returns LLM-ready markdown, can crawl whole sites asynchronously, and supports schema-based structured extraction across many URLs at once.

## Tools

| Tool | Use |
|---|---|
| `mcp__firecrawl__scrape` | Single URL → clean markdown. Strips nav, footer, cookie banners, ads. Better than `WebFetch` when you need full-fidelity content, not a summary. |
| `mcp__firecrawl__crawl` | Walk a whole site (async) — returns a `crawl_id`. Use for competitor content audits, mapping a docs site, ingesting an entire knowledge base. |
| `mcp__firecrawl__check_crawl_status` | Poll a `crawl_id` until status=completed; returns the list of pages with markdown. |
| `mcp__firecrawl__map` | URL discovery only — returns every URL Firecrawl can reach from the seed. Cheap; use to scope a crawl before running one. |
| `mcp__firecrawl__search` | Web search + scrape in one call — search query → SERP results with full page content. |
| `mcp__firecrawl__extract` | Schema-based structured extraction. Hand it URLs + a JSON schema, get back JSON. Use for pricing tables, team bios, feature lists across many vendor pages. |

## When to pick Firecrawl vs the other tools

| Need | Tool |
|---|---|
| "Pull this page as clean markdown — full content, no summary" | `mcp__firecrawl__scrape` |
| "Map every page on competitor.com" | `mcp__firecrawl__map` then `crawl` if you want the content |
| "Extract pricing / features / team from these 12 vendor sites" | `mcp__firecrawl__extract` (one call, schema-driven) |
| "Search the web and pull the full content of the top hits" | `mcp__firecrawl__search` |
| Synthesized factual answer from across the web | `mcp__parallel-search__*` (no crawling, returns an answer) |
| Raw Google SERP, PAA, related searches | `mcp__serper__google_search` |
| Voice-of-customer / community discourse | `mcp__reddit__*` |
| Page requires login, click, JS interaction, or form filling | `agent-browser` (interactive — one page at a time) |
| Quick fetch + summarize a single page | `WebFetch` (lighter than Firecrawl when you just need a summary) |

The mental model:

- **Firecrawl** is the heavy-duty *content extractor*. It handles JS-rendered pages, gives you clean output ready to index, and can fan out across a whole site. The pricing is per-page so it's worth reserving for cases where the content quality or the scale matters.
- **Parallel** is for *synthesized answers*. It can't crawl a specific site for you.
- **Serper** is for *raw SERPs*. It can scrape a URL, but Firecrawl's output is cleaner and supports structured extraction.
- **agent-browser** is for *interactive* work — anything that needs a real session (login, clicks, form filling). Firecrawl is one-shot per URL.
- **WebFetch** is the lightweight option — fast, summarizing, no crawl.

## Example invocations

1. **Scrape a single page for clean marketing copy.**
   > "Use Firecrawl to scrape https://cubbystorage.com and return the main marketing copy as markdown — I want to feed it to the copy grader."

2. **Map a competitor's content footprint.**
   > "Run `mcp__firecrawl__map` on https://www.neighbor.com to list every URL Firecrawl can find. Then crawl the top 30 highest-value pages (pricing, features, blog) and summarize their content strategy."

3. **Schema-based extraction across competitors.**
   > "Use Firecrawl extract on these 6 self-storage competitor sites (Public Storage, Extra Space, Cubesmart, Life Storage, Neighbor, Stuf): pull `{ pricing_tiers, free_trial_offered, primary_value_prop, target_market }` for each."

4. **Ingest an article into the wiki with full fidelity.**
   > "Wiki: scrape https://www.example.com/founders-essay with Firecrawl and save the markdown under `50-Sources/`. Then ingest it as usual — `WebFetch` was truncating the body."

5. **Search + scrape for a research sprint.**
   > "Firecrawl search for `embedded finance 2026 trends`. Return the top 8 results with full page content so I can pull quotes for the Cache positioning doc."

## Implementation notes

- Wired into agent groups: `dm-with-brad` (Zed), `wiki` (Wiki). The `news` group will add it separately if/when needed.
- Auth path: stdio MCP via the official `firecrawl-mcp` npm package. Reads `FIRECRAWL_API_KEY` from container env. The host forwards the value from `.env` (host-side passthrough — see `collectMcpEnvPassthrough` in `src/container-runner.ts`).
- The vault `FIRECRAWL` secret (hostPattern `*.firecrawl.dev`, `Authorization: Bearer {value}`) handles proxy injection for direct API calls from Bash. The stdio MCP bypasses the OneCLI proxy and reads the env var directly — `.env` must contain `FIRECRAWL_API_KEY=<value>` for the MCP to authenticate.
- Tool allowlist entry: `mcp__firecrawl__*` in `container/agent-runner/src/providers/claude.ts`.
- Pricing: Firecrawl charges per-page (scrape) and per-page-crawled. Prefer `map` first to scope, then `crawl` only the pages worth the cost. For a single URL summary, `WebFetch` is free and usually sufficient.
