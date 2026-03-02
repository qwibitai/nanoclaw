# NanoClaw Dashboard — Implementation Plan
 
## Overview
Add a read-only visibility dashboard to the existing Hono server (port 3100). Lightweight SPA with vanilla JS, no build step. Covers messages, scheduled tasks, groups, and system overview with near-realtime updates.
 
---
 
## Architecture
 
```
Browser → GET /dashboard → static HTML/CSS/JS (single file)
        → GET /api/dashboard/* → JSON API endpoints (read-only)
        → GET /api/dashboard/events → SSE stream (realtime)
        ↓
   Same Hono server (web.ts) mounting dashboard sub-app
        ↓
   Dashboard queries (dashboard.ts) → SQLite (db.ts)
```
 
**Auth**: Reuses existing `WEB_AUTH_TOKEN` bearer auth. The SPA stores the token in a prompt on first visit and keeps it in `localStorage`.
 
---
 
## New Files
 
| File | Purpose |
|------|---------|
| `src/dashboard.ts` | Hono sub-app: API endpoints + dashboard-specific DB queries + SSE |
| `static/dashboard.html` | Single-file SPA: HTML + CSS + vanilla JS (no build step) |
 
## Modified Files
 
| File | Change |
|------|--------|
| `src/channels/web.ts` | Mount dashboard sub-app from `dashboard.ts`, serve `static/dashboard.html` |
 
---
 
## API Endpoints (all under `/api/dashboard/`, all read-only)
 
### 1. `GET /api/dashboard/overview`
System-wide stats for the overview page.
```json
{
  "totalMessages": 1234,
  "totalChats": 15,
  "totalGroups": 5,
  "activeTasks": 3,
  "messagesByChannel": { "whatsapp": 800, "slack": 300, "github": 134 },
  "recentActivity": [
    { "chatJid": "...", "chatName": "...", "channel": "whatsapp", "lastMessage": "2026-03-02T..." }
  ]
}
```
 
### 2. `GET /api/dashboard/chats?channel=whatsapp&search=foo`
All chats with message counts, filterable by channel and name search.
```json
{
  "chats": [
    { "jid": "...", "name": "...", "channel": "whatsapp", "isGroup": true, "lastMessageTime": "...", "messageCount": 42 }
  ]
}
```
 
### 3. `GET /api/dashboard/chats/:jid/messages?limit=50&before=<timestamp>`
Paginated messages for a specific chat (reuses existing `getMessageHistory` with minor enhancement).
```json
{
  "messages": [
    { "id": "...", "senderName": "...", "content": "...", "timestamp": "...", "isBotMessage": false, "threadTs": null }
  ]
}
```
 
### 4. `GET /api/dashboard/groups`
All registered groups with their configuration.
```json
{
  "groups": [
    { "jid": "...", "name": "...", "folder": "main", "trigger": "@Andy", "addedAt": "...", "requiresTrigger": true }
  ]
}
```
 
### 5. `GET /api/dashboard/tasks`
All scheduled tasks with status.
```json
{
  "tasks": [
    { "id": "...", "groupFolder": "...", "chatJid": "...", "prompt": "...", "scheduleType": "cron", "scheduleValue": "0 9 * * *", "nextRun": "...", "lastRun": "...", "lastResult": "...", "status": "active", "createdAt": "..." }
  ]
}
```
 
### 6. `GET /api/dashboard/tasks/:id/runs?limit=20`
Execution history for a specific task.
```json
{
  "runs": [
    { "id": 1, "runAt": "...", "durationMs": 4500, "status": "success", "result": "...", "error": null }
  ]
}
```
 
### 7. `GET /api/dashboard/events` (SSE)
Server-Sent Events stream. Polls SQLite every 3 seconds for new messages and task runs, pushes diffs to the browser.
```
event: message
data: {"chatJid":"...","senderName":"...","content":"...","timestamp":"..."}
 
event: taskRun
data: {"taskId":"...","status":"success","runAt":"..."}
```
 
---
 
## DB Queries to Add (in `src/dashboard.ts`)
 
These are lightweight wrappers using the existing `db` instance (via `getDatabase()`):
 
1. **`getOverviewStats()`** — `SELECT COUNT(*) FROM messages`, `SELECT COUNT(*) FROM chats`, counts per channel, active task count
2. **`getChatsWithCounts(channel?, search?)`** — `SELECT c.*, COUNT(m.id) as message_count FROM chats c LEFT JOIN messages m ON ... GROUP BY c.jid`, with optional WHERE filters
3. **`getTaskRunsForTask(taskId, limit)`** — Already exists as `getTaskRunLogs` pattern but needs exposing
4. **`getLatestActivity(sinceTimestamp)`** — New messages since timestamp, for SSE polling
 
---
 
## Frontend (`static/dashboard.html`)
 
Single HTML file with embedded `<style>` and `<script>`. No build step.
 
### Layout
- **Header**: NanoClaw Dashboard title, connection status indicator
- **Tab bar**: Overview | Messages | Tasks | Groups
- **Content area**: Renders based on active tab
 
### Overview Tab
- Stats cards: total messages, active chats, registered groups, active tasks
- Messages by channel (simple bar or counts)
- Recent activity list (last 10 chats with activity)
 
### Messages Tab
- Left sidebar: chat list (filterable by channel dropdown, searchable by name)
- Right panel: message thread for selected chat (scrollable, paginated)
- Auto-updates via SSE when new messages arrive
 
### Tasks Tab
- Table: task ID, group, schedule, next run, last run, status
- Click a task → expandable row showing run history (last 20 runs with status/duration/errors)
 
### Groups Tab
- Table: group name, folder, trigger pattern, channel, added date, requires trigger
 
### Auth Flow
- On load, check `localStorage` for token
- If missing, show a simple prompt/modal to enter the bearer token
- Token sent as `Authorization: Bearer <token>` on all API calls
 
### Realtime
- Connect to `/api/dashboard/events` SSE endpoint with auth
- On `message` events: prepend to current chat if viewing that chat, update chat list ordering
- On `taskRun` events: update task status in tasks table
- Auto-reconnect on disconnect with backoff
 
---
 
## Implementation Order
 
1. **`src/dashboard.ts`** — API endpoints + queries (backend first, testable via curl)
2. **Mount in `src/channels/web.ts`** — Wire up the sub-app + serve static file
3. **`static/dashboard.html`** — Overview tab first (simplest)
4. **Messages tab** — Chat list + message viewer
5. **Tasks tab** — Task table + run history
6. **Groups tab** — Group table
7. **SSE endpoint** — Real-time updates last (polish)
 
---
 
## What This Does NOT Do
- No mutations (no creating/deleting tasks, no sending messages)
- No user management (single-token auth, same as existing web channel)
- No persistent frontend state beyond the auth token
- No build step, bundler, or framework