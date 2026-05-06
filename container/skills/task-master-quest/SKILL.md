---
name: task-master-quest
description: Read and manage the user's TaskMasterQuest data via its REST API — list/create/complete tasks, manage categories, check streaks and achievements. Use when the user asks about their tasks, quests, streaks, weekly progress, or anything in their TaskMasterQuest instance.
---

# TaskMasterQuest integration guide

How NanoClaw consumes the TaskMasterQuest REST API. Pair this guide with **`openapi.yaml`** at the repo root, which is the machine-readable source of truth for every endpoint shape.

## Connection details

- **Base URL:** `https://task-master-quest-production.up.railway.app`
- **Authenticates as user:** `MwNmPSXiiYgNuTPYDYHR3wYzUPi1` (you don't send this; the bearer token maps to it server-side)
- **Health check (no auth):** `curl https://task-master-quest-production.up.railway.app/api/health` → `{"status":"ok"}`

## Auth — OneCLI inject (no header from you)

The real bearer token lives in the OneCLI vault under host pattern `task-master-quest-production.up.railway.app` with an **inject** rule (`headerName: Authorization`, `valueFormat: "Bearer {value}"`). The OneCLI HTTPS proxy adds the `Authorization: Bearer <real-token>` header to every outbound request to that host, in flight. **You never see the real token.**

**Critical:** do **NOT** send your own `Authorization` header on TaskMasterQuest requests. If you set one (even `Bearer placeholder`), the server will see your value, not OneCLI's, and reject it with 401. Just call the API with no auth header and the proxy fills it in.

```bash
# Correct — no Authorization header; OneCLI adds it
curl https://task-master-quest-production.up.railway.app/api/tasks

# Wrong — your header reaches the server unmodified, 401
curl -H "Authorization: Bearer placeholder" https://task-master-quest-production.up.railway.app/api/tasks
```

The server's `extractBearerUser` middleware (`server/auth/googleAuth.ts`) then authenticates the request as the user above. There is no session cookie on this path.

If a request returns 401, the most likely causes are: (a) the OneCLI secret was deleted or its host pattern no longer matches, (b) you accidentally sent your own `Authorization` header, or (c) the OneCLI HTTPS proxy isn't wired into this container (rare — check `HTTPS_PROXY` is set). Ask the user to run `onecli secrets list` and confirm a `TaskMasterQuest` entry exists with host pattern `task-master-quest-production.up.railway.app`.

### What NanoClaw will see

- All `/api/*` routes work normally — same data scope as user `MwNmPSXiiYgNuTPYDYHR3wYzUPi1`.
- The `/api/auth/login`, `/api/auth/logout`, `/api/auth/user` endpoints are part of the web-session flow and are not relevant for bearer clients.
- The `ensureUserExists` middleware will provision categories / achievements / stats rows on first hit if they're missing.

## Hard constraints — read these once

1. **`DELETE /api/tasks/:id` returns 403 for non-web clients.** The
   server gates destructive task deletion on the
   `X-TaskQuest-Client: web` header. NanoClaw cannot delete tasks.
   This is enforced server-side in `tasks/routes.ts`.
2. **Achievement unlock cascade is automatic.** When NanoClaw posts
   to `/api/tasks/:id/complete`, the server runs the rules engine
   (`shared/achievements.ts`) and unlocks any achievements that fire.
   The response shape is `{ task, unlockedAchievements: [...] }`.
   NanoClaw should look at `unlockedAchievements` if it wants to
   surface the achievement names somewhere.
3. **Recurring task model is three tables.**
   - `taskDefinitions` — title/description/categoryId
   - `recurringTasks` — the rule (recurrenceType, interval, etc.)
   - `tasks` — the instance (the row that gets completed)

   When NanoClaw creates a recurring task in one call, the server
   creates the definition + recurring + first instance. Subsequent
   instances are auto-generated when `GET /api/tasks` is called.
4. **`taskCompletions` rows are immutable snapshots.** Editing a task
   later does **not** change the historical completion record. If
   NanoClaw is reporting on completion history (`/api/stats/history`),
   it sees titles as they were at completion time.
5. **All times are ISO 8601 UTC** strings in JSON. Send dates as
   `"2026-04-30T00:00:00Z"` or `"2026-04-30"` — both work for
   `dueDate` (the server coerces with `z.coerce.date()`).

## Endpoint cheat-sheet

Full schemas in `openapi.yaml`. Common ones:

### Tasks

| Method | Path | Body | Notes |
|---|---|---|---|
| GET | `/api/tasks` | — | Returns enriched tasks; recurring instances auto-generated on read. |
| GET | `/api/tasks/:id` | — | 404 if not yours. |
| POST | `/api/tasks` | `{title, description?, categoryId?, dueDate?, recurrenceType?, recurrenceInterval?, recurrenceDayOfWeek?, recurrenceDayOfMonth?}` | `title` required, min length 1. |
| PATCH | `/api/tasks/:id` | Partial of above + `rebaselineRecurrence: bool` | For recurring series, `rebaselineRecurrence: true` rewrites the whole series start point. |
| POST | `/api/tasks/:id/complete` | — | Returns `{task, unlockedAchievements[]}`. Triggers streak math + rules engine. |
| POST | `/api/tasks/:id/uncomplete` | — | Reverses completion (snapshot row stays). |
| DELETE | `/api/tasks/:id` | — | **403 — not available to NanoClaw.** |

### Categories

| Method | Path | Body |
|---|---|---|
| GET | `/api/categories` | — |
| POST | `/api/categories` | `{name, color}` (color is hex, e.g. `#2564CF`) |
| GET | `/api/categories/:id` | — |
| PATCH | `/api/categories/:id` | partial `{name?, color?}` |
| DELETE | `/api/categories/:id` | — |

### Achievements

| Method | Path | Notes |
|---|---|---|
| GET | `/api/achievements` | List with per-user `unlockedAt` timestamps. |
| GET | `/api/achievements/progress` | `{ first_task: {current, target}, streak_3: {...}, ... }` |
| POST | `/api/achievements/:type/unlock` | Manual unlock. Normal flow is the auto-cascade on task complete. |

### Stats

| Method | Path | Notes |
|---|---|---|
| GET | `/api/stats` | Singleton row: streaks, weekly progress, last-completion date. |
| PATCH | `/api/stats` | Most useful field is `weeklyGoal`. |
| GET | `/api/stats/history?limit=N` | Reverse-chronological `taskCompletions` rows. |

### Health (no auth)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | `{"status":"ok"}` if reachable. |

## Common workflows (curl)

```bash
BASE="https://task-master-quest-production.up.railway.app"
JSON='-H "Content-Type: application/json"'
# No Authorization header — OneCLI injects it.

# List today's tasks
curl "$BASE/api/tasks"

# Create a task
curl -X POST $JSON "$BASE/api/tasks" \
  -d '{"title":"Reply to important email","dueDate":"2026-05-01"}'

# Complete a task and see if any achievement unlocked
curl -X POST "$BASE/api/tasks/<task-id>/complete"
# Response: {"task": {...}, "unlockedAchievements": [{"type":"first_task", ...}]}

# Get current streak + weekly progress
curl "$BASE/api/stats"
```

## Real-time updates (optional)

If NanoClaw needs to know when state changes:

```
GET https://task-master-quest-production.up.railway.app/api/events
# (no Authorization header — OneCLI injects it)
```

Returns a `text/event-stream`. Each event is JSON of the form
`{ type: "invalidate", keys: ["tasks", "stats", "achievements"] }`.
NanoClaw can use these to know when to re-fetch. SSE is optional —
polling `/api/tasks` and `/api/stats` works fine for slow loops.

## Gotchas worth knowing

- **Time zones.** The server runs in UTC on Railway. The streak math
  uses `Date.UTC()` for day-diffs, so DST in client TZs doesn't matter
  on the wire — but if NanoClaw is doing its own date math, do it in
  UTC.
- **Weekly reset.** The `userStats.weeklyCompleted` counter resets on
  Monday 00:00 UTC. The reset can land in either `/api/stats` or
  `/api/tasks/:id/complete`, whichever fires first after the boundary.
- **Recurring instances appear lazily.** A recurring series only
  materialises its next instance when `GET /api/tasks` is called.
  If NanoClaw is reporting on "what's due", calling `/api/tasks`
  first is the cheapest way to refresh.
- **Achievement criteria don't change at runtime.** The five rule
  types are fixed in `shared/achievements.ts`. New rule types require
  a server deploy.

## Where to look in the codebase

If NanoClaw or its operator needs to debug an unexpected response:

| Concern | File |
|---|---|
| Bearer token check | `server/auth/googleAuth.ts: extractBearerUser` |
| Routes | `server/features/*/routes.ts` |
| Storage logic | `server/features/*/storage.ts` |
| Rule engine | `shared/achievements.ts` |
| Schema (Zod + Drizzle) | `shared/schema.ts` |
| Generated OpenAPI | `openapi.yaml` (regenerate with `npm run openapi:generate`) |
