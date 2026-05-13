---
name: social-listening
description: Composite social listening across Brad's existing search/research tools — fans out a brand or topic query across Serper (Google News + web), Reddit MCP (curated subreddits + global search), Parallel Search (synthesized sentiment), Brave Search (alt web), and feed-mcp/RSS (tracked industry pubs), then returns a structured report with sentiment tags, key quotes, and links. Trigger on "social listening", "monitor mentions of X", "brand monitoring", "what are people saying about X", "track X across reddit and news", "competitor mentions", "/social-listening".
---

# Social Listening

`/social-listening <brand|topic>` runs a parallel, multi-source sweep for mentions of a brand, product, or topic, then returns a single structured markdown report. The point is to replace paid tools (Brand24, Mentionlytics, Brandwatch) with a composition of what Brad already pays for: Serper, Reddit MCP, Parallel Search, Brave, and feed-mcp / RSS. Zero per-query cost beyond existing subscriptions.

## When to use

Trigger this skill when the user says any of:

- "social listening for X"
- "monitor mentions of X"
- "brand monitoring on X"
- "what are people saying about X"
- "track X across reddit and news"
- "competitor sentiment for X"
- "/social-listening X"

For one-off ad-hoc lookups (single source, no synthesis), prefer a direct tool call (`mcp__serper__search`, `mcp__reddit__search`, etc.) rather than the full fan-out.

## Tool dependencies

This skill assumes the broader stack expansion is in place. Graceful degradation is required — if a tool isn't available in this agent group, **skip it and proceed**, then note it in the report's "Sources searched" section.

| Source            | Tool                                | Provided by   | Required?            |
| ----------------- | ----------------------------------- | ------------- | -------------------- |
| Google News + web | `mcp__serper__search`               | Unit 1        | No — fall back to WebSearch |
| Reddit            | `mcp__reddit__*`                    | Unit 3        | No — fall back to WebSearch with `site:reddit.com` |
| RSS / industry    | `mcp__feed-mcp__*` (or equivalent)  | Unit 4        | No — skip if missing |
| Parallel Search   | `mcp__parallel-search__search`      | already wired | No — skip if missing |
| Brave Search      | Brave gateway via `curl`            | already wired | No — skip if missing |
| Fallback          | `WebSearch`, `WebFetch`             | core          | Always available     |

If none of the optional MCPs are available, the skill must still produce a useful report using only `WebSearch` + `WebFetch`.

## Workflow

### 1. Parse the target

Pull the brand/topic from the user prompt. Strip the slash command prefix if present. Examples:

- `/social-listening Cubby Storage` → target = `"Cubby Storage"`
- `/social-listening "HubSpot operations hub"` → target = `"HubSpot operations hub"`
- `social listening for Cache Financials` → target = `"Cache Financials"`

If the target is ambiguous (e.g. just "Cache" — could be Cache Financials, CPU cache, cache invalidation), use `mcp__nanoclaw__ask_user_question` to disambiguate before fanning out. Don't burn tokens on a fuzzy query.

### 2. Classify the target

Decide the source mix based on what the target *is*. This biases which subreddits and feeds get prioritized.

| Target type             | Reddit emphasis                                           | News emphasis                              |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------ |
| SaaS / B2B brand        | r/sales, r/SaaS, r/{vertical}, Hacker News, r/startups    | TechCrunch, industry pubs, Google News     |
| Consumer brand          | r/{category}, r/BuyItForLife, r/reviews, broad search     | Google News, mainstream press              |
| Industry topic          | r/{vertical} community subs                               | Trade publications, Google News           |
| Person / executive      | r/{their_company}, broad Reddit search                    | LinkedIn posts (via WebSearch), Google News|

Pick **3–6 curated subreddits** for the target. Examples from Brad's real client roster:

- **Cubby Storage** (self-storage SaaS) → `r/selfstorage`, `r/storageunits`, `r/Entrepreneur`, `r/smallbusiness`
- **Cache Financials** (fintech / wealth mgmt) → `r/fintech`, `r/wealthmanagement`, `r/personalfinance`, `r/financialadvisors`, `r/CFP`
- **HubSpot Operations Hub** (RevOps tooling) → `r/sales`, `r/hubspot`, `r/RevOps`, `r/marketing`, `r/SaaS`
- **Falcone Global** (logistics WP site) → `r/logistics`, `r/supplychain`, `r/freightbrokers`
- **A generic AI/ML product** → `r/MachineLearning`, `r/LocalLLaMA`, `r/singularity`, `r/artificial`

When in doubt, also include `r/all`-style cross-reddit search via the Reddit MCP's global search tool.

### 3. Run searches in parallel

Issue all available source queries in a **single tool-call batch** (multiple tool calls in one assistant message). Each call should request the most recent 10–25 items where the tool supports time filtering.

Use roughly these queries per source — adapt as needed:

```
Serper Google News:    "<target>" — news search, last 7 days
Serper general web:    "<target>" reviews OR experience OR feedback — web search
Reddit subreddit:      for each curated sub → search posts mentioning <target> (last month)
Reddit global:         search across all of Reddit for <target> (last month, sort=relevance and sort=new)
Parallel Search:       Synthesized answer to "What are people currently saying about <target>? Include sentiment, common complaints, and praise."
Brave Search:          "<target>" — fresh web results (call via curl to the Brave gateway)
Feed MCP:              Pull recent items from tracked industry feeds (filter for <target> mentions)
WebSearch (fallback):  "<target>" mention OR review OR discussion — for any source that wasn't available
```

For Brave, the gateway URL is the standard one already wired in the agent's container — call it the same way you'd call any other vault-gated HTTP API:

```bash
curl -s "https://api.search.brave.com/res/v1/web/search?q=$(printf '%s' "$target" | jq -sRr @uri)&freshness=pw" \
  -H "Accept: application/json"
```

(The vault injects `X-Subscription-Token` automatically when the request matches the Brave host pattern.)

If `mcp__feed-mcp__*` is wired in this group, list the available feeds first, then filter their recent items for `<target>` (case-insensitive, in title or body).

### 4. Dedupe and structure

Collect every URL returned across sources. Dedupe by canonical URL (drop UTM params, fragments, trailing slashes). For Reddit, treat `old.reddit.com`, `reddit.com`, and `redd.it` as equivalent.

Tag each kept item with:

- **source** — `serper-news` | `serper-web` | `reddit-r/<sub>` | `reddit-global` | `parallel` | `brave` | `feed-<feed-name>` | `websearch-fallback`
- **freshness** — `<24h` | `<7d` | `<30d` | `older`
- **sentiment** — `positive` | `neutral` | `negative` | `mixed` (read the snippet/title; if unsure, mark `neutral` and don't bluff)
- **quote** — the most representative phrase from the snippet, with the URL

If a single item appears across multiple sources, keep one entry and list all source tags on it.

### 5. Output the report

Always emit a single markdown report in this shape. Keep it scannable — Brad reads these on his phone.

```markdown
# Social Listening — <target>

**Window:** <date range covered, e.g. "last 7 days">
**Sources searched:** <comma list of sources that actually returned data; note any that were unavailable>
**Total unique mentions:** <N>
**Overall sentiment:** <positive | neutral | negative | mixed> — <one-sentence rationale>

## TL;DR

- <3–5 bullets covering the most important finding, the most-cited complaint, the most-cited praise, any breaking news, and any single high-signal thread>

## Google News (Serper)
<bulleted list of top 5; format: **<sentiment-tag>** [<title>](<url>) — <one-line quote or summary> · <freshness>>

## Reddit
### r/<sub-1>
- ...

### r/<sub-2>
- ...

### Across Reddit
- ...

## Industry feeds (RSS)
- ...

## Synthesized view (Parallel)
<3–5 sentences from the Parallel Search synthesis; cite source URLs inline>

## Brave / alternate web
- ...

## Items skipped or sources unavailable
- <e.g. "feed-mcp not wired in this group — skipped industry-feed pass">
```

Empty sections are fine — collapse them to `_no relevant results_` rather than removing the heading entirely, so the report's structure stays predictable across runs.

### 6. Offer follow-ups

After the report, suggest 1–3 next actions based on what came back. Examples:

- "Want me to draft a response to the negative thread on r/sales?"
- "Should I add `<target>` to the news group's daily watchlist?"
- "Want a deeper Parallel **Task** run on the most-cited complaint?"

Don't run these automatically — let Brad pick.

## Concrete examples

### `/social-listening Cubby Storage`

- Subreddits: `r/selfstorage`, `r/storageunits`, `r/Entrepreneur`, `r/smallbusiness`
- News emphasis: self-storage trade press, Google News
- Expected sections: Google News, r/selfstorage, r/storageunits, cross-Reddit, industry feeds (e.g. Inside Self-Storage, Mini-Storage Messenger), Parallel synthesis, Brave

### `/social-listening Cache Financials`

- Subreddits: `r/fintech`, `r/wealthmanagement`, `r/personalfinance`, `r/financialadvisors`, `r/CFP`
- News emphasis: fintech press, Google News, advisor trade pubs
- Watch for: confusion with caching/CPU cache — strict-quote `"Cache Financials"` in every query

### `/social-listening "HubSpot operations hub"`

- Subreddits: `r/sales`, `r/hubspot`, `r/RevOps`, `r/marketing`, `r/SaaS`
- News emphasis: SaaStr, MarTech, HubSpot's own blog, Google News
- Watch for: keep the full `"HubSpot operations hub"` quoted in every query — bare "HubSpot" drowns the specific product in base-platform noise

## Scheduled use

For fixed client watchlists, this skill is also callable from a scheduled task in the `news` agent group (Unit 4) — see `groups/news/scripts/watchlist-monitor.mjs` (if present). The scheduled variant should run weekly per client, post to the `dm-with-brad` group, and only surface items with **negative** sentiment or **>50 upvotes** to avoid noise. The interactive variant (this skill) returns the full report.

## Graceful degradation rules

- If `mcp__serper__*` is missing → use `WebSearch` with `site:news.google.com` and a general web search.
- If `mcp__reddit__*` is missing → use `WebSearch` with `site:reddit.com "<target>"` and `WebFetch` to pull top threads.
- If `mcp__feed-mcp__*` is missing → skip the RSS section, note it under "sources unavailable."
- If `mcp__parallel-search__*` is missing → skip the synthesized view, note it under "sources unavailable." Do not fabricate a synthesis.
- If Brave is missing → skip it silently (Serper and WebSearch already cover web).

Never block the entire report on a single missing source. The goal is "useful answer with what's available," not "all-or-nothing."

## What this skill is not

- **Not a publishing tool.** It only reads. Posting replies on Reddit or social channels is out of scope — that's the LinkedIn community manager skill (Unit 6) or future per-channel skills.
- **Not a paid-tier replacement at enterprise scale.** For >10 watchlists, real-time alerts, or compliance/archival needs, Brand24 / Mentionlytics still make sense. This skill is sized for a few client watchlists and ad-hoc lookups.
- **Not a sentiment classifier in the strict sense.** Sentiment tags are quick-read heuristics from the snippet text, not a calibrated model. Don't quote them as definitive metrics.
