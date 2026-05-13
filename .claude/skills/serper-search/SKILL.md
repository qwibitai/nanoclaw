---
name: serper-search
description: Use the Serper MCP for raw Google SERP queries — organic results, "people also ask", related searches, knowledge graph, SERP-feature checks, competitor positioning, keyword discovery. Tools live behind `mcp__serper__*` (`google_search`, `scrape`). Triggers on "serper", "google serp", "people also ask", "related searches", "serp features", "keyword research", "what does google show for", "competitor positioning", "scrape this url".
---

# Serper Search

The `serper` MCP exposes two Google-backed tools via Serper.dev:

- `mcp__serper__google_search` — fetch the raw Google SERP for a query. Returns organic results, ads, "people also ask", related searches, and the knowledge graph when present. Use when the *shape* of the SERP matters, not just a factual answer.
- `mcp__serper__scrape` — fetch a URL and return its content as markdown. Comparable to `WebFetch` but driven by Serper's scraper.

## When to pick Serper vs the other tools

| Question | Tool |
|---|---|
| "Who is X?" / "What is Y?" / single-fact lookup | `mcp__parallel-search__*` |
| "Research X in depth — give me a citation-backed report" | `mcp__parallel-task__*` (always ask first, use scheduler pattern) |
| "What does Google rank for `<keyword>`?" / "Show me the SERP" | `mcp__serper__google_search` |
| "What are the related searches / PAA questions for `<topic>`?" | `mcp__serper__google_search` |
| "Is competitor X ranking for keyword Y? Top 10 list?" | `mcp__serper__google_search` |
| "Pull the markdown of this article" | `mcp__serper__scrape` (or `WebFetch` for simpler pages) |
| Privacy-leaning ad-hoc general web search | Brave Search (`api.search.brave.com` via OneCLI) |
| Need to interact with a page (click, login, JS render) | `agent-browser` |

The mental model:

- **Parallel** is for *answers*. It synthesizes across sources and hands back a written response.
- **Serper** is for the *Google page itself*. The output is structured SERP data — same as opening google.com would give you.
- **Brave** is a privacy-friendly general web search alternative — useful for cross-checking Google or when Google is geo-skewed for the question.

If you're writing copy, picking keywords, or auditing how a brand appears to a searcher, you want Serper. If you want to know an answer, you want Parallel.

## Example invocations

1. **SEO research — what ranks today?**
   > "Use Serper to search for `self storage software` and list the top 10 organic results plus the related searches."

2. **PAA mining for content briefs.**
   > "Pull the `people also ask` and related searches for `revops consultant` via Serper — I'm planning a landing page and want the question framing customers actually use."

3. **Competitor positioning.**
   > "Serper: search `meadowfi vs competitors` and `meadow finance review`. Tell me which competitors show up in the SERP and snippets."

4. **Knowledge-graph check.**
   > "Use Serper to search for `Cubby Storage`. Does Google have a knowledge graph entry yet? What does it pull in?"

5. **Quick page scrape.**
   > "Scrape https://www.firstcubby.com/about with Serper and summarize their positioning in 3 bullets."

## Implementation notes

- Auth path: stdio MCP via `serper-search-scrape-mcp-server` (npm, marcopesani's TypeScript implementation). Reads `SERPER_API_KEY` from container env. The host forwards the value from `.env` (host-side passthrough — see `collectMcpEnvPassthrough` in `src/container-runner.ts`) and the agent-runner expands the `${SERPER_API_KEY}` placeholder before spawning the MCP child (`expandMcpEnv` in `container/agent-runner/src/index.ts`).
- Why stdio: Serper does not host an MCP-protocol endpoint, so the OneCLI proxy injection path (used for Parallel) is not available. The vault `SERPER` secret is configured for the canonical `X-API-KEY` header (no Bearer prefix) so it stays correct if/when an HTTP MCP becomes available.

### Wiring it into a group

Set `SERPER_API_KEY=...` in your host `.env`, then add the MCP to the agent group's container config:

```bash
ncl groups config add-mcp-server --id <agent-group-id> \
  --name serper \
  --command npx \
  --args '["-y","serper-search-scrape-mcp-server@0.1.2"]' \
  --env '{"SERPER_API_KEY":"${SERPER_API_KEY}"}'
```

Then restart the agent group: `ncl groups restart --id <agent-group-id>`.
