---
description: Pick one Ready for Dispatch NanoClaw Platform issue, implement it, test it, and hand it to Codex review.
allowed-tools: Read,Grep,Glob,Edit,Write,Bash(node scripts/workflow/platform-loop.js:*),Bash(gh api:*),Bash(gh issue:*),Bash(gh pr:*),Bash(git status),Bash(git switch:*),Bash(git checkout:*),Bash(git add:*),Bash(git commit:*),Bash(git push:*),Bash(npm run build),Bash(npm test)
---

Run the NanoClaw Platform autonomous pickup flow.

Requirements:

1. Never pick work outside the `NanoClaw Platform` board.
2. Never pick work unless the helper reports exactly one eligible item.
3. Never continue if another item is already `Claude Running` or `Review Queue`.
4. Never guess missing scope. Move the issue to `Blocked` instead.
5. Never merge. Hand off to Codex review.

Execution flow:

1. Run `node scripts/workflow/platform-loop.js next`.
2. If the result is `{ "action": "noop" }`, summarize the reason in one sentence and stop.
3. Read the selected GitHub Issue fully and obey its scope boundary, required checks, required evidence, and blocked conditions.
4. Run `node scripts/workflow/platform-loop.js ids --issue <issue-number> --title "<issue-title>"` and capture `requestId`, `runId`, and `branch`.
5. Move the board item to `Claude Running`:
   - `node scripts/workflow/platform-loop.js set-status --issue <issue-number> --status "Claude Running" --agent claude --review-lane codex --request-id "<requestId>" --run-id "<runId>" --next-decision "Claude to open PR with evidence for Codex review"`
6. Switch to the generated branch, creating it if needed from `main`.
7. Implement only the scoped change.
8. Run all checks required by the Issue. If the Issue is incomplete or the checks fail:
   - move the item to `Blocked`
   - set a concrete `Next Decision`
   - stop
9. Open or update a PR linked to the issue.
10. Ensure the PR body includes:
   - linked work item
   - summary
   - verification evidence
   - risks and rollback
11. Move the board item to `Review Queue`:
   - `node scripts/workflow/platform-loop.js set-status --issue <issue-number> --status "Review Queue" --agent claude --review-lane codex --request-id "<requestId>" --run-id "<runId>" --next-decision "Codex to review, patch if needed, and confirm merge readiness"`
12. End with a concise review handoff for Codex, including issue number, branch, PR URL, checks run, and any known risks.

Blocked-state rule:

- If any required issue section is missing, or you cannot complete the requested checks, immediately move the item to `Blocked` with the shortest truthful reason and stop.
