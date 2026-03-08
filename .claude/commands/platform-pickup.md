---
description: Pick one Ready NanoClaw Platform issue, implement it, test it, and hand it to Codex review.
allowed-tools: Read,Grep,Glob,Edit,Write,Bash(node scripts/workflow/platform-loop.js:*),Bash(gh auth:*),Bash(gh api:*),Bash(gh issue:*),Bash(gh pr:*),Bash(git status),Bash(git switch:*),Bash(git checkout:*),Bash(git add:*),Bash(git commit:*),Bash(git push:*),Bash(npm run build),Bash(npm test)
---

Run the NanoClaw Platform autonomous pickup flow.

Requirements:

1. Never pick work outside the `NanoClaw Platform` board.
2. Never pick work unless the helper reports exactly one eligible item.
3. Never continue if another Claude-owned item is already `In Progress` or `Review`.
4. Never guess missing scope. Move the issue to `Blocked` instead.
5. Never merge. Hand off to Codex review.

Execution flow:

1. Confirm the active GitHub account for the NanoClaw platform board:
   - run `gh api user -q .login`
   - if the result is not `ingpoc`, run `gh auth switch --user ingpoc`
   - rerun `gh api user -q .login` and stop if it is still not `ingpoc`
2. Run `node scripts/workflow/platform-loop.js next`.
3. If the result is `{ "action": "noop" }`, summarize the reason in one sentence and stop.
4. Read the selected GitHub Issue fully and obey its scope boundary, required checks, required evidence, and blocked conditions.
5. Run `node scripts/workflow/platform-loop.js ids --issue <issue-number> --title "<issue-title>"` and capture `requestId`, `runId`, and `branch`.
6. Move the board item to `In Progress` and set `Agent=claude`:
   - `node scripts/workflow/platform-loop.js set-status --issue <issue-number> --status "In Progress" --agent claude --review-lane codex --request-id "<requestId>" --run-id "<runId>" --next-decision "Claude to open PR with evidence for Codex review"`
7. Switch to the generated branch, creating it if needed from `main`.
8. Implement only the scoped change.
9. Run all checks required by the Issue. If the Issue is incomplete or the checks fail:
   - move the item to `Blocked`
   - set a concrete `Next Decision`
   - stop
10. Open or update a PR linked to the issue.
11. Ensure the PR body includes:
   - linked work item
   - summary
   - verification evidence
   - risks and rollback
12. Move the board item to `Review`:
   - `node scripts/workflow/platform-loop.js set-status --issue <issue-number> --status "Review" --agent claude --review-lane codex --request-id "<requestId>" --run-id "<runId>" --next-decision "Codex to review, patch if needed, and confirm merge readiness"`
13. End with a concise review handoff for Codex, including issue number, branch, PR URL, checks run, and any known risks.

Blocked-state rule:

- If any required issue section is missing, or you cannot complete the requested checks, immediately move the item to `Blocked` with the shortest truthful reason and stop.
