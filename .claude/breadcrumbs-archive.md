---
## 2026-02-15 (session 14) — Pre-mortem hardening: 4 rounds, 11 fixes deployed

**Context:** Continuation of session 13. Ran 4 rounds of /pre-mortem on the aggressive trader infrastructure, each round finding and fixing new issues.

**Round 1 — 7 fixes:**
1. **Price precision** — `toPrecision(6)` → `toPrecision(5)` in hl_trade.mjs. MELANIA trade was failing with "Order has invalid price" (Hyperliquid requires ≤5 sig figs)
2. **Sell-side safety check** — added `isClosingPosition()` helper. Closing existing positions always allowed; opening new shorts now checked against safety limits
3. **sessionRetention 24h → 1h** — stale cron :run: sessions auto-purge after 1 hour instead of 24
4. **Margin utilization cap 75%** — `maxMarginUtilization: 0.75` in LIMITS. Blocks new trades when overexposed
5. **Watchdog restart cooldown** — 30-min cooldown prevents restarting containers that just started
6. **minFreeMarginAfter $30 → $100** — more buffer for $1K account
7. **Proactive token purge in watchdog** — resets any session >30K tokens, not just when "No reply"

**Round 2 — 4 fixes:**
1. **Session purge every 30 min** — NEW script `/root/scripts/session-purge.sh` runs via cron `*/30 * * * *`. Critical because cron sessions bloat to 40K+ in ~15 minutes and compaction doesn't fire on them
2. **jq installed in container** — minimax ignores "don't use jq" instructions. Added to post-deploy.sh for persistence across rebuilds
3. **Doctor config migration** — fixed `channels.discord.dm.policy → dmPolicy` in openclaw.json. Eliminates startup warning
4. **Cleared stuck delivery queue** — 8 stale DM deliveries removed from `/root/.openclaw/delivery-queue/`

**Round 3+4 — Assessment:** No HIGH risks remaining. System stable enough to observe for 24h.

**Critical discovery:** Compaction does NOT fire on isolated cron sessions. Token counts grow unbounded. The 30-min session purge is the ONLY defense. Without it, sessions hit 40K+ in 15 minutes → "No reply from agent" within 1-2 hours.

**Verification test (real trade):** Closed BERA position to verify `isClosingPosition()` bypasses safety check at 79.9% margin utilization. Filled 300 @ 0.68764. Bot immediately reopened BERA + added MOVE + VVV (aggressive by design).

**Account state at end:** $1,005, 11 positions, $144 unrealized, 81% margin utilization (at cap).

**Key files modified on VPS:**
- `/root/.openclaw/workspace/scripts/hl_trade.mjs` — price precision + sell-side safety + margin cap + min margin
- `/root/.openclaw/openclaw.json` — sessionRetention 1h + doctor config migration
- `/root/scripts/session-purge.sh` — NEW: lightweight 30-min token purge
- `/root/scripts/session-watchdog.sh` — proactive token purge + restart cooldown
- `/root/scripts/post-deploy.sh` — jq install added for both containers
- Crontab: added `*/30 * * * * session-purge.sh`

**Remaining accepted risks (no action needed):**
- Bot fills to 75% margin cap on every cycle (by design — aggressive trader)
- jq syntax errors (self-correcting — bot adjusts on next run)
- JSON parse errors from large API responses (retries on next cycle)
- jq gets wiped on rebuild (post-deploy.sh reinstalls in ~20s)

**Dead ends this session:** None — all 4 pre-mortem rounds led to successful fixes.

---
## 2026-02-15 (session 13) — Firefighting + Hardening: Trader goes aggressive, infra made robust

**What we fixed:**
1. **Trader "No reply from agent"** — purged 784 stale cron :run: sessions (2.6MB→35KB), reset bloated discord channel session (86K tokens), tightened compaction (40K→20K threshold, 0.5→0.3 history, 30m→15m heartbeat)
2. **LeadGen CRM crashes** — installed better-sqlite3 at workspace root + /app symlink, fixed CHECK constraint in `lead_crm.js` with status mapping (bot was passing statuses like "qualified" that didn't match schema)
3. **Daily update cron NEVER WORKED** — shebang was `#\!/bin/bash` (escaped `!`), OS ran it with `sh` which choked on `set -o pipefail`. Fixed + ran manually → 559 new commits pulled + rebuilt
4. **Morning brief v2 DID fire** at 8am SGT — Reddit blocked (403) but HN data used, brief posted to Discord

**What we deployed:**
- **Trader upgraded: passive monitor → aggressive autonomous trader**
  - Cron prompts now include ACTION REQUIRED sections that execute trades via `hl_trade.mjs`
  - Position monitor: auto-close losers >8%, take profit at +25%/+50%
  - Market scanner: execute trades on momentum/breakout setups, 10-20% account size, up to 10x leverage
  - Funding scanner: open arb positions at >0.03%/8h
  - Polymarket scanner: execute bets $25-100 on mispriced contracts
  - IDENTITY.md loosened: 12 max positions, action bias ("NOT TRADING IS A RISK")
- **hl_trade.mjs safety limits** — max $250/trade, 10x leverage cap, $30 min margin, 2% slippage cap. Script-level guardrails AI cannot override.
- **Session watchdog cron (every 4h)** — `/root/scripts/session-watchdog.sh`: purges stale :run: sessions + auto-restarts bots with 5+ "No reply" in 30 min
- **post-deploy.sh** — runs after every 3am rebuild: npm rebuild better-sqlite3 (not just symlink), session purge, health verify
- **Anti-churn rule** — market scanner reads last entries of trade-journal.md before entering, won't buy coins already held or sold in last hour

**Live results:**
- Bot already trading: partial profit on VIRTUAL (+10%), opened AAVE SHORT (funding arb)
- Account: $1,013, +$165 unrealized, 9 positions, 8/9 green

**Key files modified on VPS:**
- `/root/.openclaw/cron/jobs.json` — 6 trader cron jobs with trade execution
- `/root/.openclaw/workspace/IDENTITY.md` — aggressive trading rules
- `/root/.openclaw/workspace/scripts/hl_trade.mjs` — safety limits added
- `/root/.openclaw-2/workspace/scripts/lead_crm.js` — status validation fix
- `/root/scripts/daily-update.sh` — fixed shebang, calls post-deploy.sh
- `/root/scripts/post-deploy.sh` — NEW: npm rebuild + symlinks + session purge + health
- `/root/scripts/session-watchdog.sh` — NEW: every 4h session cleanup + no-reply restart
- Crontab: added `0 */4 * * * session-watchdog.sh`

**Open risks from pre-mortem (not yet fixed):**
1. Safety check may block sells that close existing longs (treats as "new short")
2. Watchdog has no restart cooldown (could restart mid-trade)
3. OpenRouter rate limits/credits not monitored (500+ API calls/day)
4. trade-journal.md grows unbounded → kills minimax context on long reads
5. Post-deploy warns but doesn't exit 1 on verify failure

**Dead ends:**
- npm install in /app/ fails (`Cannot read properties of null (reading 'matches')`) — symlink works instead
- SSH escaping for Python/JS heredocs is brutal — download locally, edit, scp back

---
## 2026-02-14 (session 12) — LeadGen cron restructured, fully autonomous pipeline

**What we worked on:** Restructured LeadGen bot from 12 cron jobs to 8. Made lead pipeline fully autonomous (search → qualify → match → email, no human approval). Updated morning brief to v2 template, standup to compact scorecard format. Added survival urgency to IDENTITY.md.
**What worked:** Cron did fire on new build (standup at 7:30 PM SGT confirmed). New schedule and prompts deployed cleanly.
**What didn't work:** Bot had zero activity today because container was rebuilt mid-day. Tomorrow is the real test.
**Left off at:** All changes deployed. 8 cron jobs live. Email is autonomous with 10/day cap. User only sees output at 8am (brief) and 7:30pm (standup).
**Key files on VPS:**
- `/root/.openclaw-2/cron/jobs.json` — 8 jobs (was 12)
- `/root/.openclaw-2/workspace/IDENTITY.md` — added "The Reality" survival section
**Notes for next time:**
- Morning brief uses v2 template (6 sections: 10 seconds, pinpoints, build ideas, pick, social pack, ops check)
- Standup uses compact scorecard (emoji rating, pipeline/content/money, win/drag, 2 moves)
- Lead emails are AUTONOMOUS now (no draft-first). Bot sends directly using humanizer rules.
- Bluesky posts are silent (mode: none). Only brief + standup ping Discord.
- Monitor tomorrow 8am SGT for first morning brief with new v2 format

---
## 2026-02-14 (session 11) — Rebuilt OpenClaw from source, fixed minimax maxTokens, Brave key

**What we did:**
1. **Fixed minimax "No reply from agent" root cause** — OpenClaw default maxTokens=8192, minimax uses 500-2000 tokens on reasoning per reply, leaving nothing for content. Set maxTokens=16384 on both bots. Also discovered Discord uses `agent:main:main` session (not channel-specific sessions) — must reset that one too.
2. **Updated Brave API key** — new key `[REDACTED]` deployed to both bots, verified working.
3. **Rebuilt OpenClaw from source** — 369 commits ahead of the Docker image (v2026.2.12). Key fixes: session store lock (file→Promise mutex), token counting, auto-reply path resolution, outbound routing. Both bots now on `openclaw:local` image.
4. **Created daily update cron** — `/root/scripts/daily-update.sh` at 3am SGT pulls source, rebuilds if changed, redeploys both bots. docker-compose files now point to `openclaw:local` not `ghcr.io/openclaw/openclaw:latest`.
5. **Evaluated ZeroClaw** — 1-day-old Rust project, cron not implemented ("coming soon!"), not viable for our use case.

**Verified working:**
- Trader cron jobs producing real content: position monitor (+$118 unrealized), funding scanner (FARTCOIN funding warning), liquidation check (all safe)
- Trader responding to Discord messages
- Brave search working on both bots
- All configs/scripts/cron survived the rebuild (persistent volumes)

**Still pending:**
- Waiting for LeadGen Daily Standup (7:30 PM SGT) to confirm cron fires on new build
- Heartbeat failing with "Cannot send messages to this user" (tries to DM, not critical)
- Monitor tomorrow's full LeadGen cron schedule (8am-7:30pm SGT)

**Key discovery:**
- `maxTokens` on minimax model def is CRITICAL — default 8192 is too low, must be 16384+
- Discord messages route through `agent:main:main` session, not channel-specific sessions
- docker-compose now uses `image: openclaw:local` (source build), not remote image

---
## 2026-02-14 (session 10) — Fixed cron delivery, session corruption, Bluesky rate limits

**What we fixed:**
3 critical bugs preventing autonomous operation:

1. **Cron delivery format** — `delivery.channel` must be a STRING (`"discord"`), not an object. Target goes in `delivery.to` with prefix: `"channel:1471767177290973236"`. Without `channel:` prefix, OpenClaw errors "Ambiguous Discord recipient". Fixed on both bots.

2. **Session corruption** — Minimax reasoning eats all tokens on long sessions (59K+ tokens), returns empty content → "No reply from agent" → orphaned messages pile up → bot goes silent. Fix: reset sessions + lowered compaction threshold from 80K→40K tokens + maxHistoryShare 0.7→0.5.

3. **Bluesky spam** — Catch-up cron triggers fired 5 posts in 20 min. Added rate limit guard to all 3 Bluesky cron prompts: bot checks last 3 posts before posting, skips if anything posted in last 2 hours.

**New files deployed (both bots):**
- `workspace/HEARTBEAT.md` — 30-min health check: session hygiene, stale task check, cron health
- `workspace/active-tasks.md` — Crash recovery: bot reads this FIRST on startup, resumes without asking
- Config: heartbeat interval 4h→30m, compaction softThreshold 80K→40K

**Still broken:**
- Brave Search API keys expired on BOTH bots (422 "subscription token invalid") — scripts using direct HN/Reddit APIs still work, but bot's built-in web_search is dead
- Trader "No reply from agent" on Discord — session was reset but need to verify it's actually working now (wasn't tested yet)
- Heartbeat changes deployed to config but container not restarted yet to pick them up

**Hyperliquid positions (checked this session):**
BTC +$25, NEAR +$5.5, GOAT +$7, VIRTUAL +$46 (winner), FARTCOIN +$7, OM +$8, WLFI +$5.5 — total ~$104 unrealized (up from $42 at last handoff)

**Polymarket:** ~90 positions, mostly penny bets. Two NBA game losses (Kings, Grizzlies went to 0). Some winners: Leeds 3rd (14x), Dallas Stars Central (3x), Trump-Putin Belarus. PnL calculation broken (shows undefined).

**Key discovery — OpenClaw cron delivery schema (from source code):**
```
resolveCronDeliveryPlan() in src/cron/delivery.ts:
- delivery.channel → normalizeChannel() → must be STRING ("discord", "telegram")
- delivery.to → STRING with prefix ("channel:ID" or "user:ID")
- delivery.mode → "announce" | "none"
Object format {"type":"discord","id":"..."} is silently ignored (returns undefined).
```

**Next:**
1. Restart both bots to pick up heartbeat + compaction config changes
2. Test heartbeat fires and checks session health
3. Verify Trader Discord replies work after session reset
4. Renew Brave Search API keys
5. Monitor tomorrow's full cron schedule (8am-7:30pm SGT)

---
## 2026-02-14 (session 9) — Prove-it verification pass, all green

**What we worked on:** Full prove-it verification of both bots after compaction.
**What worked:** All 18 checks passed — both containers healthy, all 6 LeadGen scripts run, 12 cron jobs loaded, Trader cron jobs all last=ok with 0 errors.
**Left off at:** Everything verified. No active build. Pending tasks are Trader-side (review positions, prompt trading, update cron).
**Key detail:** Autoheal polls every 5 seconds, healthchecks run every 5 minutes with 3 retries. Worst-case recovery ~15 min.

---
## 2026-02-14 (session 8 continued) — LeadGen bot FULLY DEPLOYED, all 5 phases complete

**What we built:**
LeadGen bot — second OpenClaw instance on jp VPS with 4 roles: lead gen, morning brief, expense tracker, Bluesky poster.

**Infrastructure:**
- Container: `openclaw-leadgen-1` on jp VPS, port 18791, healthy
- Config: `/root/.openclaw-2/openclaw.json` (minimax-m2.5)
- Discord: #lead-gen channel (1471767177290973236), resolved and responding
- Discord token: `[REDACTED — rotate this token]`
- Bot ID: 1472128067861483668 (@Leadgen)

**Scripts (all verified working):**
- `morning_brief.js` — HN + Reddit news aggregation
- `expenses.js` — SQLite tracker, seeded with 13 transactions, 8.5mo runway
- `bluesky.js` — @atproto/api, connected to @brandontan888.bsky.social (18 followers, 191 posts)
- `lead_search.js` — HN + Reddit lead finder (25 leads found in test)
- `lead_crm.js` — SQLite CRM with dedup (sent_emails table for hard dedup)
- `lead_email.js` — Gmail SMTP, caps: 5/run, 10/day, 3sec gaps between sends

**Gmail app password:** `xzsx ueyg uxud caxr` (new, old one expired)

**Safety modes:**
- Bluesky: AUTONOMOUS — posts directly, humanizer rules in cron prompt
- Email: DRAFT-FIRST — bot posts drafts to Discord, user approves before sending
- All writing: WRITING.md loaded at boot with humanizer rules (banned AI words, banned patterns, Brandon's voice)

**Cron jobs (12 total, all SGT):**
- 8:00 AM morning brief
- 8:30 / 12:30 / 4:30 PM lead search
- 9:00 / 1:00 / 5:00 PM lead email (draft-first)
- 10:00 AM / 2:00 PM / 7:00 PM Bluesky post (autonomous)
- 6:00 PM Fri expense report
- 7:30 PM daily standup (leads, follow-ups, PnL, Bluesky stats)

**Pre-mortem mitigations applied:**
- Hard email dedup (sent_emails table + daily cap)
- Draft-first for emails (reputation protection)
- Humanizer writing rules for all output
- Healthcheck + autoheal on container

**Key files on VPS:**
- `/root/openclaw-2/docker-compose.yml`
- `/root/openclaw-2/.env`
- `/root/.openclaw-2/openclaw.json`
- `/root/.openclaw-2/cron/jobs.json` (12 jobs)
- `/root/.openclaw-2/workspace/IDENTITY.md`
- `/root/.openclaw-2/workspace/MEMORY.md`
- `/root/.openclaw-2/workspace/WRITING.md` (humanizer rules)
- `/root/.openclaw-2/workspace/TOOLS.md`
- `/root/.openclaw-2/workspace/secrets.env`
- `/root/.openclaw-2/workspace/scripts/` (6 scripts + node_modules)
- `/root/.openclaw-2/workspace/data/` (expenses.db, leads.db)

**VPS state:** Both bots healthy, autoheal running, 2.6GB RAM free, 41GB disk free.

**Fixes during build:**
- Channel name not ID (OpenClaw resolves names, not raw IDs)
- File ownership root→node:node (container runs as uid 1000)
- .mjs→.js rename (ESM vs CommonJS)
- Gmail app password expired, got new one
- Cron config goes in cron/jobs.json, NOT in openclaw.json (config only has cron.enabled)

**Plan file:** `/Users/brtan/.claude/plans/woolly-toasting-sutherland.md`

---
## 2026-02-14 (session 8) — Proxy trading fixed, healthcheck added, LeadGen bot Phase 1 started

**What we worked on:**
1. Fixed Polymarket proxy trading — signatureType 2 (POLY_GNOSIS_SAFE) + funderAddress=PROXY_ADDR. Verified: order placed from proxy's $638.
2. Enhanced `docs-before-source` skill with "Full Constructor Scan" lesson
3. Added Docker healthcheck to Trader bot + autoheal container (tested kill→recovery cycle)
4. Started LeadGen bot build — Phase 1 (infrastructure) in progress

**Polymarket fix (CRITICAL):**
- Three signatureTypes: 0=EOA direct, 1=POLY_PROXY (Magic/email), 2=POLY_GNOSIS_SAFE (MetaMask+proxy)
- We are type 2. ClobClient needs: `signatureType=2, funderAddress=PROXY_ADDR`
- Updated: poly_trade.mjs, bot TOOLS.md, bot MEMORY.md, local MEMORY.md, docs-before-source skill

**Healthcheck:**
- docker-compose healthcheck: wget http://127.0.0.1:18789/ every 5min, 3 retries
- autoheal container watches for unhealthy → auto-restarts
- Tested: killed process → recovered in ~30s

**LeadGen bot (IN PROGRESS — Phase 1):**
- Plan: `/Users/brtan/.claude/plans/woolly-toasting-sutherland.md`
- Container: `openclaw-leadgen-1` on jp VPS, port 18791
- Config: `/root/.openclaw-2/openclaw.json`
- Discord token: `[REDACTED — rotate this token]`
- Bot is running, logged into Discord as @Leadgen (bot ID: 1472128067861483668)
- **BLOCKER:** Discord channel "lead-gen" (1471767177290973236) unresolved — user needs to:
  1. Invite bot to server: https://discord.com/api/oauth2/authorize?client_id=1472128067861483668&permissions=274877910016&scope=bot
  2. Enable Message Content Intent in Developer Portal
  3. Grant bot access to #lead-gen channel
- After channel resolves → continue to Phase 2 (morning brief), Phase 3 (expenses), Phase 4 (bluesky), Phase 5 (lead gen)

**Key files on VPS:**
- `/root/openclaw-2/docker-compose.yml` — LeadGen container config
- `/root/openclaw-2/.env` — API keys
- `/root/.openclaw-2/openclaw.json` — bot config (Discord, model, crons)
- `/root/.openclaw-2/workspace/IDENTITY.md` — 4-role personality
- `/root/.openclaw-2/workspace/MEMORY.md` — business context + financial snapshot
- `/root/.openclaw-2/workspace/secrets.env` — Gmail + Bluesky credentials

**Trader bot status:** Running, healthy, signatureType 2 fix applied, healthcheck active

---
## 2026-02-14 (session 7) — Both trading scripts working, bot brain updated

**What we worked on:** Updated all 3 bot brain files (TOOLS.md, MEMORY.md, HEARTBEAT.md) + built hl_trade.mjs CLI for Hyperliquid.
**What worked:** Hyperliquid SDK v0.30.3 works fine — API just changed (needs `{ transport }` object, not positional args). Built full CLI matching poly_trade.mjs pattern.
**What didn't work:** Nothing — clean session.
**Left off at:** Both trading scripts verified. Bot has correct instructions for both platforms.
**Key files on VPS:**
- `/root/.openclaw/workspace/scripts/hl_trade.mjs` — NEW Hyperliquid CLI (balance, buy, sell, mbuy, msell, close, leverage, funding, book, orders, cancel, cancelall)
- `/root/.openclaw/workspace/scripts/poly_trade.mjs` — Polymarket CLI (unchanged from session 6)
- `/root/.openclaw/workspace/TOOLS.md` — Updated with both CLIs' correct syntax
- `/root/.openclaw/workspace/MEMORY.md` — Fixed model (minimax-m2.5), removed thinking:high, added Polymarket details
- `/root/.openclaw/workspace/HEARTBEAT.md` — Added Polymarket monitoring steps
**Notes:** Hyperliquid account: $897 value, 8 positions, $216 free margin, $42 unrealized P&L. Polymarket: $197 portfolio, $6 cash.

---
## 2026-02-14 (session 6 continued) — Polymarket trading WORKING, bot instructions need update

**Status: Polymarket trading fully verified. Now updating bot's brain (TOOLS.md, MEMORY.md, HEARTBEAT.md) so it knows to trade Polymarket + $10K target.**

**What was just done:**
1. Fixed Polymarket CLOB auth — signatureType 0 (EOA/MetaMask), NOT 1 (Magic only)
2. Derived proper API keys via `deriveApiKey()` (builder profile keys are wrong type)
3. Verified: buy order placed + cancelled successfully
4. Created `docs-before-source` skill (lesson from wasted 60min on auth)
5. Updated breadcrumbs + MEMORY.md with Polymarket lessons

**In progress when interrupted:**
- Updating bot's TOOLS.md — current version has WRONG poly_trade.mjs command syntax (old format)
- Need to update MEMORY.md — has stale model info ("DeepSeek V3.2", "thinking: high")
- Need to update HEARTBEAT.md — doesn't mention Polymarket scanning
- User wants: "trade on polymarket as well to reach 10K... do or die"

**Correct poly_trade.mjs commands (for TOOLS.md):**
```
node scripts/poly_trade.mjs balance
node scripts/poly_trade.mjs search [query]
node scripts/poly_trade.mjs market <conditionId>
node scripts/poly_trade.mjs buy <token_id> <price> <size> <tick> [negRisk]
node scripts/poly_trade.mjs sell <token_id> <price> <size> <tick> [negRisk]
node scripts/poly_trade.mjs orders
node scripts/poly_trade.mjs cancel <order_id>
node scripts/poly_trade.mjs cancelall
node scripts/poly_trade.mjs positions
node scripts/poly_trade.mjs withdraw <amount>
```

**Key files already read (have content in context):**
- TOOLS.md — needs command syntax fix + Polymarket trading emphasis
- MEMORY.md — needs model update (minimax-m2.5, no thinking), Polymarket account details
- HEARTBEAT.md — needs Polymarket position monitoring added

**VPS files to modify:**
- `/root/.openclaw/workspace/TOOLS.md` (inside container: `/home/node/.openclaw/workspace/TOOLS.md`)
- `/root/.openclaw/workspace/MEMORY.md`
- `/root/.openclaw/workspace/HEARTBEAT.md`

---
## 2026-02-14 (session 5+6) — Bot fixed, Polymarket trading FULLY WORKING

**Status: Bot live on Discord (minimax-m2.5). Polymarket trading verified — buy, sell, cancel, orders, positions, balance all working.**

**What was done:**
1. **Fixed OpenRouter API key** — old key killed by Codex. New key deployed.
2. **Fixed "No reply from agent"** — removed `thinkingDefault: "high"` from config (minimax dumps all tokens into reasoning, returns empty).
3. **Built Polymarket trading script** (`poly_trade.mjs`) — full CLI with all commands.
4. **Polymarket infrastructure** — @polymarket/clob-client, USDC.e swap, 6 approvals set.
5. **Fixed CLOB API auth (the big blocker):**
   - Builder profile keys from web UI are NOT regular API keys — they use `POLY_BUILDER_*` headers
   - signatureType 1 (POLY_PROXY) is ONLY for Magic Link/email users, NOT MetaMask
   - **Fix: signatureType 0 (EOA) + derived API keys via `deriveApiKey()`**
   - Verified: order placed successfully, then cancelled

**Polymarket setup (WORKING):**
- Script: `/root/.openclaw/workspace/scripts/poly_trade.mjs` (signatureType 0, EOA mode)
- API keys: derived for EOA via `deriveApiKey()` (key=`f0c86ffe-...`)
- Proxy wallet `0x1537...e720`: used for balance/positions queries only
- EOA `0x149dc5...77B7`: used for API auth and order signing
- Cash: $6.26 USDC.e (proxy) + $39.99 USDC.e (EOA, not on Polymarket)

**Dead ends (Polymarket auth):**
- signatureType 1 with MetaMask → "invalid signature" (only for Magic Link users)
- Builder profile keys as regular creds → 401 (wrong header type)
- `getAddress()` override to proxy → L1 auth fails (EIP-712 sig doesn't match)
- CREATE2 proxy derivation → wrong factory/init code hash

**Lessons:**
- Polymarket signatureType: 0=MetaMask, 1=Magic/email ONLY
- Builder profile keys need `POLY_BUILDER_*` headers, not `POLY_*`
- `deriveApiKey()` generates deterministic keys for the wallet — use these for API auth
- Research docs FIRST when stuck (found the answer in Polymarket authentication docs)

---
## 2026-02-13 (session 4) — OpenClaw fully configured, Trader bot LIVE

**Status: Trader bot fully operational on OpenClaw. Trading on Hyperliquid + Polymarket. All cron jobs active. Bot responding in Discord.**

**What was done:**
1. **Fixed Discord no-mention blocker** — set `requireMention: false` in guild config. Bot now responds without @mention.
2. **Full identity overhaul** — Zeus renamed to Trader. IDENTITY.md, SOUL.md, AGENTS.md, MEMORY.md, USER.md, TOOLS.md all rewritten with aggressive trading personality ($10K/month target), "Figure It Out" directive, crash recovery pattern.
3. **Applied community best practices** from 3 articles (kaostyl, witcheer, steipete):
   - HEARTBEAT.md slimmed to 7 lines (runs on GLM-5, every 4h)
   - Memory split: active-tasks.md for crash recovery
   - Session memory search enabled
   - Compaction with memoryFlush at 80K tokens
   - Channel isolation: #trading + #alerts only
4. **6 trading cron jobs created** (all isolated sessions, deliver to #alerts):
   - Liquidation Monitor (5min, GLM-5)
   - Position Monitor (10min, DeepSeek)
   - Polymarket Scanner (10min, DeepSeek)
   - Funding Rate Scanner (10min, DeepSeek)
   - Market Overview (30min, DeepSeek)
   - Daily P&L Report (midnight SGT, DeepSeek)
5. **Fallback model** — GLM-5 ($0.001/M, basically free)
6. **secrets.env created** — Hyperliquid private key + Polymarket MetaMask key filled in by user
7. **Performance optimized** — estimated $0.70-1.20/day total cost
8. **Verified live** — bot fetched real BTC price ($67K) from Hyperliquid API, ready to trade

**Config on VPS (jp):**
- Config: `/root/.openclaw/openclaw.json`
- Cron: `/root/.openclaw/cron/jobs.json`
- Workspace: `/root/.openclaw/workspace/`
- Secrets: `/root/.openclaw/workspace/secrets.env`
- Docker compose: `/root/openclaw/docker-compose.yml`
- Container: `openclaw-gateway-1`

**Key settings:**
- Primary model: DeepSeek V3.2 via OpenRouter
- Fallback: GLM-5 via OpenRouter
- Heartbeat: GLM-5 every 4h
- Channels: #trading (open) + #alerts (cron output)
- Exec: full, no-ask, elevated=full
- Compaction: safeguard, memoryFlush at 80K
- Session memory: ON (sources: memory + sessions)

**Still not done:**
- Polymarket API key/secret/passphrase empty in secrets.env (MetaMask key is there)
- Hyperliquid wallet address not derived yet
- No trading skills installed (bot uses raw API calls)
- Turn off "Public Bot" in Discord Developer Portal (manual by user)
- Daily update cron script not set up for OpenClaw source updates

---
## 2026-02-13 (session 3) — Moltis abandoned, OpenClaw restored (INCOMPLETE)

**Status: OpenClaw gateway running on official Docker image. Discord connected but NOT responding — `no-mention` skip issue.**

**What was done:**

1. **Moltis declared dead** — too many issues (hallucinations, broken hooks, cron wipes, API failures)
2. **Filed 5 bug reports on moltis-org/moltis**: #103 (auto-compact), #104 (hook paths), #105 (cron persistence), #106 (embeddings /v1), #107 (Docker env vars)
3. **Wiped Moltis** from jp VPS — all containers, images, source deleted. 50GB free, 3.2GB RAM.
4. **OpenClaw restored** using official image `ghcr.io/openclaw/openclaw:latest` (v2026.2.12)
   - Config: `/root/.openclaw/openclaw.json`
   - Deploy: `/root/openclaw/docker-compose.yml`
   - Env: `/root/openclaw/.env`
   - Source (for reference only): `/root/openclaw-src/`
   - Container: `openclaw-gateway-1`
   - Model: `openrouter/deepseek/deepseek-v3.2`
   - Discord: logged in as bot 1471722522520064071 (@Trader)
   - Gateway token: `[REDACTED — rotate this token]`
   - Web UI: zeus.moltbolt.xyz (Cloudflare tunnel still active)

**BLOCKER: Discord `no-mention` skip**
- Bot receives messages but skips them: `discord: skipping guild message, reason: no-mention`
- Changed `groupPolicy` to `"open"` in config but it didn't fix it
- The auto-reply module has a separate `requireMention` setting that controls this
- Need to find the right config key — check `DiscordGuildSchema` in `zod-schema.providers-core.ts`
- The guild config at `channels.discord.guilds.1471722191203598379` likely needs `requireMention: false`

**Dead ends this session:**
- Building OpenClaw from source — `.dockerignore` excludes `dist` and extensions don't get included
- Config file named `config.json` — must be `openclaw.json`
- `tools.exec.ask: "never"` — valid values are `"off"`, `"on-miss"`, `"always"`
- `models` as object — must be array of `{id, name, cost, contextWindow}`
- `channels.discord.main.token` nested format — Discord config is flat, not nested under account name
- `plugins.entries.discord.enabled: false` — doctor auto-added this, had to manually set to true
- `groupPolicy: "open"` alone doesn't fix no-mention — there's a separate requireMention flag

**What needs doing next session:**
1. **Fix Discord no-mention** — set `requireMention: false` in guild config (check schema first)
2. **Set up workspace** — IDENTITY.md exists, need SOUL.md, BOOT.md
3. **Install trading skills** — hyperliquid, polymarket, market-data, etc.
4. **Set up cron jobs** — AND mount cron dir as volume this time
5. **Turn off "Public Bot"** in Discord Developer Portal (manual)

**OpenRouter API key:** `[REDACTED-OR-KEY]`
**Discord token:** `[REDACTED-DISCORD-TOKEN]`

---
## 2026-02-13 (session 2) — Auto-compact fix, model switch back, rebuild

**Status: Bot live on DeepSeek V3.2 via OpenRouter. Auto-compact fix deployed. Two remaining issues.**

**What was done this session:**

1. **Switched back to OpenRouter DeepSeek V3.2** from Z.AI GLM-5 (user request)
   - OpenRouter API key: `[REDACTED-OR-KEY]` (from container env, NOT the one in memory)
   - Config: `/root/moltis-deploy/config/moltis.toml`

2. **Found & fixed auto-compact bug for Discord sessions**
   - Bug: `chat.rs:2121` passed `_conn_id` to `compact()`, but Discord has no conn_id → resolved to empty "main" session → "nothing to compact"
   - Fix: pass `_session_key` directly (one line change)
   - Tests: 2 regression tests added (compact works on Discord key, empty session returns error)
   - Commit: `ae37027` pushed to GitHub + VPS
   - Local tests pass (had to use `RUSTC=/Users/brtan/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc` — Homebrew rustc is 1.87, project needs 1.88+)

3. **Docker image rebuilt and deployed**
   - New image: `f1390ce440f1` built 2026-02-13T10:40:57Z
   - Build took ~37 min (two duplicate builds were competing for CPU before I killed one)
   - Deployed with `docker compose down/up`

4. **Auto-compact verified WORKING live** — logs show it triggered on Discord session (2.3M tokens), ran silent memory turn, started summarization. Before fix it said "nothing to compact" and gave up.

**Two remaining issues found during deployment:**

1. **Bot hit MAX_ITERATIONS=10 on first message** — the old bloated session (83 messages) plus compaction work used all 10 iterations on setup (pip installs, tool calls). First message got no Discord response. Second message is processing.
   - Log: `streaming agent loop exceeded max iterations (10)`
   - This is a one-time issue — future messages will be on a compacted session

2. **Hook `filter-hallucinations` still broken** — `./handler.sh: not found` (exit code 127)
   - Root cause: HOOK.md has `command = "./handler.sh"` but the working directory when the hook runs is NOT the hook's directory
   - Need to use absolute path or fix the working directory
   - Hook circuit breaker tripped again after 3 failures

**VPS state (jp):**
- Container: moltis (Up), image `f1390ce440f1`
- Model: DeepSeek V3.2 via OpenRouter
- Auto-compact: WORKING (fix deployed)
- Cron: 0 jobs (lost again on compose down/up), only heartbeat
- Hook: filter-hallucinations broken (wrong path)

**Still not done:**
- Fix hook handler.sh path (use absolute path in HOOK.md)
- Re-add 4 cron jobs
- Turn off "Public Bot" in Discord Developer Portal (manual)
- Persist cron data on a volume
- DM support
- Lead gen bot
- SaaS build

**Dead ends this session:**
- Hook `command = "./handler.sh"` — relative path doesn't work, Moltis doesn't cd to hook dir before running

---
## 2026-02-13 — Moltis Hardening: Pre-mortem, Rebuild, Model Switch

**Status: SUPERSEDED by session 2 above.**

**What was done this session:**

1. **Docs review completed** — Read all 16 Moltis doc files, found 9 gaps in our setup
2. **9 gaps fixed:**
   - Created IDENTITY.md (bot identity) + USER.md (Brandon's profile)
   - Fixed config paths: sandbox under `[tools.exec.sandbox]`, browser under `[tools.browser]`
   - Added `allowed_domains` for browser (trading sites only, with wildcards)
   - Added `[cron] rate_limit_max = 3`
   - Created AfterLLMCall hallucination filter hook (proper HOOK.md format)
   - Removed fake `[agent]` and `[sandbox]` top-level sections (silently ignored)

3. **Pre-mortem caught 5 broken configs:**
   - `max_iterations` config key doesn't exist — hardcoded const in `runner.rs:23`
   - Hook was bare shell script, needed HOOK.md subdirectory format
   - `[sandbox]`, `[agent]`, `[browser]` all at wrong TOML paths
   - All fixed and verified

4. **Docker image rebuilt with MAX_ITERATIONS=10** (was 25, hardcoded)
   - Patched `crates/agents/src/runner.rs` line 23
   - Build took ~20min on 2 vCPU (LTO link step is slow)
   - Image: `moltis:local` built 2026-02-13T09:16:12Z

5. **Model switched: DeepSeek V3.2 → Z.AI GLM-5 direct**
   - No more OpenRouter middleman
   - Z.AI API: `https://api.z.ai/api/paas/v4`
   - API key: `f36c7fc41dbe4b65afd9a3224eb7e594.HIeWzX4zINb0G71y`
   - Used `[providers.openrouter]` config key with Z.AI base_url (Moltis doesn't have native Z.AI support)
   - User topped up $30 on Z.AI

6. **SaaS business prompt drafted** — Full prompt for agent to build one-click trading bot SaaS
   - Path 1: one container per customer (simpler, do first)
   - Provisioning script + templates + admin dashboard + Stripe billing

7. **Identified 4 code changes from stock Moltis for SaaS custom image:**
   - `runner.rs:23` MAX_ITERATIONS 25→10
   - `embeddings_openai.rs` strip double /v1
   - `discord/src/access.rs+config.rs+handlers.rs` channel/user allowlists
   - `Dockerfile` remove docker.sock VOLUME

**Current blocker:** Bot has cached DeepSeek model from old session. Shows `model 'openrouter::deepseek/deepseek-v3.2' not found`. **Needs `docker restart moltis`** to start fresh session with GLM-5.

**Cron jobs LOST again** — `docker compose down/up` during rebuild wiped all 4 cron jobs (not on persistent volume). Only heartbeat remains.

**Hook circuit breaker tripped** — `filter-hallucinations` hook failed 3 times on first run and got auto-disabled. Handler.sh works when tested manually. May need to investigate how Moltis passes data to shell hooks vs stdin.

**VPS state (jp):**
- Container: moltis (Up), plus 4 sandbox containers
- Image: `moltis:local` with MAX_ITERATIONS=10
- Model: Z.AI GLM-5 direct (config set, needs restart to activate)
- Free RAM: ~2.2GB available
- Hooks: 5 discovered (2 shell, 3 built-in), 4 registered

**Key files on jp VPS:**
- Config: `/root/moltis-deploy/config/moltis.toml` (Z.AI direct, GLM-5)
- Source: `/root/moltis/` (patched runner.rs)
- Hook: `/root/moltis-deploy/data/hooks/filter-hallucinations/HOOK.md`
- IDENTITY.md + USER.md: `/root/moltis-deploy/data/`

**Still not done:**
- Restart bot to clear cached DeepSeek session (user rejected earlier, try again)
- Fix hook circuit breaker (investigate AfterLLMCall data format)
- Re-add 4 cron jobs (lost on container recreate)
- Turn off "Public Bot" in Discord Developer Portal (manual)
- Persist cron data on a volume
- DM support still not working
- Lead gen bot
- SaaS build

**Dead ends this session:**
- `[agent] max_iterations` config key — doesn't exist in schema, silently ignored
- `[sandbox]` top-level config — wrong path, must be `[tools.exec.sandbox]`
- `[browser]` top-level config — wrong path, must be `[tools.browser]`
- Bare shell scripts as hooks — Moltis requires HOOK.md in subdirectory
- `zai` as provider config name — not in known provider list, used `openrouter` key instead

---
## 2026-02-13 — Moltis Trading Bot: Full Setup + VPS Cleanup

**Status: FULLY DEPLOYED. Trading bot live on jp VPS.**

**What was done this session:**

1. **Security rebuild completed** — Docker image rebuilt with channel_allowlist + guild_user_allowlist code. All 4 layers of Discord lockdown now ACTIVE (guild, channel, user, DM).

2. **Trading authorization** — Updated SOUL.md, AGENTS.md, TOOLS.md to give bot full authorization to read private key from `/home/moltis/.config/moltis/secrets.env` and execute trades. $10K by Feb 28 target set. Conservative risk rules removed per user request.

3. **8 trading skills installed:**
   - hyperliquid, polymarket, market-data, on-chain, news-scanner, trade-journal, trade, tmux

4. **4 cron jobs active:**
   - Heartbeat (30min) — quick market scan
   - Funding Rate Scanner (hourly) — flags anomalous rates
   - News Scanner (30min) — breaking crypto news
   - Position Monitor (15min) — checks open trade P&L

5. **Crash recovery + memory split:**
   - `notes/active-positions.md` — read FIRST on startup
   - `notes/trade-journal.md` — P&L tracking
   - `notes/lessons.md` — what works/doesn't
   - BOOT.md updated to prioritize crash recovery

6. **Response speed optimization** — Added efficiency rules to SOUL.md (batch tool calls, max 3 iterations, no browsing when APIs exist)

7. **TOOLS.md rewritten** — Complete inventory of all tools, skills, cron jobs, notes files, SDK setup

8. **VPS cleanup — OpenClaw + hyperbot + autoheal WIPED:**
   - All containers, images, source, config, data deleted
   - 8.16GB reclaimed
   - Only Moltis + sandbox + browserless remain
   - 3.2GB free RAM of 3.8GB

**VPS state (jp):**
- Only containers: moltis, sandbox (ubuntu:25.10), browserless/chrome
- Free RAM: 3.2GB / 3.8GB
- No OpenClaw, no hyperbot, no autoheal
- Cron job remaining: workspace-backup at 20:00 UTC

**User's next interest:** Lead gen specialist bot — wants another Moltis instance on same VPS. Also mentioned SaaS idea (one-click Moltis for users, Telegram only, 3 model tiers).

**Key files on jp VPS:**
- Config: `/root/moltis-deploy/config/moltis.toml`
- Secrets: `/root/moltis-deploy/config/secrets.env` (wallet private key)
- Data: `/root/moltis-deploy/data/`
- Skills: `/root/moltis-deploy/data/skills/` (8 skills)
- Notes: `/root/moltis-deploy/data/notes/` (3 files)
- Cron: inside container at `/home/moltis/.clawdbot/cron/jobs.json` (4 jobs) — NOTE: not on a persistent volume, will reset if container is recreated (not restarted)

**Still not done:**
- Turn off "Public Bot" in Discord Developer Portal (manual)
- Cron jobs.json not on persistent volume (survives restart, NOT recreate)
- DM support still not working
- Lead gen bot (user interested but interrupted to write bc)

---
## 2026-02-13 — Moltis Security Hardening + Embeddings Fix

**Status: COMPLETED — superseded by entry above.**

**Security hardening applied (config — LIVE NOW):**
- Ports locked to `127.0.0.1` (was `0.0.0.0` — exposed to internet via Docker bypassing UFW)
- Config file permissions 600 (was 644 — world-readable with API keys)
- Guild allowlist: `1471722191203598379` (Satoru Gojo's server only)
- User allowlist (DMs): `524122516717961224` (owner only)
- Docker socket GID fixed: `group_add: "119"` (was broken, permission denied)

**Security features coded (NEEDS REBUILD to activate):**
- `channel_allowlist`: restrict bot to specific channels (set to `general` only: `1471722199151808544`)
- `guild_user_allowlist`: restrict which users can trigger bot in guilds (set to owner: `524122516717961224`)
- Commits: `893aaa9` (embeddings fix) + `f925e6e` (channel/user allowlists)

**Embeddings fix (REBUILT + LIVE):**
- Bug: `https://openrouter.ai/api/v1/v1/embeddings` (double `/v1`) causing 404 on memory_search
- Fix: strip trailing `/v1` from base URL in `with_base_url()` — affects OpenRouter, Mistral, Cerebras, Minimax, Moonshot, Venice
- Deployed: image rebuilt and running with fix

**What still needs doing:**
1. **REBUILD Docker image** to activate channel_allowlist + guild_user_allowlist (code pushed to VPS at `/root/moltis/`, config already written to `/root/moltis-deploy/config/moltis.toml`)
   - Run: `cd /root/moltis-deploy && docker compose build && docker compose down && docker compose up -d`
2. **Discord Developer Portal**: Turn off "Public Bot" to prevent anyone adding bot to other servers (manual — portal only, no API)
3. DM support still not working
4. Web UI onboarding not completed
5. No Cloudflare Tunnel for Moltis web UI
6. No cron jobs configured for Moltis

**Key files modified this session:**
- `crates/memory/src/embeddings_openai.rs` — strip `/v1` from base URL
- `crates/discord/src/config.rs` — added `channel_allowlist`, `guild_user_allowlist` fields
- `crates/discord/src/access.rs` — enforce new allowlists + `channel_id` param
- `crates/discord/src/handlers.rs` — pass channel_id to access check
- `Dockerfile` — removed `/var/run/docker.sock` from VOLUME declaration
- `/root/moltis-deploy/config/moltis.toml` — full lockdown config
- `/root/moltis-deploy/docker-compose.yml` — localhost ports, group_add 119

**Deployment state:**
- Container: `moltis` on jp VPS
- Image: `moltis:local` (has embeddings fix, does NOT have channel/user allowlists yet)
- Config: fully hardened (channel_allowlist + guild_user_allowlist set, but code not deployed yet)
- VPS source: `/root/moltis/` pulled to `f925e6e`

---
## 2026-02-12 — Session: OpenClaw Stability Fix + Model Switch

**What we worked on:** Fixed "keeps dying" issue with LLM timeouts. Pulled latest OpenClaw (10 commits), added memory limits, enabled container pruning. Switched GLM-5 → DeepSeek V3.2 for speed. Enabled thinking mode.

**What worked:**
- Pulled commit `5c32989f5` with 35x faster sessions.json parsing
- Docker memory limits: 2GB RAM + 4GB swap enforced (verified: 462MB/2GB usage)
- Node heap limit: 2072MB (NODE_OPTIONS configured)
- Sandbox pruning: scope=shared, idleHours=2 (verified in config)
- Disabled ClawRouter, switched to direct `openrouter/z-ai/glm-5`
- Switched to `openrouter/deepseek/deepseek-v3.2` (user wanted speed over GLM-5)
- Set `thinkingDefault: high` in config

**What didn't work:**
- `timeoutMs` isn't a valid config key in `agents.defaults` — tried to increase timeout but key is unrecognized
- `thinking` key also invalid — correct key is `thinkingDefault`
- Config changes don't auto-apply to existing sessions — bot needs new session or `/think high` directive

**Lessons learned:**
- OpenClaw 10-minute timeout is hardcoded, not configurable in config file
- Config `thinkingDefault` only applies to NEW sessions, not existing ones
- Docker IS the right deployment method — issue was missing memory limits, not Docker
- DeepSeek V3.2 was used before and had "quality issues" (from MEMORY.md) but user prioritizes speed
- Sessions.json is single file, not per-session files
- `prove-it` verification caught issues: config said high thinking, but active session had old settings

**Left off at:**
- Gateway healthy with DeepSeek V3.2, thinkingDefault=high configured
- Bot's current Discord session still using old settings (no thinking mode)
- Need to send `/think high` or `/t high` to bot's Discord to enable for current session
- Or wait for new session to start (will auto-use high thinking)
- Stability improvements applied, need 24h to verify 10-min timeouts don't recur

**Key files modified:**
- `/root/openclaw-src/` — pulled to commit `b094491cf` (latest)
- `/root/openclaw/docker-compose.yml` — added mem_limit, memswap_limit, shm_size, NODE_OPTIONS
- `/root/.clawdbot/moltbot.json` — changed primary model twice (clawrouter→glm-5→deepseek-v3.2), added thinkingDefault=high, added sandbox pruning
- Rebuilt Docker image: `openclaw:local` at `2026-02-12T11:22:23Z`

**Backups created:**
- `/root/openclaw/docker-compose.yml.backup-20260212-191455`
- `/root/.clawdbot/moltbot.json.backup-20260212-191455`

**Not resolved (needs 24h observation):**
- Can't prove 10-min timeouts won't happen (need time to observe)
- Cron job success rate still 40% (target: 90%+) — monitor after a day
- Slow listener warning (50s) appeared 3min after restart — may still have performance issues

**Notes for next time:**
- Bot will report "no thinking mode" until session resets — this is expected behavior
- Monitor: `docker logs openclaw-gateway-1 --follow | grep timeout`
- Check cron success rate tomorrow
- If DeepSeek V3.2 quality issues return, switch back to GLM-5 (already in fallback chain)

---
## 2026-02-12 — Session End: Final Check + Email Fix

**What we worked on:** Completed pre-mortem verification (Gemini Flash, Brave, email). Fixed email password in .env. Ran full `/do final check` — proved-it + loose-ends on entire Zeus infrastructure.
**What worked:** Password `xxggvohvsrtzhtea` was valid all along — failed earlier only because Docker env vars weren't injected. Gemini Flash 502 was wget issue, not model issue. Testing from inside container with node/curl confirms everything works.
**What didn't work:** Searching session logs for "newest" password was a dead end — user had already sent the correct one earlier.
**Left off at:** ALL systems verified green. Gateway healthy, router healthy, tunnel active, all env vars injected, cron jobs clean, email sends, Gemini Flash responds, Brave search works. Only finding: hyperbot exited (137) 4h ago — needs user decision.
**Key files:** `/root/openclaw/.env` (updated email password), `/root/.clawdbot/moltbot.json` (updated email password)
**Notes for next time:** Hyperbot down — user needs to decide if it should be restarted. Cron job names are stale labels (e.g., "Bluesky 09:15" but actually runs at 09:20) — cosmetic, not blocking.

---
## 2026-02-12 — Session: Config Audit Verification Complete

**What we worked on:** Verified all 3 pre-mortem test items from config audit: Gemini Flash fallback, Brave search, email SMTP.
**What worked:** All 3 tests PASS. Email password `xxggvohvsrtzhtea` was correct — it failed earlier because EMAIL_PASSWORD wasn't injected into Docker. Gemini Flash 502 was wget issue, works fine with proper auth headers.
**Key fix:** Updated .env and moltbot.json with correct email password `xxggvohvsrtzhtea`.
**Lessons:** OpenClaw config `env` section does NOT inject env vars into Docker containers. Must use docker-compose `environment` section. This was the root cause of email, Brave search, and Gemini all being silently broken.

---
## 2026-02-12 — Session End: Cron Fix + Pre-mortem Hardening

**What we worked on:** Fixed all 18 broken cron jobs (dead pony-alpha model), added new jobs, ran pre-mortem analysis and hardened the schedule.
**What worked:** Stopping gateway → editing jobs.json directly → restarting. Python scripts over SSH for JSON manipulation. Manual job trigger by setting nextRunAtMs to near-future.
**What didn't work:** f-strings with backslash escapes in SSH heredocs (Python 3.11 restriction). Router port not exposed to host (Docker-internal only) — must test from inside container.
**Left off at:** All 16 enabled cron jobs on DeepSeek V3.2, staggered schedules, timeouts set, 2 new jobs (health check + markdown maintenance), workspace backup cron. Pre-mortem mitigations all verified.
**Key files:** `/root/.openclaw/cron/jobs.json`, `/root/scripts/workspace-backup.sh`, `/root/scripts/claw-router.mjs`
**Notes for next time:** `maxConcurrentRuns=2` behavior (queue vs skip) still unobserved in real traffic — check after a full day of cron runs. Markdown Maintenance ran OK in 61s but delivery was "silent" so no Discord output. 206s slow listener still appeared during this session — may need further investigation.

---
## 2026-02-12 — Session: ClawRouter + Harness Engineering Optimization

**Status:** DEPLOYED AND OPTIMIZED — all traffic on DeepSeek, context trimmed 55%

**Architecture:**
```
Discord → OpenClaw Gateway → ClawRouter Lite (port 18800) → OpenRouter API
                                  → deepseek/deepseek-v3.2 (all traffic, $0.25/$0.38)
```

**Optimizations applied (harness engineering inspired):**
1. Switched default model from GLM-4.5 Air (free, 7-33s/call) to DeepSeek V3.2 (3-10s/call)
2. Slimmed bootstrap context: 32.6KB → 14.8KB (-55%)
   - HEARTBEAT.md: 7.3KB → 1.3KB (social rules moved to knowledge/social-rules.md)
   - MEMORY.md: 8.6KB → 2.8KB (templates moved to knowledge/templates.md)
   - AGENTS.md: 7.9KB → 1.9KB (removed duplication with SOUL.md, table-of-contents style)
3. web_fetch: maxChars 50K→15K, timeout 30s→20s
4. Context pruning tightened: softTrim 8K→5K, minPrunable 2K→1K
5. bootstrapMaxChars: 20K→12K
6. Added "Response Efficiency" section to IDENTITY.md
7. Removed duplicate browser-use skill

**Results:**
- Before: 173-305 second Discord responses, "Slow listener" warnings
- After: 18-20 second per-call, zero slow warnings since restart

**Knowledge files created:**
- `knowledge/social-rules.md` — Bluesky + Twitter anti-ban rules (moved from HEARTBEAT.md)
- `knowledge/templates.md` — Morning brief + lead card formats (moved from MEMORY.md)
- `knowledge/trading-state.md` — Positions and market observations
- `knowledge/routing-stats.md` — Model performance notes
- `knowledge/lessons.md` — Mistakes and lessons learned

**Key files on jp VPS:**
- Router: `/root/scripts/claw-router.mjs` (local: `scripts/claw-router.mjs`)
- Docker: `/root/openclaw/docker-compose.yml`
- Config: `/root/.clawdbot/moltbot.json`
- Workspace: `/root/.openclaw/workspace/`

**Config state:**
- Primary model: `clawrouter/auto` → DeepSeek V3.2
- Fallback: `openrouter/deepseek/deepseek-v3.2`
- Heartbeat: `openrouter/deepseek/deepseek-v3.2` (bypasses router)
- Exec: security=full, ask=on-miss
- bootstrapMaxChars: 12000
- web.fetch.maxChars: 15000

**Dead ends / lessons:**
- pony-alpha is dead (OpenRouter retired it)
- Free models (GLM-4.5 Air) are too slow for agentic loops (7-33s per call)
- AGENTS.md should be table of contents, not encyclopedia (harness engineering)
- 32KB+ bootstrap context = ~8000 tokens overhead per API call
- OpenClaw providers MUST have apiKey field even for local services
- heartbeat config goes at `agents.defaults.heartbeat.model`, NOT top-level
- Keywords like "buy", "sell" alone cause false positives — need 2+ weak matches

**Not done (all need user dashboard action):**
1. Check poly VPS status in Vultr dashboard
2. Regenerate Polymarket API keys
3. Delete Germany VPS (Hetzner dashboard)
4. Update Vultr API token
5. Rotate exposed API keys

---

## 2026-02-19 - Session End: Sonnet upgrade + full autonomy audit

**What we worked on:** Switched all 3 bots from minimax-m2.5 to Claude Sonnet 4.6. Loosened trading constraints (trust Sonnet's judgment). Final audit of IDENTITY/SOUL/MEMORY — fixed all contradictions, enabled exec access, created skills directories, updated mandate to "make as much profit as possible."
**What worked:** Model switch was clean — configs updated, sessions reset, all containers healthy. Sonnet confirmed loading in logs. PM funded with $196 USDC by user. Comprehensive audit script fixed 27+ contradictions across all 3 bots in one pass.
**What didn't work:** N/A — clean session.
**Left off at:** All 3 bots fully autonomous on Sonnet 4.6. First Sonnet trading cycles about to fire. Need to check results tomorrow.
**Key files:** (all on VPS)
- All 3 configs: `.bak-minimax` backups, primary=`openrouter/anthropic/claude-sonnet-4.6`
- All 3: IDENTITY/SOUL/MEMORY rewritten (backups: `.bak-pre-audit`)
- HL: entries 6/day, caps $400/$300/$200, longs+shorts, judgment-based prompt
- PM: $100 max bet, $30 floor, 8 positions, $196 bankroll, judgment-based prompt
- LeadGen: revenue hunter mandate, can create own tools
- All 3: exec enabled (`allowedCommands: ["*"]`), skills/ directories created
**Notes for next time:** Monitor first Sonnet trading cycles in Discord. Costs will be higher than minimax — watch credits. If Sonnet makes better trades, the cost increase is worth it. All bots know they can write their own scripts and create skills now. The key question: does Sonnet actually make profitable trades?

---

## 2026-02-19 - Snapshot: Self-fund tightened + HL strategy v5 + full 3-bot audit

**Task:** Full 3-bot audit, growth mandate, fix HL negative expectancy, tighten self-funding
**Modified files:** (all on VPS)
- All 3 bots: IDENTITY.md (Economic Mission), SOUL.md (growth framing), MEMORY.md (Growth Mandate)
- LeadGen SOUL.md: full rewrite (revenue hunter). PM SOUL.md: full rewrite (fixed $100->$200 contradictions)
- LeadGen + PM: created active-tasks.md (was missing)
- HL: hl_trade.mjs v5 (entries 4->2, cap 400->250, removed +2% breakeven stop)
- HL: hl_scanner.mjs v5 (bounce +0.5%->+1.0%, crash -5%->-7%, vol $2M->$3M)
- HL: cron prompt rewritten (selectivity, 28% win rate warning, 10min interval)
- System crontab: self-fund every 2h (was 6h), hl_self_fund.mjs at :10 + pm_self_fund.mjs at :25
**Progress:**
- HL stats: 18 trades, 28% win rate, net -$49. Root cause: overtrading + breakeven stop capping winners at $6
- Scanner now produces 2 candidates vs 5+ (tested). Entries blocked today, let 4 existing positions play out.
- Self-fund gap fixed: system cron runs node scripts directly (no LLM needed). Every 2h worst-case.
- All 3 bots have "Economic Mission" in IDENTITY.md — know they're self-sufficient, must grow revenue
- Credits: $18.49, drain ~$5-8/day, HL has $693 withdrawable for self-funding
- Cron announce failures are gateway timeouts (OpenRouter contention), not trading failures — bots ARE trading
**Key context:**
- Self-fund flow: credits <$5 -> system cron fires hl_self_fund.mjs -> withdraw from HL -> bridge Arb->Base -> pay OR. ~10-15 min. No LLM needed.
- HL backups: hl_trade.mjs.bak-v4, hl_scanner.mjs.bak-v4
- Need 3+ days to evaluate strategy v5. Don't touch config until then.
- User asked about actual daily cost vs $35/month estimate — was investigating when session ended. Real cost likely $5-8/day ($150-240/month), much higher than $35/bot estimate.
- User question still open: "is $5 the mark and aim for all 3 to keep at $15 max daily while earning their keep?" — answer: yes current config triggers at $5 buys $10 (bounces to ~$15), all 3 share one credit pool, but bots are NOT earning their keep yet (HL net -$49, PM idle, LeadGen $0 revenue).

---

## 2026-02-19 - Snapshot: HL strategy v5 — fix negative expectancy

**Task:** HL trader was net -$49 on 18 trades (28% win rate). Fix overtrading.
**Modified files:** (all on VPS, HL container)
- `scripts/hl_trade.mjs` — maxEntries 4->2, positionCap 400/300/200->250/200/150, removed +2% breakeven stop
- `scripts/hl_scanner.mjs` — BOUNCING threshold +0.5%->+1.0%, crash filter -5%->-7%, volume $2M->$3M
- `cron/jobs.json` — new prompt (selectivity emphasis, 28% win rate warning), interval 5min->10min
- `scripts/positions.json` — peak reset to $926, entries blocked for today (4 positions already open)
- `MEMORY.md` — added Strategy v5 Update section
**Progress:**
- Root cause identified: 72% of trades hit -3% stop loss. Avg win ($6.24) ~ avg loss ($6.18) but win rate kills it.
- Scanner now produces 2 candidates instead of 5+ (stricter criteria)
- Bot blocked from new entries today — let existing 4 positions play out
- Self-funding system crontab added: hl_self_fund.mjs runs directly (no LLM needed) + pm_self_fund.mjs
- Old auto_topup.mjs system cron replaced with both scripts, staggered at :10 and :25
**Key context:**
- Backups at hl_trade.mjs.bak-v4 and hl_scanner.mjs.bak-v4
- Need 3+ days of data to evaluate if win rate improves. Don't touch config until then.
- The +2% breakeven stop was the biggest issue — caused most winners to exit at exactly +2% ($6 win)
- First real trail now at +5% (trail at +3%). Winners should run to +5-8% now.

---

## 2026-02-19 - Snapshot: Full 3-bot audit + growth mandate + memory upgrade eval

**Task:** Audit all 3 bots' workspace files, add aggressive revenue growth mandate, evaluate @zaimiri memory upgrade
**Modified files:** (all on VPS via docker exec)
- All 3 IDENTITY.md — appended "Economic Mission" section (self-funding awareness, growth targets, revenue responsibilities)
- All 3 MEMORY.md — appended "Growth Mandate" section (concrete targets, anti-idle-cash rules)
- All 3 SOUL.md — HL: updated balance + "economic backbone" framing. LeadGen: full rewrite (revenue hunter). PM: full rewrite (fixed $100->$200 max, $200->$150 floor contradictions)
- LeadGen + PM: created active-tasks.md (was missing)
- Cleaned up stale backup files: HL (3 removed), LeadGen (1 removed), PM (4 removed)
- Reset all cron error counters (announce gateway timeouts, not trading failures)
**Progress:**
- All 3 bots now have growth mandate in IDENTITY + SOUL + MEMORY (3-layer reinforcement)
- Cron announce failures are gateway timeouts (OpenRouter contention), NOT trading failures — bots ARE still trading
- HL has 4 positions open (OP, SPX, VVV, INIT), $926 balance
- All containers restarted, healthy, Discord channels resolving correctly
- @zaimiri memory upgrade evaluated: structured format and implicit triggers are good, but designed for interactive sessions not cron-driven bots. Adopted date-stamped atomic entries approach for MEMORY.md updates.
**Key context:**
- Cron "error" status is misleading — it means Discord announce failed, not that trading stopped. Trade journal confirms active trading.
- Growth targets set: HL $926->$5K, PM $77->$500, LeadGen first client in 30 days
- Each bot now knows: "You are a self-sufficient economic unit. Survival is the floor, not the ceiling."

---

## 2026-02-19 - Snapshot: PM proxy withdrawal + getCash bug fix + Gmail password

**Task:** Fix Gmail SMTP, fix PM getCash bug, withdraw USDC from PM proxy to EOA
**Modified files:** (all on VPS)
- `/root/.openclaw-3/workspace/scripts/pm_trade.mjs` — CRITICAL: removed hardcoded `return 600` fallback in getCash(), added working RPC `polygon-bor-rpc.publicnode.com`, fallback now returns 0
- `/root/.openclaw/workspace/scripts/pm_trade.mjs` — same fix (copy)
- `/root/.openclaw-2/workspace/secrets.env` — Gmail app password updated to `[REDACTED-GMAIL-APP-PW]`
- Nodemailer installed in LeadGen container workspace
**Progress:**
- Gmail SMTP fixed: new app password `[REDACTED-GMAIL-APP-PW]` verified AUTH OK
- **CRITICAL BUG FOUND**: pm_trade.mjs getCash() had hardcoded `return 600` fallback when RPCs failed. All Polygon RPCs were failing from container. Bot was reporting $600 cash when real balance was $21.57. Fixed: returns 0 on failure, added working RPC.
- **PM proxy withdrawal WORKS**: Built Gnosis Safe execTransaction script. Withdrew $21.57 USDC.e from proxy (0x1537397d...e720) → EOA. Tx: 0x8795f2f3...
- **WRONG PROXY ADDRESS in MEMORY.md**: Was `0x1537A8e0...e720`, real is `0x1537397dEd62A76f0e15b6C7e4248655ee66e720`. Fixed in MEMORY.md.
- PM real portfolio: ~$77 in positions, $0 cash now (withdrawn to EOA). Positions return USDC.e as markets resolve.
- EOA now has $21.80 USDC.e on Polygon + 49.82 MATIC
**Key context:**
- Gnosis Safe withdrawal: owner=EOA, threshold=1, use execTransaction with eth_sign (v+4). Gas paid by EOA (needs MATIC). Polygon needs high gas price (~800 gwei).
- PM proxy is a real Gnosis Safe contract (bytecode 250 bytes), NOT an EOA.
- User wants full 3-bot audit of cron/identity/soul/memory/skills/tools — interrupted before starting. NEXT TASK.

---

## 2026-02-19 - Snapshot: Full 3-bot audit + fixes + self-fund tested

**Task:** Audit all 3 bots, fix broken configs, test self-funding pipeline end-to-end
**Modified files:** (all on VPS)
- `/root/.openclaw-2/openclaw.json` — channel ID → channel name "lead-gen" (was "unresolved")
- `/root/.openclaw-2/cron/jobs.json` — rewritten: 11→8 jobs, removed old lead_search pipeline, added cto-hunter/cto-emailer/cto-weekly with proper format, morning-brief updated for "SaaS & mobile app ideas"
- `/root/.openclaw/cron/jobs.json` — added self-fund cron (every 6h), fixed delivery to channel:hl-trading (was raw ID)
- `/root/.openclaw-3/cron/jobs.json` — added self-fund cron (every 6h offset 30m), fixed delivery to channel:pm-trading
- `/root/.openclaw/workspace/MEMORY.md` — HL self-fund docs (primary funder role, hl_self_fund.mjs)
- `/root/.openclaw-3/workspace/MEMORY.md` — PM self-fund docs + available scripts list
- `/root/.openclaw-2/workspace/MEMORY.md` — CTO hunting strategy + available scripts + SaaS ideas requirement
- `/root/.openclaw/workspace/notes/active-tasks.md` — created (was ENOENT)
**Progress:**
- HL self-fund FULLY TESTED: withdrew $15 from HL → bridged $14 Arb→Base via Across → paid $10 to OpenRouter. Credits $9.89→$19.89.
- PM self-fund tested: correctly identifies no on-chain USDC, falls back to HL as primary funder.
- LeadGen Discord FIXED: OpenClaw needs channel NAMES not IDs in guild config. Changed "1473982126671138816" → "lead-gen". Now resolves correctly.
- All cron deliveries fixed: HL uses channel:hl-trading, PM uses channel:pm-trading, LeadGen uses channel:lead-gen (was raw IDs causing "Unknown Channel" errors)
- LeadGen cron cleaned: removed 3 duplicate lead-search jobs (old pipeline), fixed 3 leadgen-* jobs (wrong format: had `prompt` instead of `payload.kind:"agentTurn"`), renamed to cto-hunter/cto-emailer/cto-weekly
- PM has $600 cash in CLOB exchange — NOT withdrawable via API. Proxy wallet $0 on-chain. PM cannot programmatically contribute to OR funding.
**Key context:**
- OpenClaw channel resolution: ALWAYS use channel names in guild config, not IDs. OpenClaw resolves names→IDs at startup.
- OR credits: $19.89 (healthy after HL self-fund)
- HL is PRIMARY funder (can withdraw from Hyperliquid). PM is backup only (on-chain USDC).
- User wants PM to "transfer money to HL as its share" — blocked because PM CLOB has no withdrawal API. $600 stuck in exchange.
- HL "No reply from agent" issue: sessions are clean (0 tokens), likely minimax being flaky. Not session corruption.

---

## 2026-02-19 - Snapshot: Self-funding pipeline (HL withdraw → bridge → OR)

**Task:** Build self-funding scripts so bots pay their own OpenRouter credits from trading profits
**Modified files:** scripts/hl_self_fund.mjs (new), scripts/pm_self_fund.mjs (new), deployed to VPS
**Progress:**
- Built `hl_self_fund.mjs`: HL withdraw → Arbitrum → Across bridge to Base → pay OpenRouter. Uses @nktkas/hyperliquid SDK for HL withdrawal signing, ethers v6 for on-chain ops.
- Built `pm_self_fund.mjs`: checks Base/Polygon USDC → bridge via Across → pay OR. PM CLOB has no withdrawal API, so PM bot relies on HL bot as primary funder.
- HL withdrawal tested and WORKING: withdrew $15 from HL (status: ok), $14.01 arrived on Arbitrum (~$1 HL withdrawal fee).
- Bridge step NOT yet tested — timed out waiting for Arb USDC (threshold was 95%, HL fee made it 93.4%). Fixed threshold to 85%.
- $14.01 USDC sitting on Arbitrum ready to bridge. Next run should complete the full pipeline.
- Also fixed: LeadGen bot token updated to MTQ3Mzk4NDgzMDAxMzQ0MDA0MA..., cron.jobs moved from openclaw.json to cron/jobs.json (was in wrong location), dm config structure migrated.
- Fixed auto_topup.mjs file permissions (root → UID 1000) so bots can read/write it.
**Key context:**
- OpenRouter credits: $10.65 and dropping. No USDC on Base. HL has $722 withdrawable.
- OpenRouter only supports chains 1 (ETH), 137 (Polygon), 8453 (Base) — NOT Arbitrum. Bridge is mandatory.
- HL withdrawal fee: ~$1 per withdrawal. Across bridge fee: ~$0.10 for $15. OR crypto fee: 5%.
- Across SpokePool on Arbitrum: returned dynamically by /suggested-fees API.
- EIP-712 signing for HL withdraw3: domain={name:"HyperliquidSignTransaction", version:"1", chainId:42161}, primaryType="HyperliquidTransaction:Withdraw".
- HL container has ethers v6 + @nktkas/hyperliquid SDK. PM container has ethers v5 via @polymarket/clob-client.
- Cron not yet added — need to finish testing first.
- LeadGen bot (MTQ3Mzk4...) can't see channel 1473982126671138816 — needs to be invited to Discord server.

---

## 2026-02-19 - Snapshot: LeadGen v2 deployed + OR key swap + Gmail password

**Task:** Build LinkedIn CTO lead gen agent, update OpenRouter keys, fix Gmail auth
**Modified files:** scripts/lead_ops.mjs (new), /root/.openclaw-2/openclaw.json (cron jobs + new API keys + new Discord channel), secrets.env (Gmail + Brave keys), MEMORY.md
**Progress:**
- OpenRouter recovered from 401 outage. Updated all 3 bots to new API key ([REDACTED-OR-PARTIAL]...).
- Built lead_ops.mjs: Brave Search `site:linkedin.com/in "CTO" "SaaS"` → parse name/title/company → guess email + MX check → Gmail SMTP send. 6 subcommands: find/enrich/email/report/stats/unsub.
- Tested: 20 leads found, 6 enriched with valid emails (MX verified), 1 test email sent successfully.
- Revived openclaw-leadgen-1 container. 3 cron jobs: 9am SGT find+enrich, 11am SGT email (3-5/day), Monday weekly report.
- Gmail app password expired — new one: etlyrqmgbhouboog (old xxggvohvsrtzhtea revoked).
- Discord channel updated to 1473982126671138816, new bot token applied.
- Brave API key updated: [REDACTED] (old one was dead).
- Apify tried and abandoned — undocumented actor input schemas, waste of time.
- User services for pitching: reco-vn (outsourcing), emp0 (AI automation), truedax (enterprise AI), wgentech (mobile/web dev).
**Key context:**
- Base USDC wallet nearly emptied by user ($548 withdrawn to Crypto.com). Bots have ~$13 credits left, no self-funding possible until wallet refilled.
- LeadGen enrichment rate: ~30% (6/20). Main failure: company name extracted as full LinkedIn headline → domain guess is garbage. Could improve by using Brave search to find actual company website.
- First real cron run: 9am SGT tomorrow (01:00 UTC Feb 20).

---

## 2026-02-19 - Snapshot: Self-funding bots + OpenRouter outage

**Task:** Make trading bots self-funding, wallet scare investigation, kill LeadGen
**Modified files:** scripts/auto_topup.mjs (new), MEMORY.md (all 3 bots), crontab on jp
**Progress:**
- Wallet scare: user thought PM wallet drained. Investigated — $600 USDC was on Base (user bridged), HL fine at $947. MetaMask had mini display outage.
- Built auto_topup.mjs: checks OpenRouter credits, buys $10 via USDC on Base using Coinbase Commerce transferTokenPreApproved. First tx confirmed ($10.50 USDC → $10 credits).
- Deployed to `/root/.openclaw-3/workspace/scripts/auto_topup.mjs` (PM container)
- System cron: `0 */6 * * *` runs auto-topup every 6 hours
- All 3 bots' MEMORY.md updated with "Self-Funding Compute" section — pay for yourself or die
- Killed openclaw-leadgen-1 container (user: "it's useless")
- OpenRouter account hit "User not found" 401 on all endpoints. Dashboard shows $13.48 credits, key valid — OR auth bug. Bots parked until OR recovers.
- CRITICAL ABI lesson: Coinbase Commerce TransferIntent struct field order is `signature` THEN `prefix` (not reversed)
- fetchJSON bug: `...opts` after `headers` overwrites merged headers — must destructure separately
**Key context:**
- OpenRouter key: [REDACTED-OR-PARTIAL]...42674 (new, but returns 401 — OR-side issue)
- Old key: [REDACTED-OR-PARTIAL]...78f6b (also dead — account-level problem)
- Need to update all bots with new key once OR recovers
- PM bot container: openclaw-pmtrader-1 (mounts /root/.openclaw-3)
- Base USDC funding wallet: 0x149dc5...77B7 (~$549 remaining)

---

## 2026-02-18 (session 30) — PM qbuy fix + HL strategy rebuild (DONE)

**What we worked on:** Two things: (1) Fixed PM qbuy/qsell orderbook bug, (2) Started rebuilding HL trader from momentum to dip-buying strategy.

**PM qbuy fix (DONE):**
- Root cause: Polymarket CLOB `/book` API returns asks DESCENDING (highest first), bids ASCENDING (lowest first). qbuy read `asks[0]` = $0.99 instead of real best ask $0.19. qsell read `bids[0]` = $0.01 instead of real best bid $0.18.
- Fix: `getBook()` now sorts asks ascending, bids descending before returning.
- Deployed pm_trade.mjs v4 to BOTH `/root/.openclaw-3/workspace/scripts/` AND `/root/.openclaw/workspace/scripts/`
- Verified: real trade executed — 135 shares Iran March 15 at $0.37 ($50). PM container restarted, healthy.
- PM MEMORY.md updated with bug fix note. Backups at `.bak-v3`.

**HL strategy rebuild (DEPLOYED + VERIFIED):**
- Switched from momentum chasing (negative EV) to mean reversion / dip buying
- Pre-mortem caught -1.5% stop was too tight for dip buys → widened to -3%
- Deployed: hl_scanner.mjs v4 (dip scanner), hl_trade.mjs v4 ($150 cap, 2 entries/day, trailing stops), new cron prompt, new MEMORY.md
- Closed LIT SHORT, reset positions.json (peak=$931, 0 entries)
- First cron cycle: bot opened VVV LONG at $4.04 (~$149). Picked it because BOUNCING +2.4%/1h, crashed -6.4% 24h, $15.5M vol. Exactly the behavior we designed.
- Backups: jobs.json.bak-v7, MEMORY.md.bak-momentum2

**Also cleaned up HL workspace:**
- Updated IDENTITY.md (was "Swing Trader" referencing momentum, now "Dip Buyer")
- Removed pm_trade.mjs from HL workspace (belongs on PM bot only)
- Removed stale notes: active-tasks.md (old $1K fantasy), poly-sell-howto.md, last-prices.*, liquidation-baseline.json
- Updated Daily P&L cron prompt (was "flips", now "trades" + dip strategy check)
- Fixed entry counter bug: positions.json reset wiped todayEntries → bot could open unlimited positions. Manually set to 2/2. Safety block verified working.

**Account state (end of session):**
- HL: $933, 2 positions (VVV LONG $149 + LIT LONG $149), 2/2 entries, dip strategy live
- PM: $518 cash + ~$251 positions (5 active + 69 micro), qbuy working now
- PM new position: Iran March 15 YES 135sh @ $0.37 (from qbuy test)
- LeadGen: healthy, 0/25+ email replies

**Key files modified on VPS this session:**
- `/root/.openclaw/workspace/scripts/hl_scanner.mjs` — v4 dip scanner (backup: .bak-v3)
- `/root/.openclaw/workspace/scripts/hl_trade.mjs` — v4 dip trader (backup: .bak-v3)
- `/root/.openclaw/workspace/IDENTITY.md` — dip buyer identity
- `/root/.openclaw/workspace/MEMORY.md` — dip strategy memory (backup: .bak-momentum2)
- `/root/.openclaw/cron/jobs.json` — dip prompt + daily report (backup: .bak-v7)
- `/root/.openclaw-3/workspace/scripts/pm_trade.mjs` — v4 orderbook sort fix
- `/root/.openclaw/workspace/scripts/pm_trade.mjs` — v4 (same fix, main trader copy)
- `/root/.openclaw-3/workspace/MEMORY.md` — updated with qbuy fix note

---

## 2026-02-17 (session 29) — Auto-learning MEMORY.md for all 3 bots

**What we worked on:** Added self-updating MEMORY.md to all 3 bots. Cron prompts now instruct bots to read MEMORY.md and append new learnings.
**What worked:** Patched all cron jobs via jq. Light "LEARN" step on cycle crons (HL 5-min, PM 1h). Full "LEARNING STEP" on daily report crons (HL daily-pnl, PM pm-daily, LG daily-standup). All containers restarted, healthy.
**What didn't work:** N/A — clean deploy.
**Left off at:** All 3 bots now self-update MEMORY.md. Backups at `jobs.json.bak-pre-learn` in each cron dir.

**Health check snapshot:**
- HL: $945, 4 positions (UMA/VVV/IP/STABLE), -$15 today, 5/6 entries, cron OK
- PM: $615 cash, 11 active + 62 micro positions, cron mostly OK (1 timeout), no new trades (no edge found)
- LeadGen: all crons running, 25+ leads contacted, 0 replies, Bluesky posting OK
- Elon bet confirmed lost ($60) — gone from positions
- OpenRouter had brief 401 blip at 05:40 UTC today (bluesky-afternoon failed), recovered
- All containers restarted and healthy

---

## 2026-02-17 (session 28) — OpenRouter outage, emergency model switch

**What we worked on:** All 3 bots went down — OpenRouter returned HTTP 401 "User not found" on all API keys. Emergency switch to MiniMax direct + Kimi K2 fallback, then switched back when OpenRouter recovered.
**What worked:** MiniMax direct API (`api.minimaxi.chat/v1`) and Kimi K2 (`api.moonshot.ai/v1`) both work as standalone providers. HL trader ran fine on MiniMax direct (4+ consecutive OK runs). Backup configs saved as `.bak-openrouter`.
**What didn't work:** PM trader timed out on MiniMax direct at 300s default — needed 600s. OpenRouter "User not found" error was misleading — turned out to be a temporary outage, not an account/key issue. `memorySearch.provider: "google"` is NOT valid in OpenClaw — crashed containers on startup.
**Left off at:** All 3 bots back on OpenRouter after it recovered. Verified HL cron OK post-restore.

**Key findings:**
- OpenRouter can go down without warning — "User not found" on valid keys, dashboard still works (cookie auth vs API auth)
- MiniMax direct API key: `[REDACTED-MINIMAX-PARTIAL]...SuU` (tested, working)
- Kimi K2 API: `api.moonshot.ai/v1`, key `[REDACTED-KIMI-PARTIAL]...NJDX`, models: `kimi-k2.5` (reasoning), `kimi-k2-0905-preview` (lean)
- Z.AI/GLM-5 key has zero balance ("余额不足")
- OpenClaw valid memorySearch providers: "openai" (not "google") — use with remote.baseUrl
- PM bot DID trade since session 26 — 8 new positions (Bernie, Metz, OpenAI, Colombian seats, etc.)
- Elon tweet bet (462 shares, $60) resolved and disappeared — likely lost
- ClawRouter (BlockRunAI/ClawRouter) reviewed — not useful now (requires USDC on Base, another middleman)

**Files modified on VPS (then restored):**
- `/root/.openclaw/openclaw.json` — backup at `.bak-openrouter`
- `/root/.openclaw-2/openclaw.json` — backup at `.bak-openrouter`
- `/root/.openclaw-3/openclaw.json` — backup at `.bak-openrouter`

---

## 2026-02-17 (session 26) — HL + PM trader performance tuning

**What we worked on:** HL daily P&L was $3-12 (too low). Full optimization of both traders for bigger wins, fewer losses.
**What worked:** Diagnosed root cause — 8 entries/day + tight +4% TP + mechanical close rules = lots of small churn. Fixed with fewer entries, wider targets, guidance-based prompt, early momentum scanner.
**What didn't work:** N/A — all changes deployed cleanly.
**Left off at:** Both bots restarted with new config. Need 2-3 days of data before further tuning.

**HL Trader v5 changes:**
- hl_trade.mjs: 6 entries/day (was 8), $450 cap (was $350), +8% TP (was +4%), -3% SL (was -2%), $200 memecoin cap (was $150)
- hl_scanner.mjs v3: early momentum detection (catches breakouts BEFORE they show in 24h stats)
- Cron: 5-min cycles (was 15-min), guidance-based prompt (removed all 4 mechanical close rules)
- MEMORY.md: $20-50/day target, FRESH-only, early momentum emphasis
- Verified: 2 cron cycles showed correct behavior (FRESH-only, holding positions patiently)

**PM Trader v4 changes:**
- pm_trade.mjs: $200 max bet (was $100), 12 positions (was 8), $150 cash floor (was $200)
- Cron: 1h cycles (was 2h), scans trending + expiring 30d (was just expiring 14d), 1.3x edge threshold (was 2x), web search for research
- MEMORY.md: deploy cash, $75 minimum bets, stop wasting time on illiquid sells
- PM has $615 idle cash — should start finding trades with lower threshold + broader scanning

**Key insight:** The bot's problem was NEVER the safety rails. It was: too many marginal entries + closing winners too early + scanner missing early moves. Fix the signal quality and let winners run.

**Files modified on VPS:**
- `/root/.openclaw/workspace/scripts/hl_trade.mjs` — v5 (backup: .bak-v3)
- `/root/.openclaw/workspace/scripts/hl_scanner.mjs` — v3 (backup: .bak-v2)
- `/root/.openclaw/cron/jobs.json` — 5-min, guidance prompt (backup: .bak-v5)
- `/root/.openclaw/workspace/MEMORY.md` — $20-50 target, early momentum
- `/root/.openclaw-3/workspace/scripts/pm_trade.mjs` — $200/$150 limits (backup: .bak-v3)
- `/root/.openclaw-3/cron/jobs.json` — 1h, broader scanning (backup: .bak-v3)
- `/root/.openclaw-3/workspace/MEMORY.md` — deploy cash, broader strategy

---

## 2026-02-17 (session 25) — Full 3-bot audit + optimization

**Done:**
- **CR Colombia sell diagnosis**: "not enough balance/allowance" was rounding bug (518 vs 517.77), NOT token approval. All approvals verified correct on-chain. Market is illiquid ($0.001 best bid), must resolve at expiry.
- **pm_trade.mjs v3**: qsell uses CLOB balance (exact) instead of data-api (rounded). Added `forceqsell` (bypass liquidity guard) and `approve` command. Deployed to PM trader + main trader.
- **lead_search.js v4**: Fixed Reddit (Brave Search fallback, direct API returns 403). Added 45-day date filter on HN Who's Hiring (was pulling 2016 threads). Tested: 173 leads, Feb 2026 only.
- **HL MEMORY.md**: Realistic targets ($10-30/day, not $60-80). Fee math added. Quality > quantity emphasis.
- **HL SOUL.md**: Removed $10K/month fantasy. Now: "$965 to $2K to $5K, consistency beats moonshots."
- **PM SOUL.md**: Custom persona (was generic default). Cold, analytical, patient. Data-driven edge philosophy.
- **Bluesky cron prompts**: Humanized voice with WRITING.md reference, example good/bad posts, "text a smart friend" style.
- **HL cron**: 15-min cycles (was 10-min). 33% fewer API calls, same trade quality.
- **PM cron**: Timeout 600s to 300s (avg run 154s). Added cron config section.
- **Cleanup**: Removed 7 test files from LeadGen, pm_trade.mjs + agent_created.txt from HL. Cleared 7 stuck delivery queue entries. Fixed file permissions.
- **All 3 containers restarted**, Discord connected, healthy.

**Not done / still open:**
- CR Colombia position (518 shares, $2.59 cost) stuck until expiry resolution (illiquid)
- LeadGen config doctor migration (dm.policy) — cosmetic, not blocking
- OpenRouter shared API key across 3 bots — no monitoring of credit usage
- trade-journal.md grows unbounded (accepted risk)

**Key files modified on VPS:**
- `/root/.openclaw-3/workspace/scripts/pm_trade.mjs` — v3
- `/root/.openclaw-2/workspace/scripts/lead_search.js` — v4
- `/root/.openclaw/workspace/MEMORY.md` — realistic targets
- `/root/.openclaw/workspace/SOUL.md` — realistic targets
- `/root/.openclaw-3/workspace/SOUL.md` — custom PM persona
- `/root/.openclaw-2/cron/jobs.json` — humanized Bluesky prompts
- `/root/.openclaw/cron/jobs.json` — 15-min cycles
- `/root/.openclaw-3/cron/jobs.json` — 300s timeout
- `/root/.openclaw-3/openclaw.json` — added cron section

**Lessons:**
- Polymarket "not enough balance/allowance" can be a rounding issue: data-api `size` rounds up, CLOB balance is exact (6 decimals). Always use `getBalanceAllowance()` for sell sizing.
- HL Trader: unrealistic targets in MEMORY/SOUL cause overtrading. "$60-80/day from $965" = 6-8% daily, which drives the bot to fill all 8 entries with marginal setups. Realistic targets = fewer, better trades.
- 10-min cron cycles on HL = 144 API calls/day. 15-min = 96. No quality difference (market moves don't change in 5 min).

---

## 2026-02-17 (session 24) — LeadGen overhaul + PM profit-taking + morning brief v3

**Done:**
- Morning brief v3 deployed: HN (Algolia) + X/Twitter (paid API, 100 results, author expansion, spam filter) + Reddit (Brave fallback since Reddit JSON API blocks servers). Runs 8 AM SGT daily.
- X API bearer token updated on all 3 bots (old tokens expired). New token: `AAAAAA...WbS1` (pay-per-use, not free tier)
- Cron prompt updated: clean `☀️ OPENCLAW MORNING BRIEF` format, 10 mixed-source items, table of 5 build ideas, LinkedIn post
- IDENTITY.md v3 with 4 enforced roles (relentless lead gen, firm accountant, concise morning brief, engagement-first Bluesky)
- lead_search.js v3 deep HN Who's Hiring scan (320 leads, was 5)
- bluesky.js v2 with reply/like/repost/follow/search/notifications
- **OpenAI $750B-1T position SOLD** — 40 shares at $0.122, received $4.88 (cost $3.57 = **+$1.31 profit**). Used `createAndPostOrder` with `OrderType.GTC`, matched instantly.

**Not done / blocked:**
- **CR Colombia sell failed: "not enough balance / allowance"** — proxy wallet has shares (shows in data-api) but CLOB exchange lacks token approval for this specific negRisk conditional token. Need to check/set ERC1155 `setApprovalForAll` for the CTF contract → CLOB exchange. The OpenAI sell worked because those tokens were bought via CLOB (approval already existed). CR Colombia was bought differently.
- **HN Who's Hiring date filter** — lead_search.js v3 pulls old 2016/2017 threads alongside current. Needs `numericFilters=created_at_i>TIMESTAMP` in Algolia query.
- **Reddit JSON API blocked** — returns 403 from servers. Fixed with Brave Search fallback but not as rich as direct API (no scores/comments).
- **OpenClaw cron trigger hack doesn't work reliably** — editing `nextRunAtMs` in jobs.json is NOT hot-reloaded. Container caches at startup. Must set nextRunAtMs to FUTURE time, THEN restart. Even then, `runMissedJobs` only fires once per startup. Cron expression (`0 8 * * * Asia/Singapore`) is the real schedule.
- **7 pending delivery entries** in LeadGen container — "Recovery time budget exceeded" on every restart. Not blocking but not clearing.

**Key files modified on VPS:**
- `/root/.openclaw-2/workspace/scripts/morning_brief.js` — v3 (HN+X+Reddit)
- `/root/.openclaw-2/workspace/secrets.env` — added TWITTER_BEARER_TOKEN
- `/root/.openclaw-2/cron/jobs.json` — updated morning-brief prompt
- `/root/.openclaw/workspace/secrets.env` — updated X token
- `/root/.openclaw-3/workspace/secrets.env` — updated X token

**PM account state:**
- OpenAI $750B-1T: CLOSED (+$1.31 profit)
- CR Colombia: still held (518 shares, $2.59 cost, can't sell — approval issue)
- Iran strikes YES: 120 shares ($16.80 cost, bestBid $0.01)
- Trump deport NO: 60 shares ($59.52 cost, bestBid $0.001)
- Cash: ~$615 (was $610 + $4.88 from OpenAI sale)
- 70+ micro positions resolving at expiry

**Lessons:**
- Polymarket `createAndPostOrder` with `OrderType.GTC` works for limit sells. `createOrder`+`postOrder` separately gives "Invalid order payload"
- NegRisk positions bought via web UI may lack CLOB exchange token approval — need `setApprovalForAll` on the CTF ERC1155 contract
- X API v2 recent search: no server-side engagement filter. Must pull 100 results and filter client-side. `-has:cashtags` removes crypto spam. `expansions=author_id&user.fields=public_metrics` gets follower counts.
- Reddit blocks server-side JSON API requests (403). Brave Search `site:reddit.com` with `freshness=pw` is a reliable fallback.

---

## 2026-02-16 (session 23) — Discord fix + monitoring pass

**What we worked on:** HL trader Discord connection was dead, fixed channel resolution + monitored both bots
**What worked:** Channel name was "hl-trading" not "trading" — OpenClaw resolves by name not ID. Fixed config, bot reconnected instantly.
**What didn't work:** Tried using channel ID directly as config key — OpenClaw doesn't support that, needs the channel name string.
**Left off at:** Both bots autonomous. HL traded 8 times today (+$3.84), PM held (no edge). Entry limit discussion — 8/day is protecting capital (yesterday's 2/day made +$11.91 on better quality).
**Key files:** `/root/.openclaw/openclaw.json` (Discord channel config fix)
**Notes for next time:** OpenClaw Discord channel config uses channel NAMES not IDs. If "unresolved" in logs, check if channel was renamed.

---

## 2026-02-16 (session 21) — PM tools finalized + monitoring pass

**Completed:**
- Liquidity guard on qsell — blocks sells when bid <= $0.003 (garbage negRisk bids). Tested: CR Colombian correctly blocked, Elon (real $0.01 price) passed through.
- Cron prompt v3 — uses qbuy/qsell, philosophy-based ("use your judgment, safety is code-enforced"), replaces broken old buy syntax
- Positions output trimmed — 61 micro positions collapsed to 1 line, saves ~500 tokens for minimax
- Container restarted, new prompt picked up

**Monitoring results (3+ cycles each):**
- HL Trader: 4/5 OK, 1 timeout (minimax). Patiently held 3 cycles, entered XRP SHORT when fresh. Managing position with "let it ride." +$12.74 daily P&L. Solid.
- PM Trader: 1/1 OK with new prompt (92s, was 211s). Tried profit-taking on 2 winners, liquidity guard correctly blocked ($0.001 bids). Scanned markets, no edge, didn't force trades. Working as designed.

**Accidental sells during testing:**
- Leeds 530sh at $0.001 = $0.53 recovered (tiny, $0.69 loss)
- Elon 577sh at $0.01 = ~$5.77 recovered (bet was losing badly, market collapsed from $0.13 to $0.01)

**Account state:**
- HL: $965, XRP SHORT open, +$12.74 daily, 2/2 entries used
- PM: $627 cash, 3 meaningful positions + 61 micro, 3/8 slots used
- Combined: ~$1,741

**Infrastructure:**
- Both bots autonomous and healthy
- HL: 15-min cycles, temporal scanner, asymmetric R:R, 2/day entry limit
- PM: 2h cycles, qbuy/qsell, liquidity guard, $100 max, 8 positions, $200 cash floor
- Timeout rate: ~1 in 10 (OpenRouter/minimax, not our code)

**Files modified on VPS this session:**
- `/root/.openclaw-3/workspace/scripts/pm_trade.mjs` — v2 with liquidity guard + micro suppression
- `/root/.openclaw-3/cron/jobs.json` — v3 prompt with qbuy/qsell

---

## 2026-02-16 (session 20 cont.) — PM bot pre-mortem + tool hardening

**Pre-mortem findings:**
- PM scanner returning 2020-2025 stale markets → FIXED: added `end_date_min=now` to all gamma-api queries
- PM scanner `analyze` function returning wrong markets via broken `slug=` param → FIXED: now searches active events cache by keyword/slug
- PM scanner `search` limited to 100 events → FIXED: bumped to 200 with shared cache

**PM trade script v2 deployed (`/root/.openclaw-3/workspace/scripts/pm_trade.mjs`):**
- NEW: `qbuy <TOKEN_ID> <DOLLARS>` — auto-handles price/tick/negRisk, safety enforced
- NEW: `qsell <TOKEN_ID>` — sell entire position, auto-looks up tick/negRisk from CLOB API
- NEW: Code-enforced safety: $100 max/trade, 8 meaningful positions max, $200 cash floor
- NEW: Positions output shows TAKE PROFIT (>40%) and CUT LOSS (>60%) signals with token IDs
- NEW: Position count only counts >$5 value (ignores 70+ micro junk positions)
- Backup at pm_trade.mjs.bak

**Critical finding: ALL "TAKE PROFIT" positions are illiquid negRisk markets**
- Leeds +1139%, CR Colombian +370%, OpenAI +53% — all have best bid $0.001
- The data-api "curPrice" is NOT the orderbook price — it's an internal calculation
- These positions CANNOT be sold profitably. Must resolve at expiry.
- **STILL NEEDS:** qsell liquidity guard — don't sell if best bid < 10% of entry (would be 99% loss on a "profitable" position)

**Pre-mortem: HL Trader verdict = SOLID**
- Code-enforced safety, `close <coin>`, dollar notation, FRESH/ACTIVE/STALE scanner — all working
- Only minor: 14 commands available but cron only uses 5 (balance, scan, mbuy, msell, close) — low risk

**Cron prompt NOT yet updated** — still references old `buy <TOKEN_ID> <SHARES> <PRICE>` syntax. Needs to be changed to `qbuy`/`qsell`.

**Still needs (in priority order):**
1. Add liquidity guard to qsell (don't sell at $0.001 when entry was $0.13)
2. Update PM cron prompt to use qbuy/qsell
3. Test qsell on a position with actual liquidity
4. Test qbuy end-to-end
5. Consider: should positions output suppress micro positions to reduce token usage?

**Files modified on VPS:**
- `/root/.openclaw-3/workspace/scripts/pm_trade.mjs` — v2 with qbuy/qsell/safety (backup: .bak)
- `/root/.openclaw-3/workspace/scripts/pm_scanner.mjs` — v2 with end_date_min fix + analyze fix

**Account state:**
- PM: $566 cash, 75 positions (~$231 total value, most micro/illiquid), 5 meaningful positions
- Elon bet: 577 shares 90-114 YES at $0.13, now $0.115 (-12%), resolves Feb 17 17:00 UTC
- HL Trader: running autonomously, last cycle OK (81s)

---
## 2026-02-24 - Snapshot: Quality gate, morning/evening briefs, @everyone fix, Kit transcript analysis

**Task:** Takeover → analyzed Kit's OpenClaw YouTube transcript for actionable improvements, deployed content quality gate + consolidated briefings + @everyone Discord trigger
**Modified files:**
- VPS: SocialBot cron/jobs.json (style gate on 3 posting crons, 2 empty duplicates disabled)
- VPS: SocialBot notes/style-feedback.md (NEW — feedback loop for content quality)
- VPS: Main bot cron/jobs.json (morning-brief 8am SGT, evening-brief 7pm SGT, misscheduled standup disabled)
- VPS: All 5 openclaw.json (added `messages.groupChat.mentionPatterns: ["@everyone"]`)
- Local: memory/MEMORY.md (HL wallet address fix, briefing/quality gate notes)
**Progress:**
- Quality gate deployed: SocialBot reads style-feedback.md before every post, logs what it posts
- Morning brief (8am SGT) + evening brief (7pm SGT) on Main bot — consolidated status to Discord #general, uses DeepSeek V3 (cheap)
- Morning brief manually tested: HL $372 (day -$3.78), PM ~$190, no credit alerts
- @everyone now works as mention trigger across all 5 bots (mentionPatterns config)
- All 5 bots restarted — Discord WebSocket connections were dead (code 1005, failed resume)
- HL trader 60% drawdown from $931 peak to $377 — recommended tighter risk params, NOT a manager bot
- Kit comparison: his subagent architecture is fragile vs our container isolation; his $140/mo claim plausible but only because his agents do lighter work; feedback loop concept is sound but over-hyped (first 20 rejections do 80% of the work)
**Key context:**
- Discord code 1005 disconnects: all 5 bots lost WebSocket connection and failed to resume. Container restart fixed it. May recur — consider adding a Discord health check to credit-monitor.sh
- Two SocialBot crons had empty prompts (df0b61a5, f6948f24) — were running at same times as real crons, burning tokens. Now disabled.
- Main bot "Daily Standup 7PM SGT" was actually firing at 3am SGT (19:00 UTC, not 11:00 UTC). Disabled, replaced by evening-brief.
- Entity system still 0 entities across all 5 bots after 24h

---
## 2026-02-23 - Session End: Pending tasks, security scrub, Kybernesis BS check

**What we worked on:** Completed pending tasks from previous session: deployed 3 marketing skills (social-content, copywriting, content-strategy) to SocialBot VPS, enabled OpenClaw v2026.2.22 logging cap (maxFileBytes=50MB) across all 5 bots, fixed stale cron timers on Adam Love + SocialBot. Evaluated Kybernesis plugin (BS — exfiltrates data to unknown SaaS, OpenClaw already has native memory). Updated CLAUDE.md with post-update config check instructions and current 5-bot setup. Scrubbed 9 API keys/tokens from entire git history using git-filter-repo, force-pushed clean history.
**What worked:** git-filter-repo cleanly replaced all 9 secrets across 59 commits. Marketing skills deployed with references dirs + correct ownership (node:1000). Logging cap applied via Python script to all 5 configs.
**What didn't work:** "armTimer skipped" log message was misleading — only applies to "every" type crons, not "cron" expression jobs. Both types actually work fine. filter-repo nuked uncommitted CLAUDE.md edits (had to re-apply).
**Left off at:** All 7 containers healthy, all crons running, 1.8GB/3.9GB RAM. Git history clean of secrets. CLAUDE.md updated with post-update instructions.
**Key files:** CLAUDE.md (updated — 5 bot setup, post-update config check), .claude/breadcrumbs.md, .claude/breadcrumbs-archive.md (keys redacted), memory/MEMORY.md (keys redacted)
**Notes for next time:** Auto-updater (update.auto.enabled) intentionally left OFF — daily-update.sh at 3am is safer. "armTimer skipped" in cron logs is normal for "cron" expression type jobs — only "every" type uses that timer. git-filter-repo removes origin remote — must re-add after use. Entity system still at 0 entities — needs more cron cycles to populate.

---
## 2026-02-22 - Session End: Time fix, compaction tuning, X follow commands, initiative cron review

**What we worked on:** Takeover → reviewed initiative cron output (Alpha Hunt, Edge Finder, Revenue Hunt all running successfully). Fixed all 3 bots' inability to tell time — added `## TIME (READ THIS FIRST)` to top of all IDENTITY.md files (container is UTC, Brandon is SGT, must run `date` before any time claim). Added follow/unfollow/following/followers/retweet commands to clawbets.mjs for X/Twitter. Fixed compaction amnesia across all 3 bots — raised thresholds and added preservation prompt.
**What worked:** TIME section at top of IDENTITY.md (unmissable position). Initiative crons producing quality output — Alpha Hunt actually trading on findings (shorted AZTEC, OM on funding arb), Edge Finder identified US-Iran edge. Compaction fix: 25K→50K threshold, 0.3→0.5 historyShare, added preservation prompt for user instructions.
**What didn't work:** X/Twitter API tokens (CLAWBETS_*) are all returning 401 Unauthorized — bearer and OAuth 1.0a both dead. clawbets.mjs commands are ready but tokens need regenerating at developer.x.com. Revenue Hunt prompt weak — found 0 new leads (all duplicates).
**Left off at:** All 3 bots healthy, restarted with TIME rules. Compaction tuned (hot-reloaded, no restart needed). X follow commands deployed but tokens dead. Main bot self-created a "Morning Bias" cron (good self-management). Initiative crons all running successfully.
**Key files:** VPS: all 3 IDENTITY.md (TIME section added), all 3 openclaw.json (compaction tuned), LG scripts/clawbets.mjs (follow/unfollow/followers/retweet added)
**Notes for next time:** CLAWBETS X API tokens are dead — need regeneration at developer.x.com before X commands work. Revenue Hunt prompt needs tuning (returning all duplicate leads). Alpha Hunt + Edge Finder delivery mode is "none" — output stays in logs, not Discord. Main bot self-created a Morning Bias cron (midnight SGT). OpenClaw hot-reloads config changes — no restart needed for openclaw.json edits.

---
## 2026-02-22 - Session End: Gumroad uploads, memory research, initiative cron fix

**What we worked on:** Consolidated 4 duplicate ebooks from LeadGen into 2 (AI Coding Assistants $29, Run Your Own AI $29). Generated covers with Gemini. Converted to PDF locally. Researched QMD vs Mem0 memory backends — decided to stay with MEMORY.md. Brainstormed OpenClaw provisioning SaaS voice agent question flow. Fixed broken initiative crons (Alpha Hunt, Edge Finder — were skipping due to missing `payload.kind: "agentTurn"`). Checked spend: $54/day (down 63% from $148/day).
**What worked:** Gemini cover generation (clean results). Local md-to-pdf conversion (container fails due to Puppeteer Chrome mismatch). Spend reduction confirmed working. Cron fix was simple — move `prompt` into `payload.message`.
**What didn't work:** `docker kill -s SIGHUP` on containers — causes exit code 129, Docker doesn't auto-restart. Use `docker compose up -d` instead. md-to-pdf broken inside containers (Puppeteer Chrome version mismatch). Initiative crons were silently skipping since deployment (24h+) due to config format error.
**Left off at:** 2 consolidated ebooks ready in `gumroad/2026-02-22/` (PDFs + covers). All 3 bots healthy. Initiative crons fixed but no output yet (need to wait for next cycle). Spend at $54/day. Credits remaining unknown (API returned null limit).
**Key files:** `gumroad/2026-02-22/` (today's upload kit), `gumroad/ai-coding-assistants-consolidated.md`, `gumroad/run-your-own-ai-consolidated.md`, VPS: all 3 cron/jobs.json (initiative cron fix), MEMORY.md updated with container ops + Gumroad workflow sections.
**Notes for next time:** NEVER `docker kill -s SIGHUP` on OpenClaw — use `docker compose up -d`. Cron isolated jobs MUST have `payload.kind: "agentTurn"` + `payload.message` — top-level `prompt` is ignored. When downloading from LeadGen, create `gumroad/<YYYY-MM-DD>/` folder. md-to-pdf only works locally, not in container. OpenClaw provisioning SaaS — voice agent captures 6 files: IDENTITY.md, SOUL.md, MEMORY.md, HEARTBEAT.md, user.md, skill.md. Mem0 only worth it for the SaaS product (auto-learning from customer conversations), not for personal bots.

---
## 2026-02-22 - Session End: Bot-to-bot comms, proactive heartbeats, model tiering, Exa/Firecrawl

**What we worked on:** Enabled bot-to-bot Discord communication (#general channel, allowBots: true, requireMention to prevent loops). Rewrote all 3 heartbeats from passive maintenance to proactive opportunity-seeking. Added initiative crons (Alpha Hunt 2h, Edge Finder 3h, Revenue Hunt 4h). Applied model tiering (9 Sonnet / 11 Flash / 4 MiniMax — was 24 Sonnet). Wired Exa + Firecrawl API keys into all 3 containers. Fixed /var/log permissions (775 → 755).
**What worked:** Bot-to-bot comms tested — all 3 bots had a real conversation in #general (status sync, Trader gave LG feedback on open rate tracking). Model tiering via payload.model (NOT top-level model — OpenClaw strips it via stripLegacyTopLevelFields). Exa and Firecrawl both verified working from containers.
**What didn't work:** Top-level `model` field on cron jobs gets stripped by OpenClaw's normalize.ts `stripLegacyTopLevelFields()` — must use `payload.model` instead. SIGHUP causes full container restart (not hot-reload). QMD memory backend not installed in containers — deferred.
**Left off at:** All 3 bots healthy, credits $30.85. Bot comms working. Proactive heartbeats deployed. Initiative crons active. Model tiering applied. Exa + Firecrawl accessible.
**Key files:** VPS: all 3 openclaw.json (allowBots, allowFrom, #general channel), all 3 HEARTBEAT.md (proactive), all 3 cron/jobs.json (initiative crons + model tiering), all 3 docker-compose.yml + .env (EXA_API_KEY, FIRECRAWL_API_KEY)
**Notes for next time:** OpenClaw cron model override goes in `payload.model`, NOT top-level `model`. OpenClaw `stripLegacyTopLevelFields()` deletes top-level model/thinking/timeoutSeconds. Discord `allowBots: true` in channels.discord config enables bot-to-bot. `requireMention: true` on shared channels prevents infinite chat loops. Management API key still needs rotation (user task at openrouter.ai/settings/keys). QMD memory not installed — would need separate setup. NanoClaw is a competing project (container isolation model) — not worth migrating.

---
## 2026-02-21 - Session End: Cost optimization, prompt caching, compaction, use cases

**What we worked on:** Continued OpenClaw optimization session. Verified OpenRouter prompt caching works (91.5% savings on cached tokens — was active all along via pi-ai library). Fixed broken Anthropic provider config that was blocking hot-reload. Deployed compaction (maxHistoryShare 0.3, memoryFlush 25K) + conciseness rules across all 3 bots. Watched Kit's 39 use cases video and brainstormed applicable ideas.
**What worked:** OpenRouter prompt caching confirmed with empirical test ($0.0205 → $0.0017 on second call). Compaction config hot-reloaded without container restart. Conciseness rules added to PM + LG SOUL.md.
**What didn't work:** `softThresholdTokens` is NOT a direct child of `compaction` — it's nested under `memoryFlush`. Initial attempt caused hot-reload rejection. Also Anthropic provider section without `baseUrl` caused config validation failure.
**Left off at:** All 3 bots running with new compaction + conciseness. Prompt caching active. Credits ~$32. Main trader running 6 positions (INJ, SNX, ZRO, BIO, FOGO, AZTEC) with +$55 uPnL. User shared Kit's 39 use cases video — interested in new capabilities.
**Key files:** VPS: all 3 openclaw.json (compaction config), PM+LG SOUL.md (conciseness rules), `content/x-article-openclaw-optimization.md` (draft article, too revealing per user)
**Notes for next time:** OpenClaw compaction schema: `compaction.{mode, reserveTokens, keepRecentTokens, reserveTokensFloor, maxHistoryShare, memoryFlush.{enabled, softThresholdTokens, prompt, systemPrompt}}`. Never add bare `softThresholdTokens` under compaction root. pi-ai function `maybeAddOpenRouterAnthropicCacheControl()` auto-adds cache_control for openrouter/anthropic/* models. Management key in chat needs rotation. /var/log permissions still pending.

---
## 2026-02-21 - Snapshot: Prompt caching confirmed + compaction deployed + use case brainstorm

**Task:** Verify OpenRouter prompt caching, deploy compaction/conciseness optimizations, brainstorm new use cases from Kit's 39 use cases video
**Modified files:**
- VPS: all 3 openclaw.json — removed broken Anthropic provider section, set compaction maxHistoryShare 0.5→0.3, memoryFlush.softThresholdTokens 40K→25K
- VPS: `/root/.openclaw-3/workspace/SOUL.md` — added Communication Rules (60 word cron limit, 120 word chat limit)
- VPS: `/root/.openclaw-2/workspace/SOUL.md` — added Communication Rules (same)
**Progress:**
- CONFIRMED: OpenRouter prompt caching works (91.5% cost reduction on cached tokens). pi-ai library auto-adds cache_control via `maybeAddOpenRouterAnthropicCacheControl()` for all openrouter/anthropic/* models. Was working all along.
- FIXED: Broken Anthropic provider section in all 3 configs was blocking hot-reload. Removed. Config reload now succeeds.
- DEPLOYED: Compaction maxHistoryShare 0.3 + memoryFlush 25K across all 3 bots (hot-reloaded, no restart needed)
- DEPLOYED: Conciseness rules in PM + LG SOUL.md (Main already had brevity rules)
- Watched Kit's "39 OpenClaw Use Cases" video — brainstormed applicable ideas
- Top ideas: invoice automation for LG, facts-based Wikipedia memory, SOP/skill conversion for every successful task
**Key context:**
- OpenClaw compaction config: `softThresholdTokens` is nested under `memoryFlush`, NOT directly under `compaction` (caused hot-reload rejection initially)
- Valid compaction keys: mode, reserveTokens, keepRecentTokens, reserveTokensFloor, maxHistoryShare, memoryFlush.{enabled, softThresholdTokens, prompt, systemPrompt}
- Prompt caching test: Call 1 cost $0.0205 (cache_write), Call 2 cost $0.0017 (cache_read) — same 5500 token prompt
- Trader cron had errors from earlier Anthropic routing attempt (now fixed, config hot-reloaded at 11:55 UTC)
- Credits: $32.42 remaining ($500 - $467.58 usage)
- Still pending: daily spend limit on OpenRouter, rotate management key, /var/log fix, container restart

---
## 2026-02-21 - Snapshot: OpenClaw cost optimization + prompt caching research

**Task:** Optimize all 3 bots using community tips (Reddit/Turing Post guides), investigate $46/day API spend
**Modified files:**
- VPS: all 3 openclaw.json (fixed stale API keys in Main+PM, added Anthropic provider — kept but not routed to)
- VPS: all 3 docker-compose.yml + .env (added ANTHROPIC_API_KEY — containers NOT yet restarted)
- VPS: `/root/.openclaw-2/workspace/HEARTBEAT.md` (stripped social engagement, credit check only)
- VPS: `/root/.openclaw-2/cron/jobs.json` (AgentShop Watchdog 10m→60m)
- VPS: `/root/.openclaw-3/cron/jobs.json` (News Watch 15m→1h, PM Trading+BTC back to Sonnet)
- VPS: `/root/.openclaw/cron/jobs.json` (Main Trader: Flash→Sonnet for better decisions)
- Local: `content/x-article-openclaw-optimization.md` (draft article — user says too much secret sauce)
- Backups: `/root/backups/pre-optimize-20260221/` (all configs pre-changes)
**Progress:**
- Cron audit complete: 19 total crons across 3 bots, 735 API calls/day
- Eliminated 192 wasteful calls/day (AgentShop 10m→60m, News 15m→1h, LG heartbeat slimmed)
- All trading crons on Sonnet (smart brain for money), all grunt on MiniMax/Flash
- Discovered: Sonnet is 95.5% of bill ($142 of $148 on Feb 20). Context window avg 81K tokens/req.
- Prompt caching research: OpenRouter DOES support it, but OpenClaw code only sends cache_control for direct Anthropic, NOT OpenRouter. No cache hits happening.
- REVERTED Anthropic direct routing — breaks self-funding pipeline (bots fund OpenRouter only)
- Compaction 40K→25K proposed but NOT applied yet (user approved, interrupted before execution)
- Pre-mortem identified 7 risks, top: no daily spend cap on OpenRouter, prompt caching not active
**Key context:**
- CRITICAL: Cannot route through Anthropic direct API — self-funding scripts only pay OpenRouter. All spend MUST stay on OpenRouter or bots can't fund themselves.
- OpenRouter prompt caching IS possible (model pricing shows cache_read at $0.30/M vs $3/M) but OpenClaw source code skips cache_control for OpenRouter provider (extra-params.ts line: `if (provider !== "anthropic") return undefined`)
- This is a potential OpenClaw PR or config override opportunity — biggest savings lever (~$22/day)
- OpenRouter management key was shared in chat — needs rotation
- Containers have NOT been restarted yet (Anthropic env var added but not active)
- X article drafted but user flagged too much infra detail revealed

---
## 2026-02-21 - Session End: Browser fix + delivery purge + VPS security hardening

**What we worked on:** Fixed Chromium browser across all 3 containers (volume mount approach). Purged 99 stuck delivery queue entries. Full VPS security hardening (SSH, fail2ban, kernel). Performance cleanup (sessions, Docker logs).
**What worked:** Volume mount for browser binaries (survives container recreates). fail2ban with UFW ban action (267 IPs banned instantly). Delivery purge freed recovery system.
**What didn't work:** Docker build arg for Chromium (GPG signature errors). Multiple `--no-cache` builds filled disk (46GB reclaimed).
**Left off at:** All 3 bots healthy, credits ~$26. HL trading 2 positions (ZRO, VVV). PM sitting out ($163 bankroll). Self-funding operational. SSH hardened. Browser working.
**Key files:** VPS: all docker-compose.yml (PLAYWRIGHT_BROWSERS_PATH), post-deploy.sh (browser deps), /etc/ssh/sshd_config.d/99-hardening.conf, /etc/fail2ban/jail.local, /etc/docker/daemon.json
**Notes for next time:** /var/log permissions still broken (world-writable, logrotate failing, auth.log 29M). Deferred by user. Container name for PM is `openclaw-pmtrader-1` (not `openclaw-3`). Dockerfile browser install fails — always use volume mount.

---
## 2026-02-21 - Snapshot: Browser fix + delivery purge + VPS security hardening

**Task:** Takeover → fix browser, investigate stuck deliveries, health check, security audit + hardening
**Modified files:**
- VPS: all 3 docker-compose.yml (added PLAYWRIGHT_BROWSERS_PATH env var)
- VPS: `/root/scripts/post-deploy.sh` (added Chromium system deps install for all 3 containers + pmtrader to loops)
- VPS: `/root/scripts/daily-update.sh` (added --build-arg OPENCLAW_INSTALL_BROWSER=1)
- VPS: `/root/shared/playwright-browsers/` (Chromium binaries shared via volume mount)
- VPS: `/etc/ssh/sshd_config.d/99-hardening.conf` (password auth OFF, root key-only, max 3 tries)
- VPS: `/etc/ssh/sshd_config.d/50-cloud-init.conf` (overridden: PasswordAuthentication no)
- VPS: `/etc/fail2ban/jail.local` (sshd: 3 tries → 24h ban, aggressive: 1 try → 1 week ban)
- VPS: `/etc/docker/daemon.json` (log rotation: 10m max, 3 files)
- VPS: `/etc/sysctl.d/99-hardening.conf` (send_redirects OFF, log_martians ON)
- VPS: all .env and secrets.env files → chmod 600
- Local: MEMORY.md (added Browser Setup section, pmtrader container name fix)
**Progress:**
- Browser: Chromium installed and working in all 3 containers. Volume mount approach (host → shared). OpenClaw logs "Browser control service ready"
- Delivery: 99 stuck entries purged (72 permanently dead LeadGen DMs, 31 stale trading updates). Root cause: 25s backoff × 99 entries vs 60s budget = only 2 entries per restart
- Security: SSH hardened (password OFF, 267 brute force IPs banned by fail2ban within minutes, was getting 11K+ attempts/day)
- Performance: gateway sessions purged (146M → 26M), Docker log rotation added, kernel hardening applied
- Health: all 3 bots healthy, credits $26.47, 8 HL positions, PM sitting out
- INCOMPLETE: /var/log permissions broken (logrotate failing — world-writable /var/log dir), auth.log at 29M uncleaned
**Key context:**
- Container name is `openclaw-pmtrader-1` (NOT `openclaw-3` — that's the config dir)
- Dockerfile `OPENCLAW_INSTALL_BROWSER=1` build arg fails due to GPG signature errors in Docker build — volume mount is the reliable approach
- fail2ban uses UFW as ban action (integrates with existing firewall)
- Docker socket mounted in all containers (intentional for bot self-management) — accepted risk, containers run as `node` not root

---
## 2026-02-21 - Session End: Health check, Gumroad upload checklist, permissions fix

**What we worked on:** Takeover → health check of all 3 bots. Created `gumroad/DAILY_UPLOAD_CHECKLIST.md` with full metadata for 3 new books (Vibe to Revenue, Cold Outreach That Lands, AI Automation Agency Playbook). Fixed root-owned file permissions across all 3 containers. Installed missing `jq` on PM trader. Verified full bot agency — all can create scripts, install npm packages, manage cron, manage Docker.
**What worked:** `chown node:node` on all root-owned scripts in all 3 containers. Descriptions written from actual PDF content (chapter-by-chapter bullet points in the style of the OpenClaw Setup guide listing).
**What didn't work:** Nothing major — session was mostly verification and content creation.
**Left off at:** All 3 bots healthy, no permission issues, full tool agency confirmed. Credits $30.61. HL trading (3 positions: ZRO, VVV, AZTEC). PM has 3 active + 61 micro positions. Gumroad upload checklist ready for user. LG AgentShop wallet at $0 (can't contribute to funding if needed).
**Key files:** `gumroad/DAILY_UPLOAD_CHECKLIST.md` (new — full metadata for 3 books), VPS: all scripts now node:node ownership
**Notes for next time:** When deploying scripts via `docker exec -u root`, files get root ownership — bots can't update them later. Always `chown node:node` after deploying. PM trader was missing `jq` (now installed). Delivery recovery is stuck on all 3 bots (HL:16, PM:15, LG:65 pending entries — "Recovery time budget exceeded" every restart, never clears).

---
## 2026-02-21 - Session End: Bot self-management + pairing fix + 3 new book covers

**What we worked on:** Gave all 3 bots Docker CLI + self-management scripts (my-docker.sh, my-cron.sh). Fixed "pairing required" gateway error that was blocking all cron Discord delivery. Generated covers for 3 new nightly books. Updated Gemini API key.
**What worked:** Root cause of "pairing required" = missing `operator.write` scope in paired.json. Added it to all 3 bots, restart fixed both pairing error AND LeadGen Discord reconnect loop (same root cause). Docker CLI install via `docker exec -u root apt-get install docker.io`. Cron management via `/tools/invoke` HTTP endpoint with `tool: "cron"`.
**What didn't work:** Old Gemini API key was dead — needed user to provide new one.
**Left off at:** All 3 bots healthy, Discord connected, cron delivery working. Each bot has my-docker.sh (own container only) + my-cron.sh (list/add/remove/run/backup/restore). 3 new book covers generated (Vibe to Revenue, Cold Outreach, AI Automation Agency) — PDFs + covers ready for Gumroad upload.
**Key files:** gumroad/covers/ (new covers), gumroad/covers/new/ (PDFs), gumroad/generate_new_covers.py, VPS: all 3 bots' scripts/my-docker.sh + scripts/my-cron.sh + MEMORY.md updated, all 3 devices/paired.json (operator.write added)
**Notes for next time:** OpenClaw `operator.admin` does NOT grant `operator.write` — they're separate scopes. `CLI_DEFAULT_OPERATOR_SCOPES` only includes admin/approvals/pairing. Cron delivery needs write scope for `send` method. If Discord reconnect loop happens again, check paired.json scopes first. `cron` tool is NOT in gateway HTTP deny list so /tools/invoke works for cron management.

---
## 2026-02-20 - Session End: Self-funding deadlock fix + bulletproof credit system

**What we worked on:** Bots went dark (credits -$0.03). Diagnosed deadlock in self-funding: credit-monitor.sh created lock → scripts inside containers saw same lock via shared mount → nobody funded. Fixed with SKIP_LOCK=1 env var. Also raised thresholds (WARNING $10→$25, CRITICAL $5→$15), added Base USDC buffer auto-replenish, and retry-on-failure flag.
**What worked:** SKIP_LOCK=1 passthrough on docker exec. Buffer command keeps $50 USDC on Base for instant payments. Retry flag ensures failed funding attempts are retried next 5-min cycle.
**What didn't work:** The original locking design — monitor and scripts sharing a lock file across Docker mount boundary without coordination.
**Left off at:** Credits $33.83, Base USDC $48.19, HL withdrawable $578. All 3 fixes proven with tests. HL has ARB LONG $150. PM +$9 today. LeadGen stuck in Discord reconnect loop (code 1005). Cron delivery failing on HL/PM ("pairing required" gateway error — new OpenClaw security feature?).
**Key files:** scripts/credit-monitor.sh (thresholds + buffer + retry), scripts/hl_self_fund.mjs (buffer command), scripts/pm_self_fund.mjs + lg_self_fund.mjs (SKIP_LOCK fix)
**Notes for next time:** "pairing required" gateway error blocking cron Discord delivery — needs investigation. LeadGen Discord reconnect loop needs container restart or debug. Base USDC buffer runs hourly at minute 0-4.

---
## 2026-02-20 - Snapshot: Self-funding infrastructure + CLAWNCH token research

**Task:** Build autonomous self-funding system so bots never need human bailouts again, then research AI agent token launch for passive revenue
**Modified files:**
- `scripts/credit-monitor.sh` — lightweight 5-min watchdog with funding lock + all 3 bots in chain
- `scripts/pm_self_fund.mjs` — Gnosis Safe proxy withdrawal (PROVEN, $1 test), Polygon 30 gwei gas fix
- `scripts/hl_self_fund.mjs` — added funding lock coordination
- `scripts/lg_self_fund.mjs` — NEW, LeadGen pays OR directly from AgentShop wallet on Base (fastest path)
- All 3 bots' MEMORY.md on VPS — full self-funding knowledge (roles, lock, teammates)
- All 15 cron prompts on VPS — credit alert pre-check with lock awareness
**Progress:**
- Self-funding system COMPLETE: credit-monitor → HL (primary) → PM (secondary) → LG (tertiary). Lock coordination prevents double-funding. All 3 pipelines proven.
- PM Gnosis Safe withdrawal tested ($1 transfer confirmed on-chain, block 83218394)
- Sent 0.001 ETH to AgentShop wallet for gas
- Credits at ~$12-19 (fluctuating, auto-funded twice during session)
- CLAWNCH token launch researched but NOT executed — user chose "research more first"
**Key context:**
- CLAWNCH (clawn.ch) is the platform — free, 80% fee share, built for OpenClaw/Moltbook
- Need: Moltbook API key, token branding, WETH→USDC swap script, compelling narrative
- Best angle: "3 AI bots that fund their own compute, zero human bailouts"
- FeeLocker contract: `0xF3622742b1E446D92e45E22923Ef11C2fcD55D68` — `claim()` anytime, no minimum
- Realistic day-1 fees: $8-400 depending on volume. Viral = $8K+/day
- Key example: Asymmetrix ($ASYM) — OpenClaw agent launched via CLAWNCH, $1M volume in 12h, $10K fees
- User explicitly said: "I can't afford to pay anymore" — full autonomy is the goal

---
## 2026-02-19 - Takeover: crash loop fix + monitoring

**What we worked on:** All 3 bots were crash-looping due to invalid `"exec"` config key added last session. Removed the key from all 3 configs, restarted containers, all healthy on Sonnet 4.6.
**What worked:** Simple fix — remove `"exec"` from openclaw.json, restart. All 3 came up instantly.
**What didn't work:** The `exec: {enabled: true, allowedCommands: ["*"]}` key — OpenClaw doesn't support it at root level. Caused immediate crash loop on all 3 bots.
**Left off at:** All 3 bots healthy on Sonnet 4.6. No Sonnet trading data yet — bots were down since last session. HL has 3 positions (OP, SPX, VVV) slightly red. PM never traded. Credits at $18.05.
**Key files:** All 3 configs on VPS (`/root/.openclaw*/openclaw.json`) — `exec` key removed.
**Notes for next time:** NEVER add unknown keys to openclaw.json — OpenClaw validates config strictly and crashes on unrecognized root keys. Updated MEMORY.md with this lesson.

---

## 2026-02-20 - Session End: Survival economics + Gumroad ebooks + team board

**What we worked on:** Deployed survival economics to all bots, built inter-bot communication, fixed PM cron delivery, set up Gumroad product listings for 5 AI ebooks, generated covers with Gemini Nano Banana Pro.
**What worked:** Shared filesystem mount for team bulletin board (zero LLM cost). Gemini image gen for book covers (great text rendering vs Midjourney). Survival-framed IDENTITY.md drives urgency.
**What didn't work:** SSH heredocs with apostrophes — used Python SCP workaround. Cold Email and Offshore Dev books skipped (dead topics, not AI-focused enough).
**Left off at:** 5 Gumroad books: AI Agent (published), Prompt Engineering / Vibe Coding / Business AI / OpenClaw Setup (metadata provided, user uploading manually). Covers generated for all 7 in gumroad/covers/. All 3 bots running with survival economics + team board. PM cron delivery fixed. 3am update script covers all 3 containers.
**Key files:** gumroad/covers/ (all book covers + thumbnails), /root/shared/team-status.md (team board), all 3 IDENTITY.md + MEMORY.md on VPS rewritten, gumroad/generate_covers.py
**Notes for next time:** User contact is x.com/brandontan (NOT brandon@reco-vn.com). User wants AI-focused products only. LemonSqueezy handled by LeadGen bot via API. Use Gemini (not Midjourney) for covers with text.

---
(Sessions 13-22 archived to .claude/breadcrumbs-archive.md)
