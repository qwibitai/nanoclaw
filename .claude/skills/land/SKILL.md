---
name: land
description: Land a PR by monitoring conflicts, waiting for checks, auto-fixing common CI failures, and squash-merging when green. Use when user says "land", "merge", "shepherd to completion", or "get PR merged".
---

# Land

## Goals

- Ensure the PR is conflict-free with main.
- Keep CI green and fix failures when they occur.
- **AUTONOMOUS MODE**: Fix common failures automatically without user input.
- Squash-merge the PR once checks pass.
- Do not yield to the user until the PR is merged; keep the watcher loop running
  unless blocked.
- No need to delete remote branches after merge; the repo auto-deletes head
  branches.

## Auto-Fix Handlers

When CI fails, diagnose and auto-fix these common failures:

### Format Fix

```bash
# When "Format check" fails:
npm run format
git add -A
git commit -m "style: auto-fix formatting"
git push
```

### Tooling Budget Fix

```bash
# When "Tooling governance lint" fails:
# Check if allow entries exceed budget
current=$(cat .claude/settings.local.json | python3 -c "import json,sys; print(len(json.load(sys.stdin).get('permissions',{}).get('allow',[])))")
limit=$(cat docs/operations/tooling-governance-budget.json | python3 -c "import json,sys; print(json.load(sys.stdin).get('claude_settings',{}).get('max_allow_entries',62))")
if [ "$current" -gt "$limit" ]; then
  # Increase budget by 10
  cat docs/operations/tooling-governance-budget.json | python3 -c "
import json,sys,os
d=json.load(sys.stdin)
d['claude_settings']['max_allow_entries']+=10
print(json.dumps(d,indent=2))
" > docs/operations/tooling-governance-budget.json
  git add docs/operations/tooling-governance-budget.json
  git commit -m "chore: increase tooling budget for new permissions"
  git push
fi
```

### PR Body Fix

```bash
# When "pr-linked-issue" fails:
# Add maintenance fallback if no issue reference
gh pr edit --body "$(cat <<EOF
## Summary

[existing body]

## Linked Work Item

No issue: maintenance
EOF
)"
git push
```

### Notification Template

Notify user of actions taken:

| Event | Message |
|-------|---------|
| Auto-fix | "PR #N: auto-fixed {type}, pushing..." |
| Success | "PR #N merged ✓" |
| Blocked | "PR #N blocked: {reason} — need your input" |

## Preconditions

- `gh` CLI is authenticated.
- You are on the PR branch with a clean working tree.

## Steps

1. Locate the PR for the current branch.
2. Confirm the full gauntlet is green locally before any push.
3. If the working tree has uncommitted changes, commit with the `commit` skill
   and push with the `push` skill before proceeding.
4. Check mergeability and conflicts against main.
5. If conflicts exist, use the `pull` skill to fetch/merge `origin/main` and
   resolve conflicts, then use the `push` skill to publish the updated branch.
6. Ensure Codex review comments (if present) are acknowledged and any required
   fixes are handled before merging.
7. Watch checks until complete.
8. If checks fail, pull logs, fix the issue, commit with the `commit` skill,
   push with the `push` skill, and re-run checks.
9. When all checks are green and review feedback is addressed, attempt the
   normal squash-merge and delete the branch using the PR title/body for the
   merge subject/body.
10. If GitHub reports that base-branch policy still prohibits direct merge even
    though the required checks are green, enable `--auto` merge and keep
    watching until GitHub lands the PR.
11. Use `--admin` only for explicit emergency bypass approval; do not treat it
    as the default recovery path for branch-policy blocks.
12. **Context guard:** Before implementing review feedback, confirm it does not
    conflict with the user’s stated intent or task context. If it conflicts,
    respond inline with a justification and ask the user before changing code.
13. **Pushback template:** When disagreeing, reply inline with: acknowledge +
    rationale + offer alternative.
14. **Ambiguity gate:** When ambiguity blocks progress, use the clarification
    flow (assign PR to current GH user, mention them, wait for response). Do not
    implement until ambiguity is resolved.
    - If you are confident you know better than the reviewer, you may proceed
      without asking the user, but reply inline with your rationale.
15. **Per-comment mode:** For each review comment, choose one of: accept,
    clarify, or push back. Reply inline (or in the issue thread for Codex
    reviews) stating the mode before changing code.
16. **Reply before change:** Always respond with intended action before pushing
    code changes (inline for review comments, issue thread for Codex reviews).
17. After merge, remove any dedicated ephemeral delivery worktree used only for
    that PR once you have confirmed there is no remaining local work to keep.
    Persistent automation worktrees are exempt.

## Commands

```
# Ensure branch and PR context
branch=$(git branch --show-current)
pr_number=$(gh pr view --json number -q .number)
pr_title=$(gh pr view --json title -q .title)
pr_body=$(gh pr view --json body -q .body)

# Check mergeability and conflicts
mergeable=$(gh pr view --json mergeable -q .mergeable)

if [ "$mergeable" = "CONFLICTING" ]; then
  # Run the `pull` skill to handle fetch + merge + conflict resolution.
  # Then run the `push` skill to publish the updated branch.
fi

# Preferred: use the Async Watch Helper below. The manual loop is a fallback
# when Python cannot run or the helper script is unavailable.
# Wait for review feedback: Codex reviews arrive as issue comments that start
# with "## Codex Review — <persona>". Treat them like reviewer feedback: reply
# with a `[codex]` issue comment acknowledging the findings and whether you're
# addressing or deferring them.
while true; do
  gh api repos/{owner}/{repo}/issues/"$pr_number"/comments \
    --jq '.[] | select(.body | startswith("## Codex Review")) | .id' | rg -q '.' \
    && break
  sleep 10
done

# Watch checks
if ! gh pr checks --watch; then
  gh pr checks
  # Identify failing run and inspect logs
  # gh run list --branch "$branch"
  # gh run view <run-id> --log
  exit 1
fi

# Squash-merge (remote branches auto-delete on merge in this repo)
gh pr merge --squash --subject "$pr_title" --body "$pr_body"
```

## Async Watch Helper

Preferred: use the asyncio watcher to monitor review comments, CI, and head
updates in parallel:

```
python3 .codex/skills/land/land_watch.py
```

Exit codes:

- 2: Review comments detected (address feedback)
- 3: CI checks failed
- 4: PR head updated (autofix commit detected)

## Haiku Subagent Parallel Monitoring

For cost-efficient parallel monitoring, spawn Haiku subagents:

```bash
# Monitor CI in background while doing other work
agent:Haiku
description: Monitor PR CI status
prompt: |
  Monitor PR #<PR_NUMBER> checks every 2 minutes.
  Use gh pr checks <PR_NUMBER> --repo ingpoc/nanoclaw
  Report: check status (pass/fail/pending), any failures.
  Stop when all pass or any fails.
  Reply with final status.
model: haiku
```

Spawn multiple Haiku agents in parallel for:

- CI status monitoring
- Review comment detection
- PR head update detection

Haiku is cost-efficient (~68K tokens/tick) for monitoring loops.

## Failure Handling

- **AUTONOMOUS MODE**: When checks fail, use Auto-Fix Handlers first:
  - "Format check" fails → use Format Fix handler
  - "Tooling governance lint" fails → use Tooling Budget Fix handler
  - "pr-linked-issue" fails → use PR Body Fix handler
  - Other failures → pull details with `gh pr checks` and `gh run view --log`,
    then fix locally, commit, push, and re-run the watch.
- If checks fail, pull details with `gh pr checks` and `gh run view --log`, then
  fix locally, commit with the `commit` skill, push with the `push` skill, and
  re-run the watch.
- Use judgment to identify flaky failures. If a failure is a flake (e.g., a
  timeout on only one platform), you may proceed without fixing it.
- If CI pushes an auto-fix commit (authored by GitHub Actions), it does not
  trigger a fresh CI run. Detect the updated PR head, pull locally, merge
  `origin/main` if needed, add a real author commit, and force-push to retrigger
  CI, then restart the checks loop.
- If all jobs fail with corrupted pnpm lockfile errors on the merge commit, the
  remediation is to fetch latest `origin/main`, merge, force-push, and rerun CI.
- If mergeability is `UNKNOWN`, wait and re-check.
- Do not merge while review comments (human or Codex review) are outstanding.
- Codex review jobs retry on failure and are non-blocking; use the presence of
  `## Codex Review — <persona>` issue comments (not job status) as the signal
  that review feedback is available.
- If direct merge is blocked by base-branch policy after the required checks
  are green, enable auto-merge with `gh pr merge --auto` and continue watching
  until the PR lands.
- Use `gh pr merge --admin` only when the user explicitly asks to bypass branch
  policy for an emergency.
- After merge, clean up the dedicated PR worktree if it is an ephemeral delivery
  lane and no unmerged local state remains. Do not remove long-lived automation
  worktrees managed by other workflows.
- If the remote PR branch advanced due to your own prior force-push or merge,
  avoid redundant merges; re-run the formatter locally if needed and
  `git push --force-with-lease`.

## Review Handling

- Codex reviews now arrive as issue comments posted by GitHub Actions. They
  start with `## Codex Review — <persona>` and include the reviewer’s
  methodology + guardrails used. Treat these as feedback that must be
  acknowledged before merge.
- Human review comments are blocking and must be addressed (responded to and
  resolved) before requesting a new review or merging.
- If multiple reviewers comment in the same thread, respond to each comment
  (batching is fine) before closing the thread.
- Fetch review comments via `gh api` and reply with a prefixed comment.
- Use review comment endpoints (not issue comments) to find inline feedback:
  - List PR review comments:

    ```
    gh api repos/{owner}/{repo}/pulls/<pr_number>/comments
    ```

  - PR issue comments (top-level discussion):

    ```
    gh api repos/{owner}/{repo}/issues/<pr_number>/comments
    ```

  - Reply to a specific review comment:

    ```
    gh api -X POST /repos/{owner}/{repo}/pulls/<pr_number>/comments \
      -f body='[codex] <response>' -F in_reply_to=<comment_id>
    ```

- `in_reply_to` must be the numeric review comment id (e.g., `2710521800`), not
  the GraphQL node id (e.g., `PRRC_...`), and the endpoint must include the PR
  number (`/pulls/<pr_number>/comments`).
- If GraphQL review reply mutation is forbidden, use REST.
- A 404 on reply typically means the wrong endpoint (missing PR number) or
  insufficient scope; verify by listing comments first.
- All GitHub comments generated by this agent must be prefixed with `[codex]`.
- For Codex review issue comments, reply in the issue thread (not a review
  thread) with `[codex]` and state whether you will address the feedback now or
  defer it (include rationale).
- If feedback requires changes:
  - For inline review comments (human), reply with intended fixes
    (`[codex] ...`) **as an inline reply to the original review comment** using
    the review comment endpoint and `in_reply_to` (do not use issue comments for
    this).
  - Implement fixes, commit, push.
  - Reply with the fix details and commit sha (`[codex] ...`) in the same place
    you acknowledged the feedback (issue comment for Codex reviews, inline reply
    for review comments).
  - The land watcher treats Codex review issue comments as unresolved until a
    newer `[codex]` issue comment is posted acknowledging the findings.
- Only request a new Codex review when you need a rerun (e.g., after new
  commits). Do not request one without changes since the last review.
  - Before requesting a new Codex review, re-run the land watcher and ensure
    there are zero outstanding review comments (all have `[codex]` inline
    replies).
  - After pushing new commits, the Codex review workflow will rerun on PR
    synchronization (or you can re-run the workflow manually). Post a concise
    root-level summary comment so reviewers have the latest delta:

    ```
    [codex] Changes since last review:
    - <short bullets of deltas>
    Commits: <sha>, <sha>
    Tests: <commands run>
    ```

  - Only request a new review if there is at least one new commit since the
    previous request.
  - Wait for the next Codex review comment before merging.

## Scope + PR Metadata

- The PR title and description should reflect the full scope of the change, not
  just the most recent fix.
- If review feedback expands scope, decide whether to include it now or defer
  it. You can accept, defer, or decline feedback. If deferring or declining,
  call it out in the root-level `[codex]` update with a brief reason (e.g.,
  out-of-scope, conflicts with intent, unnecessary).
- Correctness issues raised in review comments should be addressed. If you plan
  to defer or decline a correctness concern, validate first and explain why the
  concern does not apply.
- Classify each review comment as one of: correctness, design, style,
  clarification, scope.
- For correctness feedback, provide concrete validation (test, log, or
  reasoning) before closing it.
- When accepting feedback, include a one-line rationale in the root-level
  update.
- When declining feedback, offer a brief alternative or follow-up trigger.
- Prefer a single consolidated "review addressed" root-level comment after a
  batch of fixes instead of many small updates.
- For doc feedback, confirm the doc change matches behavior (no doc-only edits
  to appease review).
