---
name: x-integration
description: Read, post, and engage with X (Twitter) via your real Chromium-based browser. Triggers on "setup x", "x integration", "twitter", "post tweet", "tweet", "dm", "export bookmarks".
---

# X (Twitter) Integration

MCP tools that automate every common X action through *your real browser* (Chrome, Brave, or Chromium — whichever you have installed). Drives the user's logged-in profile so X's bot detection sees a normal session. Channel-agnostic: works with whatever channel adapter you have wired (Signal, Discord, Slack, etc.).

> **Compatibility:** NanoClaw v2. Cross-platform: macOS and Linux.
>
> **Delete safety:** `x_delete_tweet` requires the caller to pass a substring of the tweet body as `text_must_match`. The host script reads the live tweet first and refuses to delete unless the substring is present — guards against URL hallucinations and copy-paste mistakes without adding an approval gate.

## Tool catalog

### Read (8)
| Tool | Args | What it does |
|------|------|--------------|
| `x_read_tweet` | `tweet_url` | Fetch a single tweet (text, author, timestamp, image alt-text, engagement counts). The "what do you think of this link" workflow. |
| `x_read_thread` | `tweet_url`, `limit?` | Tweet plus its replies. For summarizing discussions. |
| `x_read_user` | `handle`, `limit?` | A user's recent tweets. "What's @foo been saying lately." |
| `x_read_bookmarks` | `limit?` (≤100), `cursor?` | Your bookmarked tweets, newest first. To walk full history, chain calls: pass back the `NEXT_CURSOR` value emitted in each response as `cursor` until no more cursor returned. Higher cap than other read tools (100 vs 50) because each paginated call re-scrolls past prior items. |
| `x_read_list` | `list_url`, `limit?` | Tweets in any X list. "What's on Robert Scoble's AI list." |
| `x_read_timeline` | `limit?` | Your home timeline (For You / Following). |
| `x_read_notifications` | `limit?` | Your mentions/replies feed. |
| `x_search` | `query`, `latest?`, `limit?` | Search X for tweets. |

### Compose (3) — with optional media + native scheduling
| Tool | Args | What it does |
|------|------|--------------|
| `x_post` | `content`, `media?[]`, `schedule_at?` | Post a tweet. Optionally attach up to 4 images. Optionally `schedule_at` (ISO 8601 with timezone) — uses X's native scheduler so the tweet sits in X's queue regardless of NanoClaw uptime. |
| `x_reply` | `tweet_url`, `content`, `media?[]`, `schedule_at?` | Reply to a tweet. Same media + schedule support. |
| `x_quote` | `tweet_url`, `comment`, `media?[]`, `schedule_at?` | Quote-tweet with a comment. Same media + schedule support. |

### Engagement (9) — toggles + delete
| Tool | Args |
|------|------|
| `x_like` / `x_unlike` | `tweet_url` |
| `x_retweet` / `x_unretweet` | `tweet_url` |
| `x_bookmark` / `x_unbookmark` | `tweet_url` |
| `x_follow` / `x_unfollow` | `handle` |
| `x_delete_tweet` | `tweet_url`, `text_must_match` (≥5-char substring of tweet body — safety guard) |

### Scheduling queue (2)
| Tool | Args | What it does |
|------|------|--------------|
| `x_list_scheduled` | — | List your pending scheduled tweets in X's queue. |
| `x_cancel_scheduled` | `index?` or `text_match?` | Cancel a scheduled tweet. Pass the 1-based index from `x_list_scheduled` or a substring of the body. |

### DMs (3)
| Tool | Args | What it does |
|------|------|--------------|
| `x_read_dm_inbox` | `limit?` | List of DM conversations (handles, unread state, last-message preview). Does **not** mark anything read. |
| `x_read_dm_thread` | `handle`, `limit?` | Messages in one DM conversation. **CAVEAT:** opens the thread, which marks unread messages as read on X. Unavoidable. Don't call casually on threads with unread context the user wants to see fresh. |
| `x_send_dm` | `handle`, `content` | Send a DM to a single user. |

### Bulk export (1)
| Tool | Args | What it does |
|------|------|--------------|
| `x_export_bookmarks` | `reset?` | Resumable bulk-dump of all bookmarks to CSV at `/workspace/group/captures/bookmarks.csv`. Each call scrolls for ~75 seconds (well under the 120s host script timeout) and appends new rows; a sidecar `.progress.json` file records the last exported tweet ID. For users with thousands of bookmarks, the agent calls this in a loop until the response says "End of bookmarks reached." Pass `reset=true` to truncate the CSV and start fresh. CSV columns: `id, url, author_handle, author_name, timestamp, text, image_alt_texts, likes, retweets, replies, is_reply, is_retweet`. RFC 4180 quoting. |

## How it works

| Layer | Where | What |
|-------|-------|------|
| Container MCP tool | `container/agent-runner/src/mcp-tools/x-integration.ts` | Each tool writes a `kind:'system'` row to `messages_out` with `{ action, requestId, ...args }` and returns immediately ("submitted; result will arrive shortly"). |
| Host delivery action | `src/modules/x-integration/index.ts` | `registerDeliveryAction('x_*', …)` for 24 actions. Each handler routes through `pacedRun()` (a single host-process Promise chain that enforces a **10-second floor between any two X actions** — protects the account from anti-spam tripping). Then spawns the matching `scripts/<name>.ts` via `tsx`, awaits exit, calls `notifyAgent(session, result)` to write the outcome back into `inbound.db` (which also wakes the container). |
| Browser scripts | `.claude/skills/x-integration/scripts/<name>.ts` | Playwright + your persistent browser profile at `data/x-browser-profile/`. Reads JSON from stdin, writes a `ScriptResult` JSON line to stdout. |
| DOM glue | `lib/locators.ts`, `lib/extract.ts` | Every CSS / data-testid selector AND every tweet/profile/DM parser is centralized. When X breaks something, *that's* the only place to update. |

The agent UX is async: one "submitted" reply, then a follow-up message ~10–60s later with the result. This is the v2 idiom (no sync request-response on system actions).

## Prerequisites

1. **A Chromium-based browser** on the host. Bundled Chromium does **not** work — X bot-detection blocks it.
   - **Linux:** `command -v google-chrome-stable google-chrome chromium-browser chromium brave-browser` should return a path. If not:
     - Chrome: `sudo apt install google-chrome-stable`
     - Brave: add the Brave repo, then `sudo apt install brave-browser`
     - Chromium: `sudo apt install chromium-browser`
   - **macOS:** `mdfind "kMDItemCFBundleIdentifier == 'com.google.Chrome'" | head -1` (or `com.brave.Browser` for Brave). If not, install from <https://www.google.com/chrome/> or <https://brave.com/download/>.
   - **Pin a specific browser:** `CHROME_PATH=/usr/bin/brave-browser` in `.env` overrides auto-detection.
2. **Desktop session** for the one-time interactive login (`DISPLAY=:1` or similar). Truly headless servers: run setup on a workstation and rsync `data/x-browser-profile/` to the server.
3. **NanoClaw v2** with the host running and channel adapter wired.

## Install

All paths relative to NanoClaw repo root.

### 1. Verify a browser

```bash
# Linux
command -v google-chrome-stable google-chrome chromium-browser chromium brave-browser

# macOS
mdfind "kMDItemCFBundleIdentifier == 'com.google.Chrome'" | head -1
mdfind "kMDItemCFBundleIdentifier == 'com.brave.Browser'" | head -1
```

### 2. Install host dep

The skill uses `playwright-core` (not `playwright`) — we point `executablePath` at your real browser, so the bundled-browser auto-download is wasted bandwidth.

Pin a version that's at least 3 days old (NanoClaw's pnpm policy: `minimumReleaseAge: 4320`):

```bash
pnpm view playwright-core time | tail -10
# Pick a version stamped ≥3 days ago, then:
pnpm add playwright-core@<that-version>
```

### 3. Install the container MCP tool

```bash
cp .claude/skills/x-integration/agent.ts \
   container/agent-runner/src/mcp-tools/x-integration.ts

grep -q "x-integration" container/agent-runner/src/mcp-tools/index.ts \
  || sed -i.bak "/^import { startMcpServer }/i\\
import './x-integration.js';" container/agent-runner/src/mcp-tools/index.ts \
  && rm -f container/agent-runner/src/mcp-tools/index.ts.bak
```

`/app/src` is bind-mounted RO from `container/agent-runner/src/`, so this file goes live on the next session spawn — no Docker rebuild.

### 4. Install the host module

```bash
mkdir -p src/modules/x-integration
cp .claude/skills/x-integration/host.ts src/modules/x-integration/index.ts

grep -q "x-integration" src/modules/index.ts \
  || echo "import './x-integration/index.js';" >> src/modules/index.ts
```

### 5. Run interactive login (one-time)

Opens your browser on the desktop. Log in to X. Return to terminal, press Enter. Session saves to `data/x-browser-profile/`.

```bash
pnpm exec tsx --env-file=.env .claude/skills/x-integration/scripts/setup.ts
```

Verify:

```bash
test -f data/x-auth.json && echo "logged in" || echo "run setup again"
```

### 6. Build the host

```bash
pnpm run build
```

### 7. Restart the service

```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Usage examples

Address your assistant by name (`ASSISTANT_NAME` in `.env`):

```
What's in my bookmarks lately?
What do you think of https://x.com/karpathy/status/<id>?
Summarize this thread: https://x.com/<user>/status/<id>
What's @scoble been posting on AI?
Search X for "noumenon" — top 10.

Post a tweet: gm. Sovereignty is a daily practice.
Reply to https://x.com/<id> with: this matches my experience.
Like https://x.com/<id>
Bookmark https://x.com/<id>
Follow @karpathy

Schedule this for tomorrow 9am PT: <text>
What scheduled tweets do I have?
Cancel scheduled tweet #2.

What DMs are in my inbox?
Read my DM thread with @<friend>.
DM @<friend>: thanks for the link earlier.
```

Each command produces (a) one acknowledgment from the agent, (b) a follow-up with the result ~10–60s later.

## Pacing

The host serializes all X actions through a 10-second-minimum mutex. If the agent fires "like 5 tweets in a row," they'll execute sequentially with at least 10s between each — which keeps your account well below X's anti-spam thresholds. Knob lives at `lib/config.ts`'s `pacing.actionDelayMs`; raise it if you ever start seeing X warnings.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| "No Chromium-family browser found" | None installed | Install Chrome / Brave / Chromium (see Prerequisites). |
| "X login expired" in result | Session aged out / X forced re-auth | Re-run setup; no service restart needed. |
| Tool returns "submitted" but no follow-up | Host delivery action not registered | Check `src/modules/index.ts` has `import './x-integration/index.js';`, ran `pnpm run build`, restarted. |
| MCP tool not visible to agent | Container barrel not updated | Check `container/agent-runner/src/mcp-tools/index.ts` has the import; kill the agent's container — next user message respawns on new source. |
| `SingletonLock` errors | Stale browser-profile lock | Auto-cleaned next run; if persistent: `rm data/x-browser-profile/Singleton*` |
| Setup hangs at "Press Enter when logged in" | `DISPLAY` unset / no GUI | Run setup on a workstation, rsync `data/x-browser-profile/` to server. |
| One specific tool returns "Could not find X" | X UI changed and that selector broke | Check `logs/x-failures/` for screenshot + DOM snapshot; update the relevant entry in `lib/locators.ts`. The selectors most likely to break first: scheduling, DM compose, scheduled-tweets queue. |
| Bot-detection warnings on the account | Pacing too tight (shouldn't happen at 10s) | Raise `pacing.actionDelayMs` in `lib/config.ts` to 20000 or 30000; rebuild + restart. |

Logs:

```bash
grep -i "x-integration\|x_post\|x_like\|x_read\|x_send_dm" logs/nanoclaw.log | tail -30
ls -la logs/x-failures/   # screenshots + DOM dumps from script failures
```

## Privacy

DMs are sensitive. Three protections shipped:

- `x_send_dm` / `x_read_dm_inbox` / `x_read_dm_thread` log only the action + requestId, **not** message bodies, into `nanoclaw.log`.
- `x_read_dm_inbox` does not open individual threads — read receipts only fire on `x_read_dm_thread`.
- `x_read_dm_thread`'s tool description tells the agent that opening a thread marks unread messages as read; the agent should not call it casually.

## Configuration

| Knob | Where | Default |
|------|-------|---------|
| `CHROME_PATH` | `.env` | Auto-detected (CHROME_PATH override > Chrome > Brave > Chromium). Pin to force a specific browser. |
| Browser profile dir | `lib/config.ts` `browserDataDir` | `data/x-browser-profile/` |
| Auth marker file | `lib/config.ts` `authPath` | `data/x-auth.json` |
| Tweet char limit | `lib/config.ts` `limits.tweetMaxLength` | 280 |
| DM char limit | `lib/config.ts` `limits.dmMaxLength` | 10000 |
| Read result cap | `lib/config.ts` `limits.readMax` | 50 |
| Media per tweet | `lib/config.ts` `limits.mediaMaxPerTweet` | 4 |
| **Action pacing** | `lib/config.ts` `pacing.actionDelayMs` | **10000 (10s)** |
| Per-action timeout | `host.ts` `SCRIPT_TIMEOUT_MS` | 120s |
| Failure dump dir | `lib/config.ts` `failureDumpDir` | `logs/x-failures/` |

## File map

```
.claude/skills/x-integration/
├── SKILL.md                  # this file
├── agent.ts                  # template → container/agent-runner/src/mcp-tools/x-integration.ts
├── host.ts                   # template → src/modules/x-integration/index.ts
├── lib/
│   ├── chrome-detect.ts      # CHROME_PATH > Chrome > Brave > Chromium > throw
│   ├── config.ts             # config object (limits, pacing, paths)
│   ├── browser.ts            # Playwright wrappers, ensureLoggedIn, captureFailure, runScript harness
│   ├── locators.ts           # ALL CSS / data-testid selectors (single source of truth)
│   └── extract.ts            # parseTweetCard, collectTweets, DM parsers, renderers
└── scripts/
    ├── setup.ts              # one-time interactive login
    ├── read-tweet.ts         # x_read_tweet
    ├── read-thread.ts        # x_read_thread
    ├── read-user.ts          # x_read_user
    ├── read-bookmarks.ts     # x_read_bookmarks
    ├── read-list.ts          # x_read_list
    ├── read-timeline.ts      # x_read_timeline
    ├── read-notifications.ts # x_read_notifications
    ├── search.ts             # x_search
    ├── post.ts               # x_post (media + schedule)
    ├── reply.ts              # x_reply (media + schedule)
    ├── quote.ts              # x_quote (media + schedule)
    ├── like.ts               # x_like
    ├── unlike.ts             # x_unlike
    ├── retweet.ts            # x_retweet
    ├── unretweet.ts          # x_unretweet
    ├── bookmark.ts           # x_bookmark
    ├── unbookmark.ts         # x_unbookmark
    ├── follow.ts             # x_follow
    ├── unfollow.ts           # x_unfollow
    ├── delete-tweet.ts       # x_delete_tweet (text-echo safety guard)
    ├── list-scheduled.ts     # x_list_scheduled
    ├── cancel-scheduled.ts   # x_cancel_scheduled
    ├── read-dm-inbox.ts      # x_read_dm_inbox
    ├── read-dm-thread.ts     # x_read_dm_thread
    └── send-dm.ts            # x_send_dm
```

## Security

- `data/x-browser-profile/` and `data/x-auth.json` are gitignored — session cookies never enter version control.
- `x_delete_tweet` is the only irreversible action with a built-in safety guard: the caller must pass a substring of the tweet body as `text_must_match`, and the host script reads the live tweet to verify the substring is present before clicking delete. This catches URL hallucinations and copy-paste mistakes without adding an approval round-trip.
- DM bodies are redacted from `nanoclaw.log`.
- Posting / liking / following / deleting are not approval-gated. If you want admin approval gating per action, model it as a separate skill that wraps these tools — don't add an approval flag here.
- The MCP tools ship via the runner once installed, so all agent groups see them. Finer-grained per-group gating is a future addition.
