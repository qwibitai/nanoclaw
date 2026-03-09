---
description: Pick one Ready NanoClaw Platform issue, implement it, test it, and hand it to Codex review.
allowed-tools: Read,Grep,Glob,Edit,Write,Bash(bash scripts/workflow/platform-loop-sync.sh:*),Bash(node scripts/workflow/platform-loop.js:*),Bash(gh auth:*),Bash(gh api:*),Bash(gh issue:*),Bash(gh pr:*),Bash(git status),Bash(git switch:*),Bash(git checkout:*),Bash(git add:*),Bash(git commit:*),Bash(git push:*),Bash(npm run build),Bash(npm test)
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
2. Refresh the dedicated loop worktree from the configured remote base before picking work:
   - run `bash scripts/workflow/platform-loop-sync.sh`
   - if the sync fails, stop immediately instead of using stale code
3. Run `node scripts/workflow/platform-loop.js next`.
4. If the result is `{ "action": "noop" }`, summarize the reason in one sentence and stop.
5. Read the selected GitHub Issue fully and obey its scope boundary, required checks, required evidence, and blocked conditions.
6. Run `node scripts/workflow/platform-loop.js ids --issue <issue-number> --title "<issue-title>"` and capture `requestId`, `runId`, and `branch`.
7. Move the board item to `In Progress` and set `Agent=claude`:
   - `node scripts/workflow/platform-loop.js set-status --issue <issue-number> --status "In Progress" --agent claude --review-lane codex --request-id "<requestId>" --run-id "<runId>" --next-decision "Claude to open PR with evidence for Codex review"`
8. Immediately leave an issue comment proving Claude claimed the work:
   - include `request_id`, `run_id`, branch name, current board status, and the next visible step
   - if the board is missing the text fields, the comment becomes the authoritative visibility record until the board schema is fixed
9. Switch to the generated branch, creating it from the freshly synced loop base (`origin/main` via `claude-platform-loop`) if needed.
10. Implement only the scoped change.
11. Run all checks required by the Issue. If the Issue is incomplete or the checks fail:
   - move the item to `Blocked`
   - leave an issue comment with the shortest truthful blocked reason, the failed check if any, and the exact `Next Decision`
   - set a concrete `Next Decision`
   - stop
12. Open or update a PR linked to the issue.
13. Ensure the PR body includes:
   - linked work item
   - summary
   - verification evidence
   - risks and rollback
14. Move the board item to `Review`:
   - `node scripts/workflow/platform-loop.js set-status --issue <issue-number> --status "Review" --agent claude --review-lane codex --request-id "<requestId>" --run-id "<runId>" --next-decision "Codex to review, patch if needed, and confirm merge readiness"`
15. Leave an issue comment for the review handoff:
   - include branch, PR URL, `request_id`, `run_id`, checks run, and any known risks
16. End with a concise review handoff for Codex, including issue number, branch, PR URL, checks run, and any known risks.

Blocked-state rule:

- If any required issue section is missing, or you cannot complete the requested checks, immediately move the item to `Blocked`, comment the issue with the failure context, and stop.
