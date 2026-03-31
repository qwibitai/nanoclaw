---
name: quad-inbox
description: "Read and execute instructions left by the container agent in the quad-inbox directory. Use when the agent says it left instructions for Quad."
user_invocable: true
---

# Quad Inbox

Read and execute pending task files from the container agent.

## Steps

### 1. Scan for tasks

List all `.md` files in `groups/main/quad-inbox/`. If empty, tell the user "No pending instructions" and stop.

### 2. Triage

Read ALL task files before executing any. Present the user with a numbered summary:
- File name
- One-line description
- Priority: `URGENT` if the filename or first heading contains "urgent" or "critical" (case-insensitive), otherwise `normal`

**Check for conflicts:** If two tasks modify the same file or contradict each other (e.g., one says "rollback" and another says "restyle"), flag the conflict and ask the user which to execute. Do not silently apply both.

**Check for duplicates:** If a task asks for a change that is already present in the source code (e.g., an import already exists, a hook is already called), note this in the summary as "appears already applied — will verify."

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

**Deploy rules:**
- If the task says "deploy to Cloudflare Pages" or similar, run the standard deploy sequence for the project. For the sovereignty badges app:
  ```bash
  rm -rf /tmp/sovereignty-deploy/app
  mkdir -p /tmp/sovereignty-deploy/app
  cp -r dist/* /tmp/sovereignty-deploy/app/
  rm -f /tmp/sovereignty-deploy/app/_redirects
  npx wrangler pages deploy /tmp/sovereignty-deploy --project-name sovereignty-by-design
  ```
- After deploying, verify the new bundle hash is live by checking what the production URL serves.

### 5. Verify

Before deleting a task file, verify the result:
- If the task specifies a verification step, run it
- If the task involved a build, confirm the build passed
- If the task involved a deploy, confirm the new content is live (e.g., check the deployed bundle hash or curl a known endpoint)
- If the task involved a service restart, confirm the service is running

### 6. Clean up

Delete the task file only after verification passes. Report what was done for each task.

### 7. Result reporting

If a task's outcome needs to be communicated back to the container agent (e.g., something couldn't be done, a question needs answering, or the agent asked for confirmation), write a response file to the same `quad-inbox/` directory with a descriptive name like `report-<topic>.md`. Tell the user a report was left for the agent.

## Error handling

- If a task fails, stop processing and report the error. Do NOT delete the file.
- If the build fails after edits, attempt to fix the build error. If you can't fix it, revert the changes, leave the task file, and report what went wrong.
- If a deploy fails, do not delete the task file. Report the deploy error.

## Notes

- Task files may contain a "BEFORE EXECUTING" preamble — this is the agent asking you to review before acting. Always honor it.
- The agent's `BadgeDef` type (from `useBadgeDefinitions()`) uses `type: 'human'|'agent'` and `tier: 'foundation'|'sovereign'`. The old static `BADGES` constant uses `track` and numeric `tier`. Be aware of this when the agent references badge fields.
- Multiple tasks in one batch are independent unless they explicitly reference each other. Complete each fully before starting the next.
