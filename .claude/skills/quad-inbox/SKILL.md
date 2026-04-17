---
name: quad-inbox
description: Read and execute instructions left by the container agent in the quad-inbox directory. Use when the agent says it left instructions for Quad.
user_invocable: true
---

# Quad Inbox

Read and execute pending task files from the container agent.

## Steps

### 1. Scan for tasks

List all `.md` files in `groups/main/quad-inbox/`. Exclude `responses/` (outbound reports) and `deferred/` (parked tasks). If empty, tell the user "No pending instructions" and stop.

### 2. Triage

Read ALL task files before executing any. Present the user with a numbered summary:
- File name
- One-line description
- Priority: `URGENT` if the filename or first heading contains "urgent" or "critical" (case-insensitive), otherwise `normal`

**Check for conflicts:** If two tasks modify the same file or contradict each other (e.g., one says "rollback" and another says "restyle"), flag the conflict and ask the user which to execute. Do not silently apply both.

**Check for duplicates:** If a task asks for a change that is already present in the source code (e.g., an import already exists, a hook is already called), note this in the summary as "appears already applied — will verify."

**Deferred tasks:** After listing active tasks, note the count of deferred tasks at the bottom (e.g., "Also: 3 deferred tasks in deferred/"). Do not process deferred tasks unless the user asks.

Process `URGENT` tasks first, then `normal` tasks in alphabetical order.

### 3. Pre-flight review

For each task, before making any changes:
1. Read the entire task file
2. Identify all files that will be modified
3. Read the current state of those files
4. If the requested change is already present in the source, skip the edit and note "already applied" — but still run verification (step 5)
5. If anything looks wrong — bad file paths, logic that won't work, changes that could break something — write a brief note back to the quad-inbox explaining the issue instead of proceeding. Do NOT attempt changes you're unsure about.

### 4. Execute

Apply the changes described in the task file. Follow the task's instructions faithfully.

**Build rules:**
- Run `npm run build` after any TypeScript/JavaScript file changes. If the build fails, fix the error before proceeding. Do not delete the task file until the build passes.
- Restart NanoClaw (`systemctl --user restart nanoclaw`) if any `src/` files or service configs were changed.

### 5. Verify

Before deleting a task file, verify the result:
- If the task specifies a verification step, run it
- If the task involved a build, confirm the build passed
- If the task involved a deploy, confirm the new content is live
- If the task involved a service restart, confirm the service is running

### 6. Clean up

Delete the task file only after verification passes. Report what was done for each task.

### 7. Result reporting

If a task's outcome needs to be communicated back to the container agent, write a response file to `quad-inbox/responses/` with a descriptive name like `report-<topic>.md`. Tell the user a report was left for the agent.

## Deferred tasks

Tasks can be moved to `quad-inbox/deferred/` when they are:
- Blocked on an external dependency (e.g., waiting for an API key)
- Explicitly deferred by the user ("not now", "do this later")
- Not actionable in the current session (e.g., requires hardware not available)

The `deferred/` subdirectory is invisible to the scan step — glob doesn't recurse into it. This keeps the active inbox clean without losing information. To review deferred tasks, use `/quad-inbox-status`.

## Error handling

- If a task fails, stop processing and report the error. Do NOT delete the file.
- If the build fails after edits, attempt to fix the build error. If you can't fix it, revert the changes, leave the task file, and report what went wrong.

## Notes

- Task files may contain a "BEFORE EXECUTING" preamble — this is the agent asking you to review before acting. Always honor it.
- Multiple tasks in one batch are independent unless they explicitly reference each other. Complete each fully before starting the next.
