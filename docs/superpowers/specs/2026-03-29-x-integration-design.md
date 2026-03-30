# X/Twitter Integration Redesign

**Date:** 2026-03-29
**Status:** Draft
**Repos:** nanoclaw, bearclaw-platform

## Overview

Replace nanoclaw's Playwright-based X/Twitter browser automation with a direct API integration using the official X TypeScript SDK (`@xdevplatform/xdk`). Add autonomous timeline monitoring with Claude-driven engagement decisions, a reusable core approval mechanism for write actions, and a generic social monitor framework that future platform integrations can plug into.

## Background

The existing X integration skill uses Playwright to automate Chrome on the host machine. This approach is fragile (UI selector changes break it), requires the user's Chrome profile, and cannot run inside containers. The X API has moved to usage-based pricing, eliminating the cost barrier that motivated browser automation. X now provides an official TypeScript SDK and CLI (`xurl`) that support OAuth 2.0 — matching bearclaw-platform's existing auth flow.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Container (Linux VM)                                           │
│  ├── container/skills/social-monitor/   (generic framework)     │
│  │   └── fetch → filter → decide (Claude) → act                │
│  ├── container/skills/x-integration/    (X-specific)            │
│  │   ├── XDK client (via OneCLI proxy)                          │
│  │   ├── SocialMonitor implementation                           │
│  │   └── MCP tools (x_post, x_like, x_reply, etc.)             │
│  └── request_approval MCP tool (core)                           │
│      └── Writes approval request to IPC                         │
└──────────────────────┬──────────────────────────────────────────┘
                       │ IPC (file system)
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  Host (macOS/Linux)                                             │
│  ├── src/approval.ts      (approval store, notifications)       │
│  ├── src/ipc.ts           (request_approval handler)            │
│  └── Channel routers      (approval responses from messaging)   │
│      └── WebSocket event → bearclaw-platform                    │
└──────────────────────┬──────────────────────────────────────────┘
                       │ WebSocket (existing gateway)
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  bearclaw-platform                                              │
│  ├── Approval API endpoints                                     │
│  ├── engagement_actions table (Postgres)                        │
│  ├── pending_approvals table (Postgres)                         │
│  └── OAuth 2.0 token management + OneCLI vault sync             │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Agent calls X API directly from container** via OneCLI proxy injection — no host-side IPC round-trip for X actions.
- **Official X SDK** (`@xdevplatform/xdk`) instead of unofficial libraries — no ToS risk, maintained by X, zero dependencies.
- **OAuth 2.0 only** — bearclaw-platform's existing flow covers all needed scopes (`tweet.read`, `tweet.write`, `like.write`, `users.read`, `offline.access`). OAuth 1.0a is not required.
- **Generic approval mechanism** — built as nanoclaw core, reusable by any future skill.
- **Generic social monitor framework** — platform-specific skills implement the `SocialMonitor` interface.
- **Engagement data syncs to platform** — container SQLite is working cache; Postgres is source of truth for UI.

---

## Deliverable 1: Core Approval Mechanism

### IPC Protocol

New IPC task type `request_approval` (container → host):

```json
{
  "type": "request_approval",
  "requestId": "apr-1234",
  "category": "x_post",
  "action": "post",
  "summary": "Post tweet: 'Excited to announce our new API...'",
  "details": { "content": "...", "replyTo": null },
  "expiresAt": "2026-03-29T12:00:00Z",
  "groupFolder": "main"
}
```

Approval result (host → container via IPC results):

```json
{
  "requestId": "apr-1234",
  "approved": true,
  "respondedBy": "whatsapp:matthew",
  "respondedAt": "2026-03-29T11:45:00Z"
}
```

### Approval Policy

Per-group configuration at `groups/{name}/approval-policy.json`:

```json
{
  "defaults": { "mode": "confirm" },
  "actions": {
    "x_like": { "mode": "auto" },
    "x_retweet": { "mode": "auto" },
    "x_post": { "mode": "confirm" },
    "x_reply": { "mode": "confirm" },
    "x_quote": { "mode": "confirm" }
  },
  "notifyChannels": ["whatsapp", "telegram"],
  "expiryMinutes": 60
}
```

Modes:
- `auto` — execute immediately, no approval needed
- `confirm` — require human approval before executing
- `block` — never allow

### Approval Flow

1. Container agent calls `request_approval` MCP tool.
2. Host reads `approval-policy.json` for the group.
3. If `auto` → immediately write approved result to IPC.
4. If `confirm` → store pending approval in SQLite, send notification to configured channels ("Approve this post? Reply YES/NO"), push `approval.created` WebSocket event to platform.
5. If `block` → immediately write rejected result to IPC.
6. Agent polls for result using existing `waitForResult` pattern.
7. On approval → agent proceeds. On rejection/expiry → agent reports to user.

### Approval Response Sources

- **Messaging channels**: user replies YES/NO to the approval notification in WhatsApp/Telegram/Discord. Host detects approval response and writes IPC result.
- **Platform UI**: user clicks approve/reject in bearclaw-platform web UI. Platform calls `approval.respond` WebSocket method → nanoclaw host writes IPC result.

### Host Components

- `src/approval.ts` — new module:
  - SQLite store for pending approvals (id, category, action, summary, details, status, expires_at, responded_by, responded_at)
  - `createApproval()` — store and notify
  - `resolveApproval()` — mark approved/rejected, write IPC result
  - `expireStaleApprovals()` — periodic cleanup
  - `notifyChannels()` — send approval request to configured messaging channels
- `src/ipc.ts` — new `request_approval` case in `processTaskIpc`
- Channel message handlers — detect YES/NO replies to approval messages

---

## Deliverable 2: Social Monitor Framework

### Interface

Platform-specific skills register a monitor:

```typescript
interface MonitorContext {
  groupFolder: string;
  personaPath: string;       // path to x-persona.md (or platform equivalent)
  approvalPolicyPath: string;
  dryRun: boolean;
}

interface SocialMonitor {
  platform: string;
  fetchTimeline(ctx: MonitorContext): Promise<TimelineItem[]>;
  formatForDecision(items: TimelineItem[]): string;
  executeAction(action: EngagementAction): Promise<ActionResult>;
  bootstrapPersona?(ctx: MonitorContext): Promise<PersonaDraft>;
}

interface PersonaDraft {
  content: string;       // Generated x-persona.md content
  sourceStats: {
    postsAnalyzed: number;
    likesAnalyzed: number;
    dateRange: { from: string; to: string };
  };
}

interface TimelineItem {
  id: string;
  author: { handle: string; name: string; followers?: number };
  content: string;
  createdAt: string;
  metrics?: { likes: number; replies: number; reposts: number };
  url: string;
}

interface EngagementAction {
  type: string;        // "like", "reply", "repost", "quote"
  targetId: string;
  content?: string;    // for reply/quote
  approvalMode: string;
}

interface ActionResult {
  success: boolean;
  platformId?: string;
  url?: string;
  error?: string;
  dryRun?: boolean;
}
```

### Pipeline

1. **Fetch** — monitor calls platform API, returns `TimelineItem[]`.
2. **Filter** — deduplicates against `seen_items` SQLite store. Removes already-processed items.
3. **Decide** — builds prompt combining:
   - Persona file (`groups/{name}/x-persona.md`)
   - Filtered timeline items (via `formatForDecision`)
   - Structured output instructions (return JSON array of `EngagementAction`)
   - Claude decides: ignore, like, reply, repost, or quote for each item.
4. **Act** — for each action:
   - Check approval policy → `auto` executes immediately, `confirm` calls `request_approval` and waits, `block` skips.
   - Record result in engagement log.
5. **Sync** — at end of cycle, send `engagement.sync` IPC message with batch of completed actions. Host forwards to platform via WebSocket.

### Scheduling

Uses nanoclaw's existing `schedule_task` mechanism:

```json
{
  "type": "schedule_task",
  "name": "x-timeline-monitor",
  "schedule": { "interval": 900000 },
  "prompt": "[SYSTEM] Run timeline monitoring cycle for X.",
  "context": "isolated"
}
```

Agent wakes, runs monitoring pipeline, exits. Configurable interval.

### Deduplication Store

SQLite table in group folder (`groups/{name}/seen_items.db`):

| Column | Type | Purpose |
|---|---|---|
| `item_id` | TEXT PK | Platform item ID |
| `platform` | TEXT | "x", "linkedin", etc. |
| `seen_at` | DATETIME | When first seen |
| `action_taken` | TEXT NULL | "liked", "replied", "ignored", etc. |

TTL: 7 days. Pruned on each run.

### Engagement Log

SQLite table in group folder (`groups/{name}/engagement_log.db`):

| Column | Type | Purpose |
|---|---|---|
| `id` | TEXT PK | UUID |
| `platform` | TEXT | "x" |
| `action_type` | TEXT | "like", "reply", "post", "retweet", "quote" |
| `target_id` | TEXT | Tweet/post ID |
| `target_url` | TEXT | URL of target item |
| `target_author` | TEXT | Author handle |
| `target_content` | TEXT | Content of target (for context) |
| `content` | TEXT NULL | Our reply/quote content |
| `approval_id` | TEXT NULL | Links to approval if confirm mode |
| `status` | TEXT | "executed", "rejected", "expired", "failed" |
| `triggered_by` | TEXT | "monitor" or "command" |
| `created_at` | DATETIME | When decided |
| `executed_at` | DATETIME NULL | When performed |

### Container Skill Structure

```
container/skills/social-monitor/
├── SKILL.md
├── framework.ts          # Pipeline orchestrator
├── interfaces.ts         # SocialMonitor, TimelineItem, etc.
├── dedup.ts              # Seen items store
├── engagement-log.ts     # Audit trail
└── decision-prompt.ts    # Builds Claude decision prompt
```

---

## Deliverable 3: X Integration Skill

### Container Skill Structure

```
container/skills/x-integration/
├── SKILL.md
├── monitor.ts            # Implements SocialMonitor for X
├── client.ts             # XDK client wrapper
├── actions.ts            # Post, like, reply, retweet, quote
├── setup.ts              # Persona bootstrapping from account history
└── tools.ts              # MCP tool definitions for command-driven usage
```

### XDK Client

```typescript
import { Client } from '@xdevplatform/xdk';

const client = new Client({
  baseUrl: process.env.TWITTER_API_BASE_URL  // OneCLI proxy URL
});
```

Container never holds credentials. OneCLI proxy intercepts outbound requests to `api.twitter.com` and injects the OAuth 2.0 bearer token.

### SocialMonitor Implementation

- **`fetchTimeline`** — `GET /2/users/:id/timelines/reverse_chronological` with author info and metrics.
- **`formatForDecision`** — renders tweets as numbered list (handle, content, metrics, URL). Token-efficient.
- **`executeAction`** — dispatches to `actions.ts`.

### Actions

Verified against X OpenAPI spec (`x-openapi.json`) and official SDK samples (`@xdevplatform/xdk` v0.5.0):

| Action | SDK Method | X API Endpoint | Scopes |
|---|---|---|---|
| Post | `client.posts.create({ text })` | `POST /2/tweets` | `tweet.read`, `tweet.write`, `users.read` |
| Reply | `client.posts.create({ text, reply: { in_reply_to_tweet_id } })` | `POST /2/tweets` | `tweet.read`, `tweet.write`, `users.read` |
| Quote | `client.posts.create({ text, quote_tweet_id })` | `POST /2/tweets` | `tweet.read`, `tweet.write`, `users.read` |
| Retweet | `client.users.repostPost(userId, { body: { tweet_id } })` | `POST /2/users/{id}/retweets` | `tweet.read`, `tweet.write`, `users.read` |
| Like | `client.users.likePost(userId, { body: { tweet_id } })` | `POST /2/users/{id}/likes` | `tweet.read`, `like.write`, `users.read` |
| Search | `client.posts.searchRecent(query, opts)` | `GET /2/tweets/search/recent` | `tweet.read`, `users.read` |
| Timeline | `client.users.getTimeline(userId)` | `GET /2/users/{id}/timelines/reverse_chronological` | `tweet.read`, `users.read` |
| User tweets | `client.users.getPosts(userId)` | `GET /2/users/{id}/tweets` | `tweet.read`, `users.read` |
| Liked tweets | `client.users.getLikedPosts(userId)` | `GET /2/users/{id}/liked_tweets` | `tweet.read`, `like.read`, `users.read` |
| Get me | `client.users.getMe()` | `GET /2/users/me` | `tweet.read`, `users.read` |

Reference: `~/code/bearclaw/x-openapi.json`, `github.com/xdevplatform/samples/javascript/`

### MCP Tools

Registered for direct user commands via messaging:

- `x_setup` — bootstrap persona from account history (read-only, generates draft persona)
- `x_post` — post a tweet (approval policy checked)
- `x_like` — like a tweet (default: auto)
- `x_reply` — reply to a tweet (approval policy checked)
- `x_retweet` — retweet (default: auto)
- `x_quote` — quote tweet (approval policy checked)
- `x_search` — search tweets (read-only, no approval)
- `x_timeline` — fetch recent timeline (read-only)

### Persona Bootstrapping

The `x_setup` tool generates a draft persona by analyzing the user's recent X activity:

1. Fetches last 200 tweets via `GET /2/users/:id/tweets` (with `tweet.fields=public_metrics,created_at,referenced_tweets`)
2. Fetches recent likes via `GET /2/users/:id/liked_tweets`
3. Feeds both to Claude: "Analyze this user's posting voice, topics, engagement patterns, and style. Generate an x-persona.md following the template below."
4. Writes the draft to `groups/{name}/x-persona.md`
5. Sends the draft to the user via messaging for review

The user can:
- Edit `x-persona.md` at any time — manual edits always take precedence
- Re-run `x_setup` to regenerate from fresh history (overwrites only with confirmation)
- Write the persona entirely from scratch without running setup

The `bootstrapPersona` method on the `SocialMonitor` interface makes this pattern available to future platform integrations (LinkedIn, Bluesky, etc.) — each can pull platform-specific history and generate a persona draft.

### Persona Configuration

`groups/{name}/x-persona.md`:

```markdown
# X Persona

## Identity
Technical founder building developer tools. Casual, informed, occasionally witty.

## Engage Rules
### Always Engage
- @handles: @anthropic, @verabornn
- Topics: AI agents, developer tools, TypeScript

### Never Engage
- Topics: politics, controversy, crypto scams
- Accounts: bots, engagement-bait accounts

### Style
- Replies: thoughtful, add value, 1-2 sentences
- Likes: generous with good technical content
- Quotes: only when adding meaningful commentary

## Content Guidelines
- Voice: first person, conversational
- Promote: product launches, technical insights, community wins
- Avoid: negative commentary, complaints, hot takes

## Goals
- Grow developer audience
- Establish thought leadership in AI agents space
- Drive traffic to blog and docs
```

### DRY_RUN Mode

Environment variable `X_DRY_RUN=true`:
- All write actions logged but not executed
- Timeline fetching works normally
- Approval flow still triggers (for testing full pipeline)
- Actions return `{ success: true, dryRun: true, wouldHavePosted: "..." }`

---

## bearclaw-platform Changes

### OAuth Scope Update

Add `like.write` to scope request in `social.go`:

**Current:** `tweet.read`, `tweet.write`, `users.read`, `offline.access`
**New:** `tweet.read`, `tweet.write`, `like.read`, `like.write`, `users.read`, `offline.access`

Note: `like.read` is required for persona bootstrapping (fetching user's liked tweets). `like.write` is required for liking tweets.

Existing connected accounts must reconnect to pick up the new scope.

### OneCLI Policy Rules

Update `twitter_api.go` integration registry:

```go
PolicyRules: []PolicyRule{
    {Name: "twitter-read",    PathPattern: "/2/*",               Method: "GET",  Action: "rate_limit", RateLimit: 2000, RateLimitWindow: "hour"},
    {Name: "twitter-write",   PathPattern: "/2/tweets",          Method: "POST", Action: "rate_limit", RateLimit: 10,   RateLimitWindow: "hour"},
    {Name: "twitter-like",    PathPattern: "/2/users/*/likes",   Method: "POST", Action: "rate_limit", RateLimit: 50,   RateLimitWindow: "hour"},
    {Name: "twitter-retweet", PathPattern: "/2/users/*/retweets",Method: "POST", Action: "rate_limit", RateLimit: 50,   RateLimitWindow: "hour"},
    {Name: "twitter-delete",  PathPattern: "/2/tweets/*",        Method: "DELETE",Action: "rate_limit", RateLimit: 5,    RateLimitWindow: "hour"},
}
```

### Approval API Endpoints

- `GET /api/v1/instances/{id}/approvals` — list pending approvals (filterable by status, category)
- `GET /api/v1/instances/{id}/approvals/{approvalId}` — get approval details
- `PATCH /api/v1/instances/{id}/approvals/{approvalId}` — approve or reject (`{ "approved": true }`)

### New Postgres Tables

**`pending_approvals`:**

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | Matches `requestId` from IPC |
| `instance_id` | UUID FK | Tenant |
| `category` | TEXT | "x_post", "x_reply", etc. |
| `action` | TEXT | "post", "reply", "quote" |
| `summary` | TEXT | Human-readable description |
| `details` | JSONB | Full action payload |
| `status` | TEXT | "pending", "approved", "rejected", "expired" |
| `expires_at` | TIMESTAMPTZ | |
| `responded_by` | TEXT NULL | "platform:matthew", "whatsapp:matthew" |
| `responded_at` | TIMESTAMPTZ NULL | |
| `created_at` | TIMESTAMPTZ | |

**`engagement_actions`:**

| Column | Type | Purpose |
|---|---|---|
| `id` | UUID PK | |
| `instance_id` | UUID FK | Tenant |
| `platform` | TEXT | "x", "linkedin" |
| `action_type` | TEXT | "like", "reply", "post", "retweet", "quote" |
| `target_id` | TEXT | Platform item ID acted on |
| `target_url` | TEXT | URL of target item |
| `target_author` | TEXT | Author handle |
| `target_content` | TEXT | Content of target (for context) |
| `content` | TEXT NULL | Our reply/quote content |
| `approval_id` | UUID NULL | FK to pending_approvals |
| `status` | TEXT | "executed", "rejected", "expired", "failed" |
| `triggered_by` | TEXT | "monitor" or "command" |
| `created_at` | TIMESTAMPTZ | |
| `executed_at` | TIMESTAMPTZ NULL | |

### WebSocket Events

**`engagement.sync`** (nanoclaw → platform): batch of completed engagement actions, inserted into `engagement_actions` table.

**`approval.created`** (nanoclaw → platform): new pending approval, inserted into `pending_approvals` table.

**`approval.respond`** (platform → nanoclaw): approval/rejection from platform UI, delivered to nanoclaw host which writes IPC result.

---

## Migration: Existing X Skill

### Removed
- `.claude/skills/x-integration/host.ts` — host-side IPC handler
- `.claude/skills/x-integration/scripts/` — all Playwright scripts
- `.claude/skills/x-integration/lib/browser.ts` — Playwright utilities
- `.claude/skills/x-integration/agent.ts` — old MCP tools using IPC
- `data/x-browser-profile/` — Chrome session data
- `data/x-auth.json` — auth state marker
- `handleXIpc` import and call in `src/ipc.ts`

### Replaced
- Old Playwright MCP tools → new XDK-based container MCP tools
- Old Chrome profile auth → OAuth 2.0 via platform UI + OneCLI vault
- Old host-side script execution → direct container-to-API calls

### New Setup Flow
1. Connect X account via bearclaw-platform UI (OAuth 2.0 with `like.write` scope).
2. Platform stores encrypted tokens, pushes to OneCLI vault.
3. Run `x_setup` to bootstrap persona from account history → generates draft `x-persona.md` → user reviews and edits. (Or write `x-persona.md` manually from scratch.)
4. Optionally customize `approval-policy.json` (sensible defaults provided).
5. Schedule timeline monitor task (or let agent auto-schedule on first X command).

---

## Out of Scope

- Frontend UI for approvals/engagement history (tracked: openclaw-paas-j47v)
- LinkedIn or other platform monitor implementations
- Media/image upload support for tweets
- DM reading/sending
- Analytics dashboards
- Migration tool for existing Playwright auth sessions

## Risks

### Feasibility
We have not yet confirmed that all engagement actions (like, retweet, reply, quote) work via OAuth 2.0 at the usage-based pricing tier. DRY_RUN mode allows building and testing the full pipeline before making real API calls. If certain actions are unavailable, we degrade gracefully by disabling those actions in the approval policy defaults.

### X SDK Maturity
`@xdevplatform/xdk` is at v0.5.0. It may have gaps or bugs. Fallback: use `twitter-api-v2` (PLhery/node-twitter-api-v2) which is battle-tested, or raw HTTP calls to X API v2 endpoints through the OneCLI proxy.

### Rate Limits
Usage-based pricing means every API call has a cost. The OneCLI policy rules enforce rate limits (2000 reads/hr, 10 writes/hr, 50 likes/hr, 50 retweets/hr). The timeline monitor interval should be tuned to balance engagement responsiveness against API cost.
