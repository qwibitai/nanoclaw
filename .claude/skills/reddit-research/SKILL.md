---
name: reddit-research
description: Mine Reddit for ICP language, competitor complaints, and niche-community signal. Read-only Reddit MCP (`mcp__reddit__*` via `reddit-mcp-buddy`) — no auth, no posting. Use for voice-of-customer research, ad-copy harvesting, finding the active subreddits for a vertical, validating whether a pain point is widespread. Triggers on "reddit research", "mine reddit", "what do {ICP} say about", "find the subreddits for", "competitor complaints", "ICP language", "voice of customer", "pain points", "self-storage subreddit", "fintech subreddit", "MSP subreddit".
---

# Reddit Research

The `reddit` MCP exposes a strictly read-only view of Reddit's public JSON. No auth, no API key. The server name is `reddit`; tools live behind `mcp__reddit__*`.

## Tools

| Tool | What it returns |
|---|---|
| `mcp__reddit__browse_subreddit` | Posts from one subreddit, sorted by `hot`, `new`, `top`, or `rising`. Optional time window (`hour`, `day`, `week`, `month`, `year`, `all`) for `top`. |
| `mcp__reddit__search_reddit` | Reddit search results — either all of Reddit or scoped to one subreddit. Best when you have a query phrase. |
| `mcp__reddit__get_post_details` | A single post's full body plus its comment tree. Use after `browse` or `search` flags an interesting thread. |
| `mcp__reddit__user_analysis` | A user's recent posts/comments. Useful when triangulating whether a thread author is the actual ICP or noise (a marketer/bot). |
| `mcp__reddit__reddit_explain` | Glossary of Reddit terminology. Rarely needed once you know the platform. |

## When to use Reddit vs the other tools

| Question | Tool |
|---|---|
| "How do {ICP} actually talk about X?" / voice-of-customer language | `mcp__reddit__*` |
| "What do users complain about with {competitor}?" | `mcp__reddit__search_reddit` |
| "What are the active subreddits for {topic}?" | `mcp__reddit__search_reddit` + a few `browse` probes |
| "Is {pain point} widespread or anecdotal?" | `mcp__reddit__search_reddit` over a long time window |
| "Single fact / definition / current event" | `mcp__parallel-search__*` |
| "What does Google rank for X?" | `mcp__serper__*` |
| "Synthesized written research report with citations" | `mcp__parallel-task__*` (ask first) |
| "Interact with a page (login, click, JS)" | `agent-browser` |

The mental model: **Reddit threads are not a citable wiki source on their own — they're a *signal source*.** You read Reddit to learn what language to put on a landing page, which competitors come up unprompted, which pain points get the most upvotes. Then you confirm the actual facts elsewhere.

## Standard playbooks

### 1. ICP language mining (for ad copy / landing pages)

**Goal:** harvest the literal phrases your ICP uses when describing a pain point, so the next ad/landing page sounds like them and not like a marketing team.

Workflow:

1. Pick 2–3 subreddits where the ICP hangs out. If you don't know which, start with `search_reddit` for the role/industry term and skim which subreddits come up.
2. `search_reddit` for the pain-point phrase across those subs over `month` or `year`.
3. For the 5–10 highest-engagement threads, `get_post_details` to pull the comments.
4. Extract: (a) literal phrases describing the problem, (b) emotional words, (c) the workarounds people mention (these are usually competitor names or DIY tools).
5. Output a structured table — `phrase | context | thread_url | upvotes` — and a short list of repeated competitor mentions.

**Examples (Brad's clients):**

- **Cubby Storage (self-storage):**
  - Subreddits: `r/selfstorage` (operators), `r/sidehustle` / `r/PassiveIncome` (investors), `r/RealEstate`, `r/declutter` (end consumers).
  - Pain-point queries: "stuff is overflowing", "ran out of space", "garage full", "moving and need storage", "storage unit nightmare", "neighbors complaining about boxes".
  - Operator-side queries: "self storage management software", "tenant ledger", "stuck units", "auction off unit", "online lease signing".
- **Cache Financials (fintech / wealth):**
  - Subreddits: `r/personalfinance`, `r/investing`, `r/financialindependence`, `r/FIREyFemmes`, `r/Fire`, `r/Bogleheads`, `r/Schwab`, `r/fidelityinvestments`.
  - Pain-point queries: "ACATS transfer stuck", "concentrated position", "exchange fund", "single stock risk", "RSU diversification", "tax-efficient diversification", "exchange fund minimum".
- **Meadow / Meadowfi (mortgage / homeownership):**
  - Subreddits: `r/FirstTimeHomeBuyer`, `r/RealEstate`, `r/personalfinance`, `r/Mortgages`.
  - Pain-point queries: "down payment", "PMI", "rate lock", "appraisal came in low", "closing costs surprise".
- **BCG Rise (career / mid-career pivots):**
  - Subreddits: `r/cscareerquestions`, `r/careerguidance`, `r/managers`, `r/AskHR`, `r/MBA`.
  - Pain-point queries: "career pivot", "midlife career change", "transition to data", "transition to product", "transition to AI".
- **MSPs (a recurring Cache + general theme):**
  - Subreddits: `r/msp`, `r/sysadmin`, `r/ITManagers`.
  - Pain-point queries: "PSA migration", "RMM consolidation", "MSP onboarding", "client churn", "tooling fatigue".

When you're done, save the harvested phrases as a working file under `/workspace/agent/research/reddit/{client}-{date}.md` (or `/workspace/extra/clients/projects/{client-slug}/output/` if it's a deliverable). Always include the thread URL next to each quote — the source is the asset.

### 2. Competitor pain-point hunting

**Goal:** surface the complaints customers and prospects voice about a specific competitor, so positioning can lean into those weak spots.

Workflow:

1. `search_reddit` for the competitor name across all of Reddit, sort `top` over `year`. Then again over `month` to catch fresh complaints.
2. Filter to threads with non-trivial engagement (>10 upvotes or >5 comments — adjust by subreddit size).
3. `get_post_details` on each surviving thread. Pull comment text too — that's where the real critique usually lives.
4. Bucket complaints into categories (pricing, support, reliability, feature gaps, onboarding friction). Note the rough frequency of each.
5. Output: a competitor scorecard — `complaint_category | example_quotes | thread_links | frequency`.

**Examples:**

- **Self-storage competitors (for Cubby):** "storEDGE", "Sitelink", "Easy Storage Solutions", "Yardi Breeze Premier", "DoorLoop". For each: search `r/selfstorage` + general Reddit; look for "switched from", "alternative to", "support is", "billing bug".
- **Fintech competitors (for Cache):** "Wealthfront", "Betterment", "Carta", "USCF", "Cache" itself (be careful to disambiguate from caching the noun — quote-search `"Cache exchange fund"` or scope to fintech subs).

Caveat: marketers seed and astroturf on Reddit. Spot-check thread authors with `user_analysis` — if their post history is 100% the same brand or they're brand-new, discount the thread.

### 3. Niche-community discovery

**Goal:** find the active subreddits for a topic, so further research / ICP outreach has a target.

Workflow:

1. `search_reddit` (no subreddit scope) for 2–3 distinct phrases representing the topic.
2. Tally which subreddits show up repeatedly and which threads in those subs get real engagement.
3. For each candidate subreddit, `browse_subreddit` with sort `top` over `month` to confirm it's active and on-topic (not a graveyard or off-topic).
4. Output: `subreddit | members (if visible) | activity_assessment | sample_threads | notes`.

**Examples:**

- "Self-storage operators" → `r/selfstorage` (active, operator-leaning), `r/RealEstate` (adjacent, occasional), `r/CommercialRealEstate`.
- "RSU diversification" → `r/financialindependence`, `r/Bogleheads`, `r/personalfinance`, `r/StockMarket`, `r/SecurityAnalysis`.
- "First-time homebuyers" → `r/FirstTimeHomeBuyer`, `r/RealEstate`, `r/personalfinance`, `r/Mortgages`.
- "MSP owners" → `r/msp`, `r/sysadmin`, `r/MSPBusiness`, `r/ITManagers`.

### 4. Pain-point validation ("is this widespread?")

**Goal:** before pitching a client on a positioning angle or a content topic, check whether the pain is widely-discussed or anecdotal.

Workflow:

1. `search_reddit` for the pain phrase + a few synonyms over `year`.
2. Count how many distinct threads cross the engagement floor (≥10 upvotes or ≥10 comments).
3. Check whether the volume is rising (compare `month` vs `year` cadence) or stable.
4. Output: a one-paragraph verdict (`Widespread / Recurring`, `Occasional`, `Niche / Cold`) plus 3–5 representative thread links.

## Output conventions

- Reddit research deliverables → `/workspace/extra/clients/projects/{client-slug}/output/reddit-{playbook}-{YYYY-MM-DD}.md`.
- Internal scratch / working notes → `/workspace/agent/research/reddit/`.
- Always cite thread URLs (`https://reddit.com/r/<sub>/comments/<id>/...`). The link is the value, not just the quote.
- Never paste long blocks of Reddit prose into chat — summarize with 2–4 representative quotes and link out.

## Limits and gotchas

- **Read-only.** This MCP cannot post, comment, vote, or DM. If a workflow requires writing to Reddit, it's out of scope for this skill — use `agent-browser` against `reddit.com` (under approval) and note that Reddit's ToS frowns on automation.
- **Rate limits.** The MCP uses Reddit's anonymous tier (~10 req/min). Long sweeps will stall — prefer one targeted query at a time over fanning out 20 in parallel.
- **No demographic data.** Reddit doesn't expose age/income/location. Use it for *language* and *signal volume*, not for "who is the ICP" — pair with HubSpot / SolidTime / client interviews for actual ICP shape.
- **Astroturf / brigading.** Brands and competitors seed threads. `user_analysis` is the quickest gut-check on a suspicious account.
- **Subreddit gates.** Some subs are private or quarantined — those return errors. Skip and move on.
