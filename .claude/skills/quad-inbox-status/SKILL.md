---
name: quad-inbox-status
description: List and triage all pending files in the quad-inbox directory, including deferred tasks.
user_invocable: true
---

# Quad Inbox Status

Show the full state of the quad-inbox without executing anything.

## Steps

### 1. Active tasks

List all `.md` files in `groups/main/quad-inbox/` (excluding `responses/` and `deferred/`). For each file, show:
- File name
- First heading or first line as description

If empty, say "No active tasks."

### 2. Deferred tasks

List all `.md` files in `groups/main/quad-inbox/deferred/`. For each file, show:
- File name
- First heading or first line as description

If empty, say "No deferred tasks."

### 3. Response reports

List all `.md` files in `groups/main/quad-inbox/responses/`. For each file, show:
- File name
- First heading or first line as description

If empty, say "No pending reports."

### 4. Summary

Present the counts: "X active, Y deferred, Z reports."

If the user wants to move a task between active and deferred, do it with a simple `mv` command.
