---
name: linkedin-automation
description: Full LinkedIn automation for NanoClaw. Automates every human action on LinkedIn — profile visits, connection requests, messaging, reactions, comments, shares, follows, skill endorsements, lead scraping, and outreach campaigns. Stores leads in Notion. Triggers on "linkedin", "connect on linkedin", "scrape leads", "send linkedin message", "run linkedin campaign", "like linkedin post".
---

# LinkedIn Automation

Full browser automation for LinkedIn via Playwright. Covers every action a human can do on LinkedIn, with Notion as the lead database and built-in safety limits to protect your account.

> **Compatibility:** NanoClaw v1.0.0. Modeled after x-integration skill pattern.

---

## Features

| Tool | Action | Description |
|------|--------|-------------|
| `li_visit_profile` | Profile Visit | Visit a LinkedIn profile (adds to their views) |
| `li_connect` | Connection Request | Send a connection request with optional note |
| `li_withdraw_request` | Withdraw Request | Withdraw a pending connection request |
| `li_message` | Direct Message | Send a message to a 1st-degree connection |
| `li_follow` | Follow | Follow a person or company page |
| `li_unfollow` | Unfollow | Unfollow a person or company |
| `li_like_post` | Like Post | Like a LinkedIn post |
| `li_react_post` | React to Post | React with Like/Celebrate/Support/Funny/Love/Insightful/Curious |
| `li_comment_post` | Comment on Post | Comment on a LinkedIn post |
| `li_share_post` | Share/Repost | Share a post with optional commentary |
| `li_endorse_skill` | Endorse Skill | Endorse a skill on someone's profile |
| `li_scrape_search` | Scrape Search | Scrape profiles from LinkedIn search results → save to Notion |
| `li_scrape_profile` | Scrape Profile | Extract full data from a single profile → save to Notion |
| `li_scrape_post_engagers` | Scrape Engagers | Extract people who liked/commented on a post → save to Notion |
| `li_run_campaign` | Run Campaign | Automated sequence: Visit → Connect → Message for a list of leads |
| `li_bulk_message` | Bulk Message | Send a personalized message to multiple connections |
| `li_get_campaign_stats` | Campaign Stats | Get status of leads and outreach from Notion |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Container (Linux VM)                                               │
│  └── ipc-mcp-stdio.ts → inline LinkedIn MCP tools                  │
│      (li_visit_profile, li_connect, li_message, etc.)              │
│      └── writeLiIpcFile() → /workspace/ipc/tasks/{id}.json         │
│      └── waitForLiResult() ← /workspace/ipc/li_results/{id}.json   │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ IPC (shared volume, file system)
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Host (macOS/Linux)                                                 │
│  └── src/ipc.ts → processTaskIpc()                                 │
│      └── src/ipc-linkedin.ts → handleLinkedInIpc()                 │
│          └── spawn: npx dotenv -- npx tsx scripts/*.ts              │
│              └── Playwright → Chrome (real profile) → LinkedIn      │
│              └── lib/notion.ts → Notion API                         │
│          └── writes result → data/ipc/{group}/li_results/{id}.json │
└─────────────────────────────────────────────────────────────────────┘
```

### Why This Design?

- **LinkedIn blocks headless browsers** — must reuse the user's real Chrome profile with real fingerprint
- **LinkedIn has strict rate limits** — safety caps and human-like delays are built in
- **One-time login** — user logs in manually once, session persists in Chrome profile
- **Notion as CRM** — all leads, status, and outreach history stored in a Notion database
- **Tools inline in container** — LinkedIn MCP tools live directly in `ipc-mcp-stdio.ts` alongside other tools, no separate agent.ts module required
- **Host handler in `src/`** — `ipc-linkedin.ts` is a standalone file in the main NanoClaw source, imported by `ipc.ts`

---

## File Structure

```
.claude/skills/linkedin-automation/
├── SKILL.md                    # This file (skill installation guide)
├── host.ts                     # Original host IPC handler (reference copy)
├── lib/
│   ├── config.ts               # Centralized configuration + safety limits
│   ├── browser.ts              # Playwright shared utilities
│   └── notion.ts               # Notion API client + lead database helpers
└── scripts/
    ├── setup.ts                # Interactive LinkedIn login (run once)
    ├── visit-profile.ts        # Visit a profile
    ├── send-connection.ts      # Send connection request
    ├── withdraw-request.ts     # Withdraw pending request
    ├── send-message.ts         # Send DM to connection
    ├── follow.ts               # Follow person or company
    ├── unfollow.ts             # Unfollow person or company
    ├── like-post.ts            # Like a post
    ├── react-post.ts           # React with specific reaction
    ├── comment-post.ts         # Comment on a post
    ├── share-post.ts           # Share/repost
    ├── endorse-skill.ts        # Endorse a skill
    ├── scrape-search.ts        # Scrape LinkedIn search results
    ├── scrape-profile.ts       # Scrape a single profile
    ├── scrape-post-engagers.ts # Scrape likers/commenters from a post
    ├── run-campaign.ts         # Run full outreach campaign
    ├── bulk-message.ts         # Send bulk messages to connections
    └── get-campaign-stats.ts   # Fetch lead stats from Notion

# Files installed into the main NanoClaw source:
src/ipc-linkedin.ts             # Host-side IPC handler (imported by src/ipc.ts)
container/skills/linkedin/
└── SKILL.md                    # Container-agent-facing skill (Bash IPC helpers)

# LinkedIn MCP tools added inline to:
container/agent-runner/src/ipc-mcp-stdio.ts
```

---

## Prerequisites

1. **NanoClaw running** — Telegram/WhatsApp connected, service active
2. **Chrome installed** — real Chrome (not Chromium) for fingerprint safety
3. **Playwright installed:**
   ```bash
   npm ls playwright dotenv-cli || npm install playwright dotenv-cli
   ```
4. **Notion account** — create a Leads database (schema below)
5. **Environment variables** set in `.env`

---

## Environment Variables

Add to `.env` in your project root:

```bash
# Chrome path (required)
CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome

# LinkedIn credentials (used for initial login setup only — stored in browser profile after)
LINKEDIN_EMAIL=your@email.com
LINKEDIN_PASSWORD=yourpassword

# Notion integration
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxx
NOTION_LEADS_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Safety limits (optional — these are the recommended defaults)
LI_MAX_CONNECTIONS_PER_DAY=25
LI_MAX_MESSAGES_PER_DAY=40
LI_MAX_PROFILE_VIEWS_PER_DAY=80
LI_MIN_DELAY_MS=3000
LI_MAX_DELAY_MS=9000
```

---

## Notion Leads Database Schema

Create a Notion database named *LinkedIn Leads* with these properties:

| Property | Type | Description |
|----------|------|-------------|
| `Name` | Title | Full name |
| `Profile URL` | URL | LinkedIn profile URL |
| `Title` | Text | Current job title |
| `Company` | Text | Current company |
| `Location` | Text | City/Country |
| `Email` | Email | Email if publicly visible |
| `About` | Text | Profile summary/about section |
| `Source` | Select | Where they were found (Search/Post/Group/Manual) |
| `Status` | Select | `New` / `Visited` / `Requested` / `Connected` / `Messaged` / `Replied` / `Archived` |
| `Connection Date` | Date | When they accepted the connection |
| `Last Action` | Date | Date of most recent action |
| `Notes` | Text | Custom notes |
| `Message Sent` | Text | Copy of the outreach message sent |
| `Campaign` | Text | Campaign name/tag this lead belongs to |

After creating the database, copy the database ID from the URL:
`https://notion.so/YOUR_WORKSPACE/XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX?v=...`
The ID is the 32-character hex string before `?v=`.

---

## Configuration (`lib/config.ts`)

```typescript
import path from 'path';

const ROOT = process.env.NANOCLAW_ROOT || process.cwd();

export const config = {
  // Chrome / browser
  chromePath: process.env.CHROME_PATH ||
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  browserDataDir: path.join(ROOT, 'data/li-browser-profile'),
  authPath: path.join(ROOT, 'data/li-auth.json'),

  // Browser settings
  viewport: { width: 1280, height: 900 },
  chromeArgs: ['--no-first-run', '--no-default-browser-check'],
  chromeIgnoreDefaultArgs: ['--enable-automation'],

  // Safety limits (per day)
  limits: {
    maxConnectionsPerDay: parseInt(process.env.LI_MAX_CONNECTIONS_PER_DAY || '25'),
    maxMessagesPerDay:    parseInt(process.env.LI_MAX_MESSAGES_PER_DAY || '40'),
    maxProfileViewsPerDay: parseInt(process.env.LI_MAX_PROFILE_VIEWS_PER_DAY || '80'),
  },

  // Human-like delays (milliseconds)
  delays: {
    minMs: parseInt(process.env.LI_MIN_DELAY_MS || '3000'),
    maxMs: parseInt(process.env.LI_MAX_DELAY_MS || '9000'),
    afterPageLoad: 2500,
    afterClick: 1500,
    afterType: 800,
    betweenActions: 4000,
  },

  // Timeouts
  timeouts: {
    navigation: 30000,
    elementWait: 8000,
    scriptMax: 180000,  // 3 minutes max per script
  },

  // Notion
  notion: {
    apiKey: process.env.NOTION_API_KEY || '',
    leadsDatabaseId: process.env.NOTION_LEADS_DB_ID || '',
  },

  // LinkedIn URLs
  urls: {
    base: 'https://www.linkedin.com',
    feed: 'https://www.linkedin.com/feed/',
    search: 'https://www.linkedin.com/search/results/people/',
    messaging: 'https://www.linkedin.com/messaging/',
  },
};
```

---

## Setup

### Step 1 — Install dependencies

```bash
npm ls playwright dotenv-cli @notionhq/client || \
  npm install playwright dotenv-cli @notionhq/client
```

### Step 2 — Configure environment

```bash
# Add required vars to .env
cat >> .env << 'EOF'
CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
LINKEDIN_EMAIL=your@email.com
LINKEDIN_PASSWORD=yourpassword
NOTION_API_KEY=secret_xxxxxxxxxxxxxxxxxxxx
NOTION_LEADS_DB_ID=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
EOF
```

### Step 3 — Login to LinkedIn (one-time)

```bash
npx dotenv -e .env -- npx tsx .claude/skills/linkedin-automation/scripts/setup.ts
```

This opens Chrome and logs you in to LinkedIn. Your session is saved to `data/li-browser-profile/`.

**Verify:**
```bash
cat data/li-auth.json  # Should show {"authenticated": true, "email": "..."}
```

### Step 4 — Build NanoClaw

```bash
npm run build
```

### Step 5 — Rebuild container

The LinkedIn MCP tools are inline in `ipc-mcp-stdio.ts`, so a container rebuild is required:

```bash
./container/build.sh
```

### Step 6 — Restart service

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

### Step 7 — Verify with unit tests

Run the full test suite. All tests must pass before the skill is considered set up:

```bash
npm test
```

Expected: all tests pass (including `send-connection.test.ts`, `send-message.test.ts`, `scrape-search.test.ts`, `notion.test.ts`).

### Step 8 — Verify with live tests

Run the live integration test to confirm real Notion and LinkedIn connectivity:

```bash
cd /path/to/nanoclaw
npx dotenv -e .env -- npx tsx .claude/skills/linkedin-automation/live-test.ts
```

This runs four tiers automatically:
- **Tier 1** — Notion CRUD (direct API calls, no browser)
- **Tier 2** — LinkedIn scripts against Notion (no browser)
- **Tier 3** — Read-only LinkedIn browser scraping
- **Tier 4** — Interactive button verification (prompts for a profile URL)

Tier 4 verifies the exact selectors that are most likely to break when LinkedIn updates its UI (connect button visibility, modal flow, message button). You will be asked to provide a LinkedIn profile URL and confirm each action before it runs.

To skip Tier 4 prompts (scripted re-runs):
```bash
LIVE_TEST_PROFILE=https://www.linkedin.com/in/<not-yet-connected> \
LIVE_TEST_CONNECTED_PROFILE=https://www.linkedin.com/in/<1st-degree-connection> \
npx dotenv -e .env -- npx tsx .claude/skills/linkedin-automation/live-test.ts
```

Tiers 1–2 must fully pass. Tier 3 requires a working LinkedIn session. Tier 4 is optional but strongly recommended after any LinkedIn UI change or selector update.

---

## Integration Points

### 1. Host side: `src/ipc-linkedin.ts` + `src/ipc.ts`

Create `src/ipc-linkedin.ts` (standalone file — see `host.ts` in this skill for the implementation).
Then add the import to `src/ipc.ts`:

```typescript
import { handleLinkedInIpc } from './ipc-linkedin.js';
```

In `processTaskIpc` switch statement default case:
```typescript
default: {
  const handledByLI = await handleLinkedInIpc(
    data as { type: string; requestId: string; [key: string]: unknown },
    sourceGroup,
    isMain,
    DATA_DIR,
  );
  if (!handledByLI) {
    logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
```

### 2. Container side: `container/agent-runner/src/ipc-mcp-stdio.ts`

LinkedIn MCP tools are defined **inline** in `ipc-mcp-stdio.ts`. No separate module import is used.

Add the IPC path constants near the top (alongside existing `TASKS_DIR`):
```typescript
const LI_RESULTS_DIR = path.join(IPC_DIR, 'li_results');
```

Add three helper functions (`writeLiIpcFile`, `waitForLiResult`, `makeLiId`, `liDispatch`) and then
register each `server.tool(...)` call for all LinkedIn tools (`li_visit_profile`, `li_connect`,
`li_message`, `li_follow`, `li_unfollow`, `li_like_post`, `li_react_post`, `li_comment_post`,
`li_share_post`, `li_endorse_skill`, `li_scrape_search`, `li_scrape_profile`,
`li_scrape_post_engagers`, `li_run_campaign`, `li_bulk_message`, `li_get_campaign_stats`).

All tools check `if (!isMain) return liMainOnly;` to restrict usage to the main group.

### 3. Container agent skill: `container/skills/linkedin/SKILL.md`

Add a Bash-helper skill file for the container agent. This gives the agent a `/linkedin` skill with
`li_run()` helper and per-action Bash snippets (IPC task dispatch + result polling).

### 4. Dockerfile: no changes needed

The full `agent-runner/` directory is already copied into the image. No additional COPY steps are required for LinkedIn.

---

## Usage via Telegram

```
@Andy visit linkedin profile https://linkedin.com/in/johndoe

@Andy send a connection request to https://linkedin.com/in/johndoe with note "Hi John, I'd love to connect!"

@Andy message https://linkedin.com/in/johndoe: "Hey, great connecting with you!"

@Andy like this linkedin post https://www.linkedin.com/posts/xyz-123

@Andy comment on https://www.linkedin.com/posts/xyz-123: "Great insights!"

@Andy react to https://www.linkedin.com/posts/xyz-123 with "insightful"

@Andy follow https://linkedin.com/in/johndoe

@Andy scrape linkedin search for "Head of Growth SaaS London" and save 50 leads to Notion

@Andy scrape profile https://linkedin.com/in/johndoe

@Andy scrape people who liked https://www.linkedin.com/posts/xyz-123

@Andy run a linkedin campaign: visit and connect with all New leads in Notion with message "Hi {name}, I noticed..."

@Andy bulk message all Connected leads in Notion: "Hi {name}, just wanted to share..."

@Andy show me linkedin campaign stats
```

---

## Safety Guidelines

LinkedIn aggressively detects and restricts automated accounts. Always respect these limits:

| Action | Safe Daily Limit | Hard Max |
|--------|-----------------|----------|
| Profile views | 80 | 100 |
| Connection requests | 25 | 30 |
| Messages | 40 | 60 |
| Post likes | 50 | 80 |
| Comments | 20 | 30 |
| Follows | 30 | 50 |

Additional safeguards built into the skill:
- Random delays between every action (3–9 seconds by default)
- Campaign runs are automatically spread out (no burst actions)
- Daily counters tracked in `data/li-daily-limits.json`
- `run-campaign.ts` automatically stops when any daily limit is reached
- Session runs only during business hours by default (configurable)

---

## `lib/notion.ts` — Key Functions

The Notion library provides these helpers used by the scripts:

```typescript
// Add or update a lead in the Notion database
upsertLead(lead: LinkedInLead): Promise<void>

// Update only the status of an existing lead
updateLeadStatus(profileUrl: string, status: LeadStatus): Promise<void>

// Get all leads with a given status
getLeadsByStatus(status: LeadStatus): Promise<LinkedInLead[]>

// Log an action taken on a lead (updates Last Action + Notes)
logAction(profileUrl: string, action: string): Promise<void>

// Get today's action counts (for safety limit checking)
getTodayCounts(): Promise<DailyCounts>
```

**LeadStatus values:** `New` | `Visited` | `Requested` | `Connected` | `Messaged` | `Replied` | `Archived`

---

## Key Selectors (LinkedIn UI)

LinkedIn updates their UI frequently. Current working selectors (as of 2026-03):

| Element | Selector | Notes |
|---------|----------|-------|
| Connect button | `:is(button, a)[aria-label*="connect" i]` | **Matches both `<button>` and `<a>`** (LinkedIn A/B test). Case-insensitive. Always append `:visible`. |
| Follow button | `:is(button, a)[aria-label*="Follow"]` | Append `:visible` — LinkedIn renders hidden duplicates of all profile-card buttons |
| Unfollow button | `:is(button, a)[aria-label*="Unfollow"], :is(button, a)[aria-label*="Following"]` | Same hidden-duplicate issue |
| Message button | `:is(button[aria-label*="Message"], a[href*="messaging/compose"])` | **Matches both `<button>` and `<a>`**. Append `:visible`. |
| Pending/Withdraw | `:is(button, a)[aria-label*="Pending"], :is(button, a)[aria-label*="Withdraw"]` | Append `:visible` |
| Add note (modal) | `button[aria-label="Add a note"]` | Appears in connect modal and custom-invite page |
| Send note field | `textarea[name="message"]` | Inside connect modal. **Not present on custom-invite page** until "Add a note" is clicked. |
| Send with note | `button[aria-label="Send invitation"]` | **Only appears after clicking "Add a note"** — not present in the no-note flow |
| Send without note | `button[aria-label="Send without a note"]` | Always present in connect modal and custom-invite page; use this for no-note path |
| Message compose | `div.msg-form__contenteditable` | |
| Message send | `button.msg-form__send-button` | |
| Like button | `button[aria-label*="Like"][aria-pressed="false"]` | |
| Reaction menu | `div.reactions-menu` | |
| Comment box | `div.comments-comment-box__form div[contenteditable]` | |
| Profile name | `h1` | |
| Profile title | `div.text-body-medium` | |
| Search results | `[data-chameleon-result-urn]` | Primary selector; fallbacks in `scrape-search.ts` |
| Post engagers list | `div.social-details-reactors-tab-body-list` | |

> **Critical: Hidden DOM duplicates.** LinkedIn renders hidden DOM duplicates of profile-card action buttons. Always use `:visible` in Playwright locators (e.g. `page.locator('button[aria-label*="connect" i]:visible')`). Without `:visible`, `.first()` picks a hidden element, `isVisible()` returns false, and the script silently reports "button not found". The unit tests in `send-connection.test.ts` and `send-message.test.ts` specifically guard against this regression.

> **Critical: SVG overlay on `<a>` action buttons (2026-03).** LinkedIn A/B tests profile-card action buttons — some profiles render Connect as `<a href="/preload/custom-invite/...">` and Message as `<a href="/messaging/compose/...">` instead of `<button>`. These `<a>` elements have a floating SVG overlay `<div class="_15abd600">` that intercepts all pointer events, making Playwright `.click()` (even with `force: true`) ineffective. **Workaround:** Detect the `<a>` tag via `el.evaluate(el => el.tagName)`, extract the `href`, and navigate directly with `page.goto()`. `dispatchEvent(new MouseEvent(...))` does NOT work — LinkedIn's JS ignores untrusted events (`isTrusted: false`). See `send-connection.ts` and `send-message.ts` for the implementation.

> **Note: Premium paywall for custom invite notes.** Free LinkedIn accounts have a monthly limit on personalized connection notes. When exhausted, clicking "Add a note" on the `/preload/custom-invite/` page shows a Premium upsell dialog instead of a textarea. Dismissing the dialog destroys the entire invite UI (all buttons gone). Recovery: dismiss → re-navigate to the custom-invite URL → click "Send without a note". See `handleCustomInvitePage()` in `send-connection.ts`.

> **Note: Other LinkedIn Premium paywalls.**
> - **InMail (messaging non-connections):** Clicking "Message" on a 2nd/3rd-degree profile opens an InMail compose that requires Premium credits. Our scripts only message 1st-degree connections (they check for the visible Message button, which is hidden for non-connections), so this is naturally avoided.
> - **Profile view limits:** Free accounts can see a limited number of profiles before LinkedIn gates access with a Premium upsell. The `maxProfileViewsPerDay` limit (default 80) keeps well under LinkedIn's threshold.
> - **Endorsement limits:** LinkedIn occasionally restricts rapid endorsements, but does not gate them behind Premium. No paywall handling needed.
> - **Post interactions (like, comment, share, react):** Not paywalled. No Premium handling needed.

> **Note: Timeout strategy.** All scripts use centralized timeouts from `config.timeouts`:
> - `elementWait` (8000ms) — primary action buttons (Connect, Message, Follow, Like, etc.)
> - `secondaryWait` (5000ms) — fallback menus (More actions), confirm dialogs, optional elements
> - `navigation` (30000ms) — page loads via `page.goto()`
>
> No hardcoded timeout values in scripts. Adjust via config or environment variables if LinkedIn is slow on your network.

---

## Troubleshooting

### LinkedIn session expired

```bash
# Delete old profile and re-authenticate
rm -rf data/li-browser-profile data/li-auth.json
npx dotenv -e .env -- npx tsx .claude/skills/linkedin-automation/scripts/setup.ts
```

### Hit daily limit

```bash
# View current daily counts
cat data/li-daily-limits.json

# Reset (only if truly a new day)
echo '{}' > data/li-daily-limits.json
```

### Chrome lock files

```bash
rm -f data/li-browser-profile/SingletonLock
rm -f data/li-browser-profile/SingletonSocket
rm -f data/li-browser-profile/SingletonCookie
```

### Check logs

```bash
grep -i "linkedin\|li_connect\|li_message\|handleLinkedIn" logs/nanoclaw.log | tail -30
grep -i "error\|failed\|limit" logs/nanoclaw.log | tail -20
```

### Notion sync failing

```bash
# Test Notion connection directly
npx dotenv -e .env -- node -e "
const { Client } = require('@notionhq/client');
const n = new Client({ auth: process.env.NOTION_API_KEY });
n.databases.retrieve({ database_id: process.env.NOTION_LEADS_DB_ID })
  .then(r => console.log('✓ Notion connected:', r.title[0]?.plain_text))
  .catch(e => console.error('✗ Notion error:', e.message));
"
```

### Selectors broken after LinkedIn UI update

1. Run unit tests first — they verify selector contract without touching LinkedIn:
   ```bash
   npm test
   ```
2. Run live tests to confirm end-to-end (Tier 4 specifically exercises each button selector):
   ```bash
   npx dotenv -e .env -- npx tsx .claude/skills/linkedin-automation/live-test.ts
   ```
3. If a selector is broken, open DevTools on a live profile to find the new one, then update `lib/config.ts` (the `selectors` object). All scripts import selectors from config — one change fixes everything.
4. Re-run `npm test` after updating — the unit tests in `send-connection.test.ts` and `send-message.test.ts` will catch common regressions (missing `:visible`, wrong modal button, case-sensitive matching).

---

## Data Directories

| Path | Purpose | Git |
|------|---------|-----|
| `data/li-browser-profile/` | Chrome profile with LinkedIn session | Ignored |
| `data/li-auth.json` | Auth state marker | Ignored |
| `data/li-daily-limits.json` | Daily action counter | Ignored |
| `data/ipc/{group}/li_results/` | Host writes script results here; container polls here | Ignored |
| `logs/nanoclaw.log` | Service logs | Ignored |

---

## Security Notes

- `data/li-browser-profile/` contains your LinkedIn session cookies — never commit this
- `LINKEDIN_EMAIL` and `LINKEDIN_PASSWORD` are only used during initial setup — never logged
- All scripts run as isolated subprocesses
- Only the main Telegram group can use LinkedIn tools (enforced in `agent.ts` and `host.ts`)
- Notion API key is stored in `.env` — never committed
