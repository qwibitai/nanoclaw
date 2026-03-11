---
description: Pick one Ready NanoClaw Platform issue, implement it, test it, and hand it to Codex review.
allowed-tools: Read,Grep,Glob,Edit,Write,Bash(bash scripts/workflow/autonomy-lane.sh:*),Bash(bash scripts/workflow/platform-loop-sync.sh:*),Bash(node scripts/workflow/platform-loop.js:*),Bash(gh auth:*),Bash(gh api:*),Bash(gh issue:*),Bash(gh pr:*),Bash(git status),Bash(git switch:*),Bash(git checkout:*),Bash(git add:*),Bash(git commit:*),Bash(git push:*),Bash(npm run build),Bash(npm test)
---

Run the NanoClaw Platform hourly autonomous pickup flow.

Requirements:

1. Never pick work outside the `NanoClaw Platform` board.
2. Never pick work unless the helper reports exactly one eligible item.
3. Never continue if `bash scripts/workflow/autonomy-lane.sh pause-status` reports `"paused": true`.
4. Never continue if another Claude-owned item is already `In Progress` or `Review`.
5. Never guess missing scope. Move the issue to `Blocked` instead.
6. Never merge. Hand off to Codex review.

Execution flow:

1. Confirm the active GitHub account for the NanoClaw platform board:
   - run `gh api user -q .login`
   - if the result is not `ingpoc`, run `gh auth switch --user ingpoc`
   - rerun `gh api user -q .login` and stop if it is still not `ingpoc`
2. Provision a fresh ephemeral pickup worktree from the configured remote base before picking work:
   - run `bash scripts/workflow/platform-loop-sync.sh`
   - if the sync fails, stop immediately instead of using stale code
3. Run `bash scripts/workflow/autonomy-lane.sh pause-status` and stop with a one-line reason if pickup is paused.
4. Run `node scripts/workflow/platform-loop.js next`.
5. If the result is `{ "action": "noop" }`, summarize the reason in one sentence and stop.
6. Read the selected GitHub Issue fully and obey its scope boundary, required checks, required evidence, and blocked conditions.
7. Run `node scripts/workflow/platform-loop.js ids --issue <issue-number> --title "<issue-title>"` and capture `requestId`, `runId`, and `branch`.
8. Move the board item to `In Progress` and set `Agent=claude`:
   - `node scripts/workflow/platform-loop.js set-status --issue <issue-number> --status "In Progress" --agent claude --review-lane codex --request-id "<requestId>" --run-id "<runId>" --next-decision "Claude to open PR with evidence for Codex review"`
9. Immediately leave an issue comment proving Claude claimed the work:
   - include `request_id`, `run_id`, branch name, current board status, and the next visible step
   - if the board is missing the text fields, the comment becomes the authoritative visibility record until the board schema is fixed
10. Switch to the generated branch, creating it from the freshly synced loop base (`origin/main` via `claude-platform-loop`) if needed.
11. Implement only the scoped change.
12. Run all checks required by the Issue. If the Issue is incomplete or the checks fail:
   - move the item to `Blocked`
   - leave an issue comment with the shortest truthful blocked reason, the failed check if any, and the exact `Next Decision`
   - set a concrete `Next Decision`
   - stop
13. Open or update a PR linked to the issue.
14. Ensure the PR body includes:
   - linked work item
   - summary
   - verification evidence
   - risks and rollback
15. Move the board item to `Review`:
   - `node scripts/workflow/platform-loop.js set-status --issue <issue-number> --status "Review" --agent claude --review-lane codex --request-id "<requestId>" --run-id "<runId>" --next-decision "Codex to review, patch if needed, and confirm merge readiness"`
16. Leave an issue comment for the review handoff:
   - include branch, PR URL, `request_id`, `run_id`, checks run, and any known risks
17. End with a concise review handoff for Codex, including issue number, branch, PR URL, checks run, and any known risks.

Review boundary:

- Codex is the only lane that can declare the PR `ready-for-user-merge`.
- If reliability creates a global pause after the PR is opened, do not merge or reprioritize; leave the PR in `Review` and stop.

Cleanup rule:

- The session runner removes the ephemeral worktree automatically after Claude exits if the worktree is clean.
- If the worktree is left dirty because the run stopped mid-change, leave it in place and report the path in the final blocker/handoff note.

Cleanup rule:

- The session runner removes the ephemeral worktree automatically after Claude exits if the worktree is clean.
- If the worktree is left dirty because the run stopped mid-change, leave it in place and report the path in the final blocker/handoff note.

Blocked-state rule:

- If any required issue section is missing, or you cannot complete the requested checks, immediately move the item to `Blocked`, comment the issue with the failure context, and stop.
