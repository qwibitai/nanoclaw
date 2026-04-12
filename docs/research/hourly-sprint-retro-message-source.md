# Research: Hourly Sprint Retrospective Message Source

**Task ID:** 9a672c90-e23c-4c0f-813f-f87c646ac3f0
**Date:** 2026-04-12

## Summary

The message "All the completed sprints are already in the processed list. No new completed sprints to process." originates from a **cron-scheduled task** stored in NanoClaw's SQLite database that spawns the CEO container agent every 30 minutes. When no new sprints are found, the agent is instructed to wrap its output in `<internal>` tags to suppress Telegram delivery — but the LLM doesn't always follow this instruction perfectly, causing the message to leak through to the user.

## Source Identification

### Primary Source: Scheduled Task in SQLite

| Field | Value |
|-------|-------|
| **Task ID** | `task-1774237756461-m2q23d` |
| **Table** | `scheduled_tasks` in `store/messages.db` |
| **Group folder** | `ceo` |
| **Chat JID** | `tg:-5189591233` (Telegram) |
| **Schedule type** | `cron` |
| **Schedule value** | `*/30 * * * *` (every 30 minutes) |
| **Status** | `active` |
| **Created** | 2026-03-23T03:49:16.461Z |

### The Prompt

The scheduled task prompt instructs the CEO container agent to:

1. Fetch all completed sprints from Agency HQ (`GET /api/v1/sprints`)
2. Fetch already-processed sprint IDs from agent memory (`GET /api/v1/memory/ceo?project=retro-log-processed`)
3. Compare the two lists to find unprocessed sprints
4. **If no new sprints:** wrap entire output in `<internal>` tags so no Telegram message is sent
5. **If new sprints found:** generate a formatted retro report and send to Telegram

The prompt explicitly states:
> "IMPORTANT: If there are no new completed sprints to process, wrap your entire output in `<internal>` tags so no Telegram message is sent."

### Why the Message Leaks Through

The output pipeline strips `<internal>...</internal>` blocks via regex:

- **`src/router.ts:28`** — `stripInternalTags()`: `text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim()`
- **`src/router.ts:31-34`** — `formatOutbound()`: calls `stripInternalTags`, returns empty string if nothing remains
- **`src/lifecycle.ts:342`** — `sendMessage`: calls `formatOutbound`, skips send if result is empty

The stripping works correctly when the agent properly wraps its output. However, the agent (Claude running in a container) sometimes:
- Produces text **before** or **after** the `<internal>` block
- Doesn't close the `</internal>` tag properly
- Outputs the message as plain text without any `<internal>` wrapper

The `last_result` in the database (truncated to 200 chars) shows the agent sometimes outputs content that starts inside `<internal>` but the task-scheduler truncation makes it ambiguous whether the tag was properly closed.

### Secondary System: Sprint Retro Watcher (Not the Source)

There is also a separate **sprint retro watcher** subsystem (`src/sprint-retro-watcher.ts`) that:
- Polls every 5 minutes (`SPRINT_RETRO_INTERVAL = 5 * 60_000`)
- Checks Agency HQ for completed sprints
- Sends formatted retro reports directly (not through an agent)
- When no new sprints are found, it **silently returns** with only a debug log (line 242-246)

This watcher does NOT produce the message in question — it formats its own retro messages and uses a separate processed-sprint tracking mechanism (`/memory/ops?project=retro-processed` vs the agent's `/memory/ceo?project=retro-log-processed`).

## Mechanism Type

**Cron-scheduled task** — stored in SQLite `scheduled_tasks` table, executed by the task scheduler polling loop (`src/task-scheduler.ts:305-338`). Each execution spawns a CEO container agent that runs the retro check prompt.

## Trigger Frequency and Conditions

- **Frequency:** Every 30 minutes (`*/30 * * * *`)
- **Execution path:** `startSchedulerLoop()` → `getDueTasks()` → `runScheduledTask()` → `runContainerAgent()` → CEO container
- **Conditions for the message appearing:**
  1. The cron fires (every 30 min)
  2. The CEO container agent runs the retro check prompt
  3. Agency HQ returns completed sprints, but all are already in the processed list
  4. The agent generates a "no new sprints" response
  5. The agent **fails to properly wrap** its output in `<internal>` tags
  6. `formatOutbound()` sees non-empty text and delivers it to Telegram

## Recommendations

### Option 1: Disable the scheduled task (immediate fix)

Run this SQL against `store/messages.db`:

```sql
UPDATE scheduled_tasks SET status = 'paused' WHERE id = 'task-1774237756461-m2q23d';
```

This stops the cron from firing. The separate sprint retro watcher (`sprint-retro-watcher.ts`) will continue to handle actual retro reports when sprints complete.

### Option 2: Reduce frequency

```sql
UPDATE scheduled_tasks SET schedule_value = '0 */6 * * *' WHERE id = 'task-1774237756461-m2q23d';
```

This changes from every 30 minutes to every 6 hours, reducing noise.

### Option 3: Delete the task entirely

```sql
DELETE FROM scheduled_tasks WHERE id = 'task-1774237756461-m2q23d';
```

Safe to delete because the built-in `sprint-retro-watcher.ts` already handles the same functionality natively (every 5 minutes) without spawning a container agent.

### Option 4: Fix the no-op leak (code change)

Add a no-op result filter in `task-scheduler.ts` so that when a scheduled task's streamed result is entirely wrapped in `<internal>` tags (or matches known no-op patterns), suppress the message. This is a more robust fix than relying on the LLM to always follow formatting instructions.

### Recommended Approach

**Option 1 (pause) or Option 3 (delete)** — the scheduled task is redundant with the built-in `sprint-retro-watcher.ts` subsystem that:
- Runs every 5 minutes (more frequent)
- Sends formatted retro reports directly without spawning a container
- Silently returns when no new sprints are found (no message leak possible)
- Uses its own processed-sprint tracking via Agency HQ memory

The only difference is that the scheduled task writes retro data to agent memory (`retro-log` project) for the CEO agent to reference later, while the watcher only sends the formatted message. If this memory persistence is desired, the watcher could be enhanced to also write to agent memory.

## Duplicate System Note

There are **two independent systems** doing sprint retrospective checking:

| System | File | Interval | Mechanism |
|--------|------|----------|-----------|
| Sprint Retro Watcher | `src/sprint-retro-watcher.ts` | 5 min | Built-in setInterval, direct message |
| Scheduled Task | SQLite `scheduled_tasks` | 30 min | Cron, spawns CEO container agent |

They use **different** processed-sprint tracking keys:
- Watcher: `project=retro-processed` (via `/memory/ops`)
- Scheduled task: `project=retro-log-processed` (via `/memory/ceo`)

This duplication should be consolidated.
