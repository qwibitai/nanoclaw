---
name: add-vikunja
description: Add Vikunja task management integration to NanoClaw. Lets the container agent list projects, create and update tasks, mark tasks complete, add comments, and assign tasks across personal and shared projects via the Vikunja v1 REST API.
---

# Add Vikunja Integration

This skill adds a stdio-based MCP server that exposes the Vikunja v1 REST API as tools for the container agent. Useful for letting the agent manage its own task list, triage incoming requests into a real task tracker, and coordinate with humans who also use Vikunja.

Tools added:

**Projects**
- `vikunja_list_projects` — list all projects the token has access to (id, title, description). Call this first to discover project ids.

**Tasks**
- `vikunja_list_tasks` — list tasks in a project. Params: `project_id`, optional `include_done` (default true), optional `page`. Returns id, title, description, done, due_date, priority, assignees.
- `vikunja_get_task` — get full detail for a single task by id
- `vikunja_create_task` — create a task. Params: `project_id`, `title`, optional `description`, `due_date` (ISO8601), `priority` (0–5), `assignees` (array of user ids). Assignees are added via a follow-up API call and the re-fetched task is returned.
- `vikunja_update_task` — update any subset of fields on a task. Pass `done: true` to mark complete. Pass `assignees` to replace the full assignee list (empty array removes all).
- `vikunja_delete_task` — delete a task by id. Irreversible.

**Comments**
- `vikunja_list_comments` — list all comments on a task
- `vikunja_add_comment` — add a comment. Supports Markdown.

**Users**
- `vikunja_get_current_user` — get the user account that owns the current API token (id, username, email). **Call this once at the start of a session to discover your own user id** — you'll need it for `assignees` parameters on create/update.

## Auth

Personal API token from Vikunja:

1. Log in to Vikunja as the agent's user (e.g. `k2`)
2. Go to **Settings → API Tokens**
3. Create a new token with the following permissions:
   - Projects: read
   - Tasks: read, write, update, delete
   - Task comments: read, write
   - Task assignees: read, write, delete
   - User: read
4. Copy the token (it's shown only once)

## Env vars required

- `VIKUNJA_URL` — base URL of the Vikunja instance, e.g. `http://vikunja:3456` or `https://tasks.example.com`. No trailing slash.
- `VIKUNJA_TOKEN` — personal API token from the step above. Marked as a secret and redacted from container debug logs.

Both are included in `MCP_SKILL_ENV_KEYS` in `src/container-runner.ts` so they're forwarded from the NanoClaw process into agent containers automatically (no per-skill wiring needed beyond setting them on the host `.env`).

## Usage tips for k2

1. **First use:** call `vikunja_get_current_user` and remember the returned `id` — you'll need it for `assignees: [<your_id>]` when creating tasks assigned to yourself.
2. **Discovery flow:** `vikunja_list_projects` → pick a project → `vikunja_list_tasks({ project_id, include_done: false })` to see what's open.
3. **Marking done:** `vikunja_update_task({ task_id, done: true })`. The task object returned will reflect the updated state.
4. **Priority scale:** 0 (none), 1 (low), 2 (medium), 3 (high), 4 (urgent), 5 (do now).
5. **Due dates:** always ISO8601 with an explicit `Z` or offset, e.g. `2026-04-15T09:00:00Z`.

## Verification

After setup, restart NanoClaw and ask the agent to run `vikunja_list_projects`. A configured instance should return a non-empty array of projects. If you see `Error: VIKUNJA_URL and VIKUNJA_TOKEN must be set`, the env vars haven't reached the container — check the host `.env` and restart.
