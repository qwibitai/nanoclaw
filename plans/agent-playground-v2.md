# Agent Playground — v2 rebuild plan

## Why

The v1 playground was a web workbench at `127.0.0.1:3002/playground/` for
iterating on agent personas and skills before applying them to a live
agent group. It was a Bucket A item in the v1→v2 migration guide, flagged
for *rebuild* (not port) because the underlying session model changed:
v1 spawned one-shot containers; v2 has a persistent two-DB session per
agent group.

This plan rebuilds it as a v2 channel adapter in 5 phases. Estimated
total: 9–10 hours of focused work.

## Decisions (locked)

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | **No auth** (loopback-only bind) | If an attacker can hit 127.0.0.1 they're already inside. Drop `auth.ts` + `login.html` from v1. |
| 2 | **Draft folders at `groups/draft_<target>/`** | Matches v1 convention; v2 group-folder layout is identical. |
| 3 | **Chat-only inside playground** (no real-channel pairing) | Drafts test through the playground UI, not via Telegram/etc. Keeps the test session isolated. |
| 4 | **Tool-call granularity in trace stream**, with verbosity slider | Strikes balance between "just final reply" and "every token". |
| 5 | **Per-test provider override via `sessions.agent_provider`** | Existing column; existing precedence in `resolveProviderName`. Toggle = `UPDATE sessions ...; killContainer; wakeContainer`. No router or schema changes. |
| 6 | **Lazy-start via `/playground` Telegram command** | Don't bind the port at boot. `/playground` starts the server on demand and replies with the URL; `/playground stop` shuts it down. `PLAYGROUND_ENABLED=1` becomes the feature gate (command refuses if unset). |

## Architecture: playground IS a channel

Key insight: the playground does the same thing every other channel does
— forwards a user's text into the router, then displays the agent's
reply. Telegram does this over Bot API HTTPS; the CLI adapter
(`src/channels/cli.ts`) does it over a Unix socket; the playground does
it over HTTP + WebSocket.

So playground registers as a normal channel adapter. No special-casing
in the router, no sentinel `messaging_groups` row, no NULL-handling
elsewhere. Each draft gets its own auto-created `messaging_groups` row
the same way Telegram chats do.

```
channel_type = 'playground'
platform_id  = 'playground:<draft_folder>'   (one mg per draft, auto)
transport    = HTTP + WebSocket on 127.0.0.1:<PLAYGROUND_PORT>
adapter      = src/channels/playground.ts    (template: src/channels/cli.ts)
```

Benefits over the earlier "synthetic session + REST endpoints" design:

| Concern from earlier draft | How "channel adapter" resolves it |
|---|---|
| Sentinel messaging_group / NULL FK migration | Auto-created mg per draft. No migration. |
| Provider override threading | `UPDATE sessions SET agent_provider=? WHERE id=?` + restart container. ~5 LoC. |
| Bespoke chat REST endpoints | Reuse standard router → inbound.db → container → outbound.db pipeline. |
| Bespoke trace stream from outbound.db | Adapter's `deliver()` is invoked by the standard delivery poll loop with each outbound message. Push to WebSocket from there. |
| Slash commands like `/clear` | Already routed through the same gate; work for free. |

## Layers

### Layer 1 — `src/agent-builder/core.ts` (pure library)

DB + filesystem only. No HTTP. Two front-ends layer on top:
the playground (this plan) and a future `/agent-builder` Bash skill
(deferred).

**API:**

```ts
// Listing
listAgentGroups(): AgentGroup[]                          // not draft_*
listDrafts(): { draft: AgentGroup; target: AgentGroup | null }[]

// Draft lifecycle
createDraft(targetFolder: string): AgentGroup            // copies CLAUDE.local.md, container.json
applyDraft(draftFolder: string, opts?: { keepDraft?: boolean }): void
discardDraft(draftFolder: string): void

// Inspection
diffDraftAgainstTarget(draftFolder: string): DraftDiff
getDraftStatus(draftFolder: string): { dirty: boolean; targetExists: boolean }

// Channel-related
ensureDraftMessagingGroup(draftFolder: string): MessagingGroup  // idempotent
ensureDraftWiring(draftFolder: string): void                    // wires draft mg ↔ draft agent_group with engage='.', accept-all
```

`ensureDraftMessagingGroup` and `ensureDraftWiring` are called from the
playground channel adapter when a session starts. The wiring uses
`engage_mode='pattern'`, `engage_pattern='.'`, `sender_scope='all'` so
every message in the playground engages (matches the playground's
"single user, single draft" semantics).

### Layer 2 — `src/channels/playground.ts` (channel adapter, lazy-spawned)

Modeled after `src/channels/cli.ts`. Differences:

- Transport is HTTP + WebSocket, not Unix socket.
- Multiple HTTP endpoints (REST for draft management) plus one WebSocket per browser tab for chat + trace.
- `deliver()` pushes outbound messages to the connected WebSocket.
- Lazy-started: not registered automatically; `/playground` command in
  Telegram calls `startPlaygroundChannel()` which registers the adapter
  and listens; `/playground stop` unregisters and closes the server.

**HTTP endpoints (mostly draft management — chat goes over WS):**

```
GET    /api/groups                — list non-draft agent_groups
GET    /api/drafts                — list drafts with target reference
POST   /api/drafts                — body: { targetFolder } → create draft
DELETE /api/drafts/:folder        — discard draft
GET    /api/draft/:folder/persona — read CLAUDE.local.md
PUT    /api/draft/:folder/persona — write CLAUDE.local.md
GET    /api/draft/:folder/diff    — diff vs target
POST   /api/draft/:folder/apply   — apply to target (optional keepDraft)
GET    /api/draft/:folder/files   — list files
GET    /api/draft/:folder/files/:path — read
PUT    /api/draft/:folder/files/:path — write
PUT    /api/draft/:folder/provider     — body: { provider } → updates sessions.agent_provider, kills+wakes container
PUT    /api/draft/:folder/trace-level  — body: { level } → 'final' | 'tool-call' | 'all'
GET    /api/skills/library             — anthropic/skills cache contents
POST   /api/skills/library/refresh     — git pull cache
GET    /api/draft/:folder/skills       — enabled skills (from container.json)
PUT    /api/draft/:folder/skills       — enable/disable
```

**WebSocket** at `/ws/:folder` — per-draft. Server pushes outbound
events from the standard `deliver()` callback, plus tool-call events
filtered by current trace level. Client sends chat text via the same
socket (`{type:'chat', text:'...'}`) which becomes a normal inbound
event into the router for that draft's mg.

### Layer 3 — UI (`src/channels/playground/public/`)

Files: `index.html`, `app.js`, `style.css` (port v1 minus auth).

Modes:
- **Picker** — list drafts (and "create from <target>" for each non-draft group)
- **Workspace** (when a draft is active):
  - Chat pane (WebSocket)
  - Persona pane (CLAUDE.local.md editor + diff)
  - Skills pane (current draft's enabled skills + library browser)
  - Files pane (file browser/editor for draft folder)
  - Topbar: provider toggle (claude/codex), trace verbosity slider, end-session

### Layer 4 — Skills library (`src/channels/playground/library.ts`)

Direct port from `origin/main:src/playground/library.ts`. Module is
mostly standalone — caches `github.com/anthropics/skills` clone under
`.nanoclaw/playground/library-cache/`, parses SKILL.md for unsupported
tools, emits compatibility badges. Swap v1's `logger` import for v2's
`log`.

## Phased plan

### Phase 0 — Core library  (2 hr)

**Files:**
- `src/agent-builder/core.ts` (new)
- `src/agent-builder/core.test.ts`
- `src/config.ts` — add `PLAYGROUND_PORT` (default 3002), `PLAYGROUND_ENABLED`

**Done when:**
- `pnpm test src/agent-builder/` passes
- A small CLI smoke (`scripts/agent-builder-smoke.ts`) creates draft, applies, discards, with verifiable DB + filesystem side effects.

### Phase 1 — Channel adapter scaffold + chat round-trip  (3 hr)

**Files:**
- `src/channels/playground.ts` (new) — registerChannelAdapter('playground', ...) with HTTP server, WS, deliver() callback
- `src/channels/playground/index.ts` — exports `startPlaygroundChannel`, `stopPlaygroundChannel`
- `src/channels/telegram.ts` — `handlePlaygroundCommand` (`/playground`, `/playground stop`)
- `src/playground/public/index.html`, `app.js`, `style.css` — picker + minimal chat pane

**Done when:**
- `/playground` on Telegram replies with URL
- Browser shows picker, can create+pick a draft
- Picking starts a session; chat text round-trips to the agent and back via WebSocket
- Live trace events appear in the chat pane (collapsible)
- `/playground stop` cleanly closes the server, unregisters the adapter

### Phase 2 — Persona editor + apply  (1 hr)

**Files:**
- `src/channels/playground.ts` — add `/api/draft/:folder/{persona,diff,apply}` routes
- `src/channels/playground/public/persona-pane.js`

**Done when:**
- Edit CLAUDE.local.md → save → next chat message reflects change
- Diff pane shows draft vs target
- Apply writes to target group, ends session

### Phase 3 — Provider override + trace verbosity + topbar  (1 hr)

**Files:**
- `src/channels/playground.ts` — `/api/draft/:folder/provider`, `/api/draft/:folder/trace-level`
- `src/channels/playground/public/topbar.js`

**Done when:**
- Topbar provider toggle: switching from `codex` to `claude` mid-session updates `sessions.agent_provider`, kills+wakes container, next message uses new provider
- Verbosity slider filters WebSocket pushes (final / tool-call / all)
- Provider toggle disabled while a turn is in flight (avoid mid-turn restart)

### Phase 4 — Skills + library  (2 hr)

**Files:**
- `src/channels/playground/library.ts` (port from v1)
- `src/channels/playground.ts` — `/api/skills/library`, `/api/draft/:folder/skills`
- `src/channels/playground/public/skills-pane.js`

**Done when:**
- UI lists current draft's enabled skills (from `container.json`)
- Toggle a skill → writes container.json → applies on next message
- Library pane lists `anthropic/skills` repo with compat badges
- Refresh button git-pulls the cache

### Phase 5b — Files + polish  (1-2 hr)

**Files:**
- `src/channels/playground.ts` — `/api/draft/:folder/files{,/:path}`
- `src/channels/playground/public/files-pane.js`
- Status badges, error toasts, empty-state copy

**Done when:**
- File browser lets you read/write any text file in the draft folder
- Status badge: "● unsaved changes" / "✓ in sync"
- Error toasts on failed saves, network drops
- Reasonable copy/empty states

### Phase 6 — Skill packaging  (1 hr)

**Files:**
- `.claude/skills/add-playground/SKILL.md` — install instructions (idempotent)
- Push playground source onto `channels` branch (or `skill/playground` if you'd rather keep channels branch lean)

**Done when:**
- On a fresh install, `/add-playground` fetches the branch, copies module + UI files, runs `pnpm install`, builds, prints the URL hint.
- The skill is idempotent: re-running on an already-installed tree no-ops.
- This install gets the skill registered locally so it appears in `/list-skills`.

## Things deliberately deferred

- **`/agent-builder` Bash skill** — Layer 1 is built so this can be added later.
- **Multi-active drafts** — single-active lock matches v1.
- **Standalone Live Trace page** — folded into main UI as a tab.
- **Personas library** — defer until requested.
- **Cost tracking** — outbound.db doesn't yet track cost; out of scope.

## Risk register

| Risk | Mitigation |
|------|------------|
| Provider toggle mid-turn fires kill+respawn while container is generating | Disable toggle while turn in-flight (UI guards). If user forces, the in-flight reply is dropped — surface this in a toast. |
| Concurrent draft sessions across browser tabs | Single-active lock at the channel adapter level. Second tab sees "another session is active" and can take over (closes the first). |
| WebSocket connection vs. delivery-poll cadence — could drop trace events on disconnect | Outbound row stays in `outbound.db` regardless. On reconnect, replay last N rows of the current draft's session for context. |
| Anthropic skills library cache stale | Manual refresh button + last-pull timestamp. No auto-refresh. |
| Container holds open file handles after session end — can't delete draft folder | Wait for container exit (close event) before filesystem delete. ~3 sec timeout, then force. |
| Lazy-spawned channel adapter race with delivery poll | `startPlaygroundChannel` registers the adapter atomically before the HTTP listener accepts connections. |

## Open questions

- **Global CLAUDE.md endpoint?** v2 has no `groups/global/CLAUDE.md` (deleted by today's migration). Drop `/api/global` unless explicitly requested.
- **Attachments** (`/api/draft/attachments` in v1)? Defer to follow-up; tests rarely use them.
- **Persistence of last-active draft** across host restarts? v1 didn't keep test sessions across restart; matching that.
