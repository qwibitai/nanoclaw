---
name: gtasks-cli
description: Manage Google Tasks from the command line - view, create, update, delete tasks and task lists. Use when the user asks to interact with Google Tasks, manage to-do items, create task lists, mark tasks complete, or check their Google Tasks.
license: MIT
allowed-tools: Bash(gtasks:*)
---

# Google Tasks CLI Skill

Manages Google Tasks via the `gtasks` binary (pre-installed at `/usr/local/bin/gtasks`).

## IMPORTANT: How credentials work in this environment

Credentials are NOT passed as environment variables by the NanoClaw runtime. They live in a mounted file:

- `~/.gtasks/env` — contains `GTASKS_CLIENT_ID` and `GTASKS_CLIENT_SECRET`
- `~/.gtasks/token.json` — OAuth2 token, generated on the host via `gtasks login`

**Every gtasks command must be prefixed with `source ~/.gtasks/env &&`:**

```bash
source ~/.gtasks/env && gtasks tasklists view
source ~/.gtasks/env && gtasks tasks view
source ~/.gtasks/env && gtasks tasks add -t "My task" -l "Work"
```

Without the `source` prefix, gtasks fails even if the token file exists.

**Never run `gtasks login` from this container.** Login requires an interactive browser. Authentication is done on the host Mac. The token is already present at `~/.gtasks/token.json`.

## Verify setup

```bash
[ -f ~/.gtasks/env ] && echo "OK: env file found" || echo "ERROR: ~/.gtasks/env missing"
[ -f ~/.gtasks/token.json ] && echo "OK: token found" || echo "ERROR: token missing — run gtasks login on host"
source ~/.gtasks/env && gtasks tasklists view
```

## Task Lists

```bash
source ~/.gtasks/env && gtasks tasklists view
source ~/.gtasks/env && gtasks tasklists add -t "New List"
source ~/.gtasks/env && gtasks tasklists update -t "Renamed List"
source ~/.gtasks/env && gtasks tasklists rm
```

## Tasks

```bash
# View
source ~/.gtasks/env && gtasks tasks view
source ~/.gtasks/env && gtasks tasks view -l "Work"
source ~/.gtasks/env && gtasks tasks view -l "Work" --sort=due
source ~/.gtasks/env && gtasks tasks view -l "Work" --include-completed
source ~/.gtasks/env && gtasks tasks view -l "Work" --format=json

# Create
source ~/.gtasks/env && gtasks tasks add -t "Title" -l "Work"
source ~/.gtasks/env && gtasks tasks add -t "Title" -l "Work" -n "Notes" -d "2025-03-01"
source ~/.gtasks/env && gtasks tasks add -t "Title" -l "Work" -d "tomorrow"
source ~/.gtasks/env && gtasks tasks add -t "Title" -l "Work" -d "next Friday"

# Complete / delete / details
source ~/.gtasks/env && gtasks tasks done 1 -l "Work"
source ~/.gtasks/env && gtasks tasks rm 1 -l "Work"
source ~/.gtasks/env && gtasks tasks info 1 -l "Work"
```

Flags: `-t` title, `-n` notes, `-d` due date, `-l` list name (avoids interactive prompt).

## Error handling

- **Authentication error / "Failed to get service"**: forgot `source ~/.gtasks/env &&`
- **"incorrect task-list name"**: run `gtasks tasklists view` to check exact name
- **"Incorrect task number"**: run `gtasks tasks view` to get current numbers (they change after modifications)
- **Token expired**: ask the user to run `source ~/.gtasks/env && gtasks login` on their Mac
