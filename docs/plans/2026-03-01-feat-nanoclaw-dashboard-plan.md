---
title: Add Read-Only Visibility Dashboard
type: feat
status: completed
date: 2026-03-01
origin: docs/plans/2026-01-01-nanoclaw-dashboard.md
deepened: 2026-03-01
---

# Add Read-Only Visibility Dashboard

## Enhancement Summary

**Deepened on:** 2026-03-01
**Research agents used:** TypeScript reviewer, Performance oracle, Security sentinel, Architecture strategist, Frontend races reviewer, Code simplicity reviewer, Best practices researcher, Hono Context7 docs

### Key Improvements
1. **Use `streamSSE()` from `hono/streaming`** instead of raw TransformStream — official Hono helper handles headers, abort, and wire protocol
2. **XSS prevention mandate** — use `textContent` for all user-generated content; add Content-Security-Policy header
3. **Race condition patterns** — generation counters + AbortController for chat switching, SSE state machine, pagination buffering
4. **Row-type mappers** — explicit snake_case → camelCase + integer → boolean conversion layer between SQLite and API
5. **Prepared statement caching** — prepare all queries once at init, reuse via module-level `stmts` object
6. **Missing index** — add `idx_task_run_logs_run_at` for SSE polling without `task_id` filter

### New Considerations Discovered
- `COUNT(m.id)` not `COUNT(*)` with LEFT JOIN to get correct zero counts
- Wrap multi-query overview reads in `.transaction().deferred()` for consistency
- SSE max connection limit (10) to prevent resource exhaustion
- `(? IS NULL OR col = ?)` pattern for optional filters in single prepared statement
- Auth modal must be idempotent — multiple 401s from different fetches shouldn't stack modals

---

## Overview

Add a read-only visibility dashboard to the existing Hono server (port 3100). Single-file vanilla JS SPA with no build step. Provides real-time visibility into messages, scheduled tasks, groups, and system stats via 7 API endpoints + SSE streaming.

## Problem Statement / Motivation

NanoClaw currently has no visibility into its operational state without querying SQLite directly or reading container logs. Operators need a quick way to:
- See message activity across all channels (WhatsApp, Slack, GitHub, Web)
- Monitor scheduled task execution and catch failures
- Review registered groups and their configuration
- Get a system-wide overview of activity

## Proposed Solution

Mount a dashboard sub-app on the existing Hono server. Two new files (`src/dashboard.ts` + `static/dashboard.html`), one modified file (`src/channels/web.ts`). All endpoints are read-only — no mutations.

```
Browser → GET /dashboard → static HTML/CSS/JS (single file)
        → GET /api/dashboard/* → JSON API endpoints (read-only)
        → GET /api/dashboard/events → SSE stream (realtime)
        ↓
   Same Hono server (web.ts) mounting dashboard sub-app
        ↓
   Dashboard queries (dashboard.ts) → SQLite (db.ts)
```

## Technical Approach

### Architecture

**Sub-app pattern:** `src/dashboard.ts` exports a `Hono` instance. `src/channels/web.ts` mounts it via `app.route('/api/dashboard', dashboardApp)`. The existing `bearerAuth` middleware on `/api/*` covers all dashboard API routes automatically.

> **Research insight (Architecture):** Hono middleware registered via `app.use('/api/*', ...)` on the parent app DOES apply to sub-app routes mounted under `/api/dashboard/*`, but ONLY if the middleware is registered BEFORE the `app.route()` call. Add a comment in `web.ts` to document this ordering dependency.

**Static file serving:** `GET /dashboard` is a dedicated route in `web.ts` that reads `static/dashboard.html` from disk using `path.resolve(PROJECT_ROOT, 'static', 'dashboard.html')` — resolves relative to repo root, not `dist/`. Cache the HTML string in memory (re-read on process restart).

```typescript
// In web.ts — cache static HTML in memory
import { PROJECT_ROOT } from './config.js';
let cachedDashboardHtml: string | null = null;
app.get('/dashboard', (c) => {
  if (!cachedDashboardHtml) {
    cachedDashboardHtml = fs.readFileSync(
      path.resolve(PROJECT_ROOT, 'static', 'dashboard.html'), 'utf-8'
    );
  }
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Content-Security-Policy',
    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'");
  return c.html(cachedDashboardHtml);
});
```

**SSE implementation:** Use Hono's `streamSSE()` helper from `hono/streaming` instead of raw TransformStream. It handles `Content-Type: text/event-stream`, abort signals, and the SSE wire protocol correctly.

```typescript
import { streamSSE } from 'hono/streaming';

app.get('/events', (c) => {
  return streamSSE(c, async (stream) => {
    let running = true;
    let lastMessageTs = new Date().toISOString();
    let lastRunTs = new Date().toISOString();

    stream.onAbort(() => { running = false; });

    while (running) {
      const activity = getNewActivity(lastMessageTs, lastRunTs);
      for (const msg of activity.messages) {
        await stream.writeSSE({ event: 'message', data: JSON.stringify(msg), id: String(globalEventId++) });
        lastMessageTs = msg.timestamp;
      }
      for (const run of activity.taskRuns) {
        await stream.writeSSE({ event: 'taskRun', data: JSON.stringify(run), id: String(globalEventId++) });
        lastRunTs = run.runAt;
      }
      // Heartbeat if nothing new
      if (!activity.messages.length && !activity.taskRuns.length) {
        await stream.writeSSE({ event: 'heartbeat', data: '', id: String(globalEventId++) });
      }
      await stream.sleep(3000);
    }
  });
});
```

**SSE authentication:** `EventSource` does not support custom `Authorization` headers. Use a `fetch()`-based SSE client in the frontend that reads the stream via `ReadableStream` and parses SSE frames manually.

> **Research insight (SSE client):** The fetch-based parser MUST buffer incomplete chunks — network reads can split in the middle of an SSE frame. Split on `\n\n`, keep the trailing incomplete element, and handle the `retry:` field per SSE spec.

**Database access:** All queries use `getDatabase()` singleton from `db.ts`. Prepare all statements once at module init, reuse via `stmts` object. New query functions are standalone exported functions in `dashboard.ts` (NOT in `db.ts` — queries are dashboard-specific and read-only).

> **Research insight (Performance):** Use `.pluck()` for scalar COUNT queries, `COUNT(m.id)` (not `COUNT(*)`) with LEFT JOIN for zero-safe counts, and wrap multi-query reads in `.transaction().deferred()` for consistent API responses without blocking writes.

**Type boundary:** Define row-level types mirroring exact SQL column names (snake_case), then map to API response types (camelCase). This makes the `is_group: number` → `isGroup: boolean` conversion explicit and catches column renames at the mapping layer.

```typescript
interface ChatRow {
  jid: string; name: string; last_message_time: string;
  channel: string | null; is_group: number; message_count: number;
}
interface DashboardChat {
  jid: string; name: string; channel: string;
  isGroup: boolean; lastMessageTime: string; messageCount: number;
}
function toDashboardChat(row: ChatRow): DashboardChat {
  return {
    jid: row.jid, name: row.name, channel: row.channel ?? 'unknown',
    isGroup: row.is_group === 1, lastMessageTime: row.last_message_time,
    messageCount: row.message_count,
  };
}
```

**Auth flow:** On load, SPA checks `localStorage` for token. If missing, shows a modal (idempotent — guard with `authModalVisible` flag). On any 401 response from API calls, clears `localStorage` and re-shows the modal. Token sent as `Authorization: Bearer <token>`.

### Implementation Phases

#### Phase 1: Backend API + Static Serving

**Files:** `src/dashboard.ts` (new), `src/channels/web.ts` (modified), `static/dashboard.html` (new, placeholder)

**Tasks:**
- [ ] Create `static/` directory and minimal `dashboard.html` placeholder
- [ ] Create `src/dashboard.ts` with Hono sub-app exporting 6 REST endpoints:
  - `GET /overview` — system-wide stats (`getOverviewStats()`)
  - `GET /chats` — chat list with counts, `?channel=` and `?search=` filters (`getChatsWithCounts()`)
  - `GET /chats/:jid/messages` — paginated messages, `?limit=50&before=<ts>` (reuse `getMessageHistory()` from `db.ts`)
  - `GET /groups` — all registered groups with channel derived from JID pattern
  - `GET /tasks` — all scheduled tasks
  - `GET /tasks/:id/runs` — task execution history, `?limit=20`
- [ ] Add dashboard query functions in `src/dashboard.ts`:
  - `initDashboardQueries()` — prepare all statements once, store in module-level `stmts` object
  - `getOverviewStats()` — wrapped in `.transaction().deferred()`: COUNT via `.pluck()` from messages, chats (excluding `__group_sync__`), registered_groups; active task count; per-channel message counts; recent 10 chats by `last_message_time`
  - `getChatsWithCounts(channel?, search?)` — use `(? IS NULL OR c.channel = ?)` pattern for optional filters in single prepared statement; `COUNT(m.id)` with LEFT JOIN; filter out `__group_sync__` sentinel
  - `getTaskRuns(taskId, limit)` — `SELECT * FROM task_run_logs WHERE task_id = ? ORDER BY run_at DESC LIMIT ?`
  - `getNewActivity(sinceMessageTs, sinceRunTs)` — for SSE polling, with `LIMIT 50` on messages and `LIMIT 20` on task runs
- [ ] Define row types (snake_case) + API response types (camelCase) + mapper functions in `dashboard.ts`
- [ ] Add shared error response helper: `errorResponse(c, status, code, message)`
- [ ] Mount sub-app in `web.ts`: `app.route('/api/dashboard', dashboardApp)` — AFTER bearerAuth middleware (add comment documenting ordering dependency)
- [ ] Add `GET /dashboard` route in `web.ts` to serve `static/dashboard.html` with security headers (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy)
- [ ] Add `Cache-Control: no-store` header on all `/api/dashboard/*` responses to prevent caching of message content
- [ ] Add `idx_task_run_logs_run_at` index for SSE polling: `CREATE INDEX IF NOT EXISTS idx_task_run_logs_run_at ON task_run_logs(run_at)`
- [ ] Use `z.coerce.number()` for numeric query params (they arrive as strings from `c.req.query()`)
- [ ] Validate parent entity exists before querying children — 404 for invalid `:jid` or `:id`
- [ ] Call `initDashboardQueries()` when web channel connects

**Success criteria:** All 6 endpoints return correct JSON, testable via `curl` with bearer token. Security headers present on all responses.

#### Phase 2: Frontend SPA — Overview + Auth

**Files:** `static/dashboard.html`

**Tasks:**
- [ ] Auth flow: modal on first visit (idempotent — guard with `authModalVisible` flag), `localStorage` persistence, 401 detection on ANY fetch → clear token + re-show modal
- [ ] Centralized `api(path, signal?)` helper: adds auth header, handles 401 → re-auth, returns parsed JSON
- [ ] Tab navigation: Overview | Messages | Tasks | Groups (in-memory `state.activeTab`, event delegation on tab bar)
- [ ] Overview tab: stat cards (total messages, active chats, registered groups, active tasks), messages by channel breakdown, recent activity list (last 10 chats)
- [ ] Loading state: single global "Loading..." indicator per tab (not skeleton screens)
- [ ] Empty states: "No data" text when API returns empty arrays
- [ ] Connection status indicator in header (green/yellow/red dot)
- [ ] Timestamps: relative for <24h ("2 min ago"), absolute for older, `title` attribute with full ISO
- [ ] Organize `<script>` block: constants → state → API layer → data fetching → render functions → SSE → event handlers → init

> **Research insight (SPA patterns):** Use a plain state object + explicit render functions. Event delegation on stable parent containers for dynamic content. Centralize fetch with auth in a single `api()` function.

**XSS prevention (CRITICAL):**
- [ ] Use `textContent` for ALL user-generated content (message content, sender names, chat names, task prompts, task results/errors)
- [ ] If using `innerHTML` for template-based rendering, escape all user data with `escapeHtml()` and `escapeAttr()` helpers
- [ ] Never insert raw user content into innerHTML, href, or event handler attributes

```javascript
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escapeAttr(s) { return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
```

**Success criteria:** Overview tab renders correctly after token entry. Invalid token shows error and re-prompts. No XSS in rendered content.

#### Phase 3: Frontend SPA — Messages Tab

**Files:** `static/dashboard.html`

**Tasks:**
- [ ] Left sidebar: chat list from `/api/dashboard/chats`, ordered by most recent activity
- [ ] Channel filter dropdown + name search box (debounce search input 250ms)
- [ ] Right panel: message thread for selected chat, newest at bottom (standard chat UX)
- [ ] Scroll-up pagination: detect scroll to top → fetch `/chats/:jid/messages?before=<oldest_ts>` → prepend older messages → restore scroll position
- [ ] Sender name display, bot message styling (distinct background), timestamp formatting
- [ ] Thread indicator: show `thread_ts` as a small badge/indicator (flat list for V1)
- [ ] Graceful JID display: show JID abbreviation when chat name is unavailable
- [ ] Loading and empty states for both sidebar and message panel

**Race condition handling (CRITICAL):**
- [ ] **Chat switch race:** Generation counter (`chatLoadGeneration`) + AbortController per chat load. When user switches chats, increment generation and abort previous fetch. On fetch completion, check generation matches before rendering.
- [ ] **Chat list filter race:** Generation counter (`chatListGeneration`) + AbortController. On filter/search change, increment and abort previous.
- [ ] **SSE + pagination race:** Message panel state machine (`MSG_IDLE`, `MSG_LOADING_OLDER`, `MSG_LOADING_INITIAL`). Buffer SSE messages during pagination loads, flush in `finally` block after pagination completes.
- [ ] **Scroll position preservation:** Before prepending older messages, save `scrollHeight`. After prepend, set `scrollTop += (newScrollHeight - savedScrollHeight)`.
- [ ] **Auto-scroll:** Only auto-scroll to bottom on new SSE message if user was already at bottom.

```javascript
// Chat switch pattern
let chatLoadGeneration = 0;
let activeChatAbort = null;
async function loadChat(jid) {
  const myGeneration = ++chatLoadGeneration;
  if (activeChatAbort) activeChatAbort.abort();
  activeChatAbort = new AbortController();
  try {
    const data = await api(`/api/dashboard/chats/${jid}/messages?limit=50`, activeChatAbort.signal);
    if (myGeneration !== chatLoadGeneration) return; // stale
    renderMessages(data.messages);
  } catch (e) {
    if (e.name === 'AbortError') return;
    if (myGeneration !== chatLoadGeneration) return;
  }
}
```

**Success criteria:** Can browse any chat's message history with filtering and pagination. No stale data renders on rapid chat switching.

#### Phase 4: Frontend SPA — Tasks + Groups Tabs

**Files:** `static/dashboard.html`

**Tasks:**
- [ ] Tasks tab: table with ID, group folder, schedule (type + value), next run, last run, status
- [ ] Click task row → expand to show run history (last 20 runs with status, duration, result/error)
- [ ] Color-coded status badges (active=green, paused=yellow, error=red)
- [ ] Groups tab: table with name, folder, trigger pattern, channel (derived from JID), added date, requires trigger
- [ ] Empty states for both tabs
- [ ] Tab switch abort: on tab change, abort any in-flight data fetches for the previous tab via `tabAbort` controller

**Success criteria:** Tasks and groups tables render with expandable task runs.

#### Phase 5: SSE Real-Time Updates

**Files:** `src/dashboard.ts` (SSE endpoint), `static/dashboard.html` (SSE client)

**Backend tasks:**
- [ ] `GET /events` SSE endpoint using `streamSSE()` from `hono/streaming`
- [ ] Use `stream.onAbort(() => { running = false })` for cleanup — no `setInterval` needed, use `stream.sleep(3000)` in while loop
- [ ] Track high-water marks (`lastMessageTs`, `lastRunTs`) per connection
- [ ] Push `event: message` and `event: taskRun` with JSON data
- [ ] Heartbeat: if no new data in a poll cycle, send `event: heartbeat` with empty data (keeps connection alive)
- [ ] Include `id:` field on all events (monotonic counter) for `Last-Event-ID` replay
- [ ] SSE connection limit: track active connections, reject with 429 if >10

**Frontend tasks:**
- [ ] Fetch-based SSE client with custom `Authorization` header
- [ ] SSE frame parser: buffer chunks, split on `\n\n`, keep trailing incomplete frame, handle `:` comment lines and `retry:` field
- [ ] SSE state machine: `DISCONNECTED` → `CONNECTING` → `CONNECTED` → (on error) → `BACKING_OFF` → `CONNECTING` / (on 401) → `AUTH_FAILED`
- [ ] `AUTH_FAILED` state blocks reconnection until re-auth completes
- [ ] On `message` event: append to current chat if viewing it, update chat list ordering/counts
- [ ] On `taskRun` event: update task row status, update expanded run history if visible
- [ ] Auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s), reset to 1s on successful connection
- [ ] On reconnect: re-fetch current tab data to fill gap during disconnection
- [ ] Connection status indicator: green=connected, yellow=reconnecting, red=disconnected
- [ ] `connectSSE()` guard: refuse to start second connection if already `CONNECTING` or `CONNECTED`

> **Research insight (Visibility API):** Consider pausing DOM updates while browser tab is hidden. On `visibilitychange`, flush buffered SSE updates in one batch to prevent a burst of reflows when user returns to the tab.

**Success criteria:** New messages and task runs appear in real-time without page refresh. Clean reconnect on disconnect. No duplicate connections.

## System-Wide Impact

### Interaction Graph

`GET /dashboard` → reads `static/dashboard.html` from memory cache → serves HTML with security headers
`GET /api/dashboard/*` → `bearerAuth` middleware → dashboard query function → prepared statement → SQLite → row mapper → JSON response
`GET /api/dashboard/events` → `bearerAuth` → `streamSSE()` → `while(running)` loop → `stream.sleep(3000)` → SQLite poll → `stream.writeSSE()` → client receives

No callbacks, no middleware side-effects beyond auth. All read-only. No coupling to message processing pipeline, container runner, or channel implementations.

### Error & Failure Propagation

- SQLite `BUSY` (5s timeout from existing config) → catch in SSE loop (log, don't kill stream); return 500 on REST endpoints with `{ error: { code: "DB_BUSY" } }`
- Invalid token → 401 from existing `bearerAuth` middleware → client clears `localStorage`, shows auth modal
- Invalid query params → 400 with descriptive error via Zod validation
- SSE connection drop → `stream.onAbort()` sets `running = false` → loop exits cleanly, no leaked timers
- SSE poll error → caught inside while loop, logged, next iteration retries

### State Lifecycle Risks

None. All endpoints are read-only. No writes, no transactions, no state mutation. The SSE endpoint holds an open HTTP response and a `while/sleep` loop — both cleaned up on abort signal. Module-level `stmts` object is read-only after `initDashboardQueries()`.

### API Surface Parity

The dashboard API endpoints are a new surface area. They do NOT overlap with the existing web channel API (`/api/sessions/*`). The auth mechanism is shared (`WEB_AUTH_TOKEN` + `bearerAuth`). The `GET /dashboard` HTML page is intentionally unauthenticated (public shell; data requires auth).

### Integration Test Scenarios

1. **Auth flow**: Enter wrong token → 401 → re-prompt → enter correct token → data loads → SSE connects
2. **SSE lifecycle**: Connect SSE → send messages via WhatsApp → verify SSE pushes → kill network → verify reconnect with backoff → verify data gap filled by tab re-fetch
3. **Pagination + SSE race**: View chat → scroll up to load older messages → while loading, SSE delivers new message → verify buffered message appears after pagination completes, scroll position preserved
4. **Chat switch race**: Rapidly click between 3 chats → verify final rendered chat matches the last clicked, no stale data from earlier fetches
5. **Cross-channel**: Messages from WhatsApp, Slack, and GitHub → overview shows correct per-channel counts → filter by channel works
6. **Task monitoring**: Create cron task → wait for execution → verify task run appears in dashboard via SSE → check run history
7. **XSS prevention**: Send a message containing `<script>alert(1)</script>` → verify it renders as text, not executed

## Acceptance Criteria

### Functional Requirements

- [ ] `GET /dashboard` serves the SPA HTML page (no auth required for the page itself)
- [ ] All 6 REST API endpoints return correct JSON with bearer auth
- [ ] SSE endpoint streams new messages and task runs in real-time
- [ ] Auth modal appears on first visit, token persists in `localStorage`
- [ ] 401 responses trigger re-authentication flow (idempotent modal, SSE stops reconnecting until re-auth)
- [ ] Overview tab shows accurate stats across all channels
- [ ] Messages tab supports chat browsing, filtering by channel, search by name, and scroll pagination
- [ ] Tasks tab shows all tasks with expandable run history
- [ ] Groups tab shows all registered groups
- [ ] SSE auto-reconnects with exponential backoff on disconnect
- [ ] No stale data rendering on rapid chat/tab switching (generation counters + AbortController)

### Non-Functional Requirements

- [ ] No build step — single HTML file with inline CSS/JS
- [ ] No new npm dependencies (uses existing Hono, better-sqlite3, zod)
- [ ] Dashboard queries do not block the main message processing loop (synchronous SQLite reads are <5ms for expected data volumes)
- [ ] SSE heartbeat prevents proxy timeout (every 3s poll cycle, explicit heartbeat event)
- [ ] Page load under 1s on localhost (estimated 20-30KB HTML, cached in memory)
- [ ] All user-generated content escaped — no XSS vectors
- [ ] Security headers on HTML response (CSP, X-Frame-Options, nosniff, no-referrer)
- [ ] `Cache-Control: no-store` on API responses

### Quality Gates

- [ ] All endpoints manually tested via `curl`
- [ ] Frontend tested in Chrome and Firefox
- [ ] No console errors in browser dev tools
- [ ] Auth flow works correctly (first visit, return visit, token rotation)
- [ ] XSS test: message with `<script>` tag renders as text
- [ ] Race condition test: rapid chat switching shows correct final state

## Dependencies & Prerequisites

- Existing Hono server running on port 3100 (already implemented in `src/channels/web.ts`)
- `WEB_AUTH_TOKEN` configured in `.env`
- SQLite database with populated tables (chats, messages, scheduled_tasks, task_run_logs, registered_groups)
- `streamSSE` helper available from `hono/streaming` (already in dependency tree)

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| XSS via message content | Medium | High (token theft) | **P1**: Use `textContent` for all user content; add CSP header |
| `COUNT(*)` on large messages table is slow | Medium | Low | Acceptable for V1 (<3ms at 100k rows); add shadow counter if >500k |
| SSE connections accumulate (many tabs) | Low | Low | Max 10 connections, reject with 429 |
| `static/dashboard.html` path resolution | Medium | Medium | Use `PROJECT_ROOT` from config.ts, resolve absolute path |
| Token exposed in `localStorage` | Low | Low | Single-user localhost tool; mitigated by CSP preventing XSS |
| Stale data from race conditions | Medium | Medium | Generation counters + AbortController on all async fetches |
| Missing index for SSE task run polling | Medium | Low | Add `idx_task_run_logs_run_at` index |
| SSE parser chunk splitting | Medium | Medium | Buffer incomplete frames; split on `\n\n`, keep trailing element |

## Sources & References

### Origin

- **Feature specification:** [docs/plans/2026-01-01-nanoclaw-dashboard.md](docs/plans/2026-01-01-nanoclaw-dashboard.md)

### Internal References

- Hono server setup: `src/channels/web.ts` (routing, auth, streaming patterns)
- Database access: `src/db.ts` (query patterns, table schemas, existing functions)
- Task scheduler: `src/task-scheduler.ts` (task lifecycle, run logging)
- Configuration: `src/config.ts` (`PROJECT_ROOT`, `STORE_DIR`)
- TypeScript conventions: ESM with `.js` extensions, strict mode, kebab-case files

### External References

- [Hono Streaming Helpers (Official Docs)](https://hono.dev/docs/helpers/streaming) — `streamSSE()`, `stream.writeSSE()`, `stream.onAbort()`, `stream.sleep()`
- [Hono Timeout + SSE Pattern](https://hono.dev/docs/middleware/builtin/timeout) — `setTimeout` + `stream.close()` for max stream lifetime
- [MDN: Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) — SSE wire protocol spec
- [SQLite Query Optimizer](https://sqlite.org/optoverview.html) — index usage for COUNT, GROUP BY, range scans
- [better-sqlite3 Performance](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md) — prepared statement reuse, `.pluck()`, transactions
