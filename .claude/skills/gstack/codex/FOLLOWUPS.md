# /codex implement — Follow-Up Log

**Status as of 2026-04-22:** All known P1 and P2 issues fixed through
39 rounds of codex review (rounds 7-44). Round 45 returned clean — no
discrete actionable bugs. Happy path validated; 18/18 integration
tests pass; parse-plan rejects invalid configurations with clear
errors.

Skill is considered production-grade. This file tracks open and
previously-addressed issues for reference.

## Open items

(none known — items below were addressed in commits on top of the
2026-04-22 trial run; see "First real-world trial" section)

## First real-world trial: 2026-04-22 (Dodami Tier-2 shadow plan)

First production use after the 39-round hardening pass. Plan completed
end-to-end (3 tasks, 2 waves, all merged + deployed). Four UX/protocol
issues surfaced and were fixed in follow-up commits same-day:

- [FIXED] **Plan-level Test command needs an explicit repo-root
  reference.** Author wrote `cd ~/repo/$UNSUBSTITUTED && pytest ...`
  with `$UNSUBSTITUTED` an unset shell var; `cd` silently landed in
  the parent dir, pytest failed on missing tests/. Orchestrator now
  exports `REPO_ROOT` to the bash subshell + SKILL.md documents the
  invariant. (codex-merge-wave + SKILL.md)
- [FIXED] **Post-wave-test-failed message wrongly implied rollback
  was the only fix.** When the plan-level Test command itself is
  malformed (vs a real code regression), rolling back discards
  correctly-merged work. Message now distinguishes the two cases.
  (codex-merge-wave)
- [FIXED] **Spec-reviewer subagent had no context on prior-attempt
  failures.** When codex made a recovery change to fix a stage-1 test
  failure (e.g. lazy-import wrapper for an unavailable module), the
  reviewer flagged it as out-of-scope because the literal task spec
  didn't mention it. Cost: 3 wasted codex attempts, 1 escalation
  cycle. Marker payload now includes `prior_attempt_findings`;
  reviewer prompt explicitly handles recovery-change scope.
  (codex-gate + spec-reviewer-prompt.md + PROTOCOL.md)
- [FIXED] **Claude-side marker polling pattern was undocumented.**
  Coordinating session went through three broken Monitor variants
  (zsh nomatch, name-only dedup across --resume, tail+grep against
  atomic writes) before landing on a working pattern. Reference
  pattern + footgun list now in PROTOCOL.md. (PROTOCOL.md)

## Historical: items addressed during 45-round hardening pass

### Core orchestrator
- [FIXED] Defer task-branch/worktree teardown until post-wave global
  test passes (so `--resume` after a failure can re-run only the
  plan test).
- [FIXED] `--resume` force-cleans interrupted task worktrees (wipe
  partial state + recreate from BASE for `dispatched`/`gate-check`
  tasks); preserves `claude-fallback` state.
- [FIXED] Plan-level `**Test command:**` runs only after the final
  declared wave, not after every wave.
- [FIXED] `--resume` and `--rollback` use cached `plan.json` from
  the original run (never re-parse the current plan).
- [FIXED] Global test runs in a disposable worktree so side-effecting
  tests don't dirty the main checkout.

### Parse-plan
- [FIXED] Work-dir slug collisions across repos/paths (namespaced by
  `<repo-id>--<plan-base>--<sha1[0:8]>`).
- [FIXED] Duplicate task numbers / duplicate slugs explicitly
  rejected with actionable errors.
- [FIXED] Fenced code blocks (```...```) don't count as task headings.
- [FIXED] Task body preserves fenced examples for the implementer
  prompt while metadata extraction (Run:, file claims) scans a
  fence-stripped view.
- [FIXED] Multi-task plans must declare per-task `Run:` lines (the
  plan-level test cannot substitute because it typically needs peer
  artifacts).

### --only-task canary
- [FIXED] Canary wave validation: reject if earlier waves still have
  unmerged peers.
- [FIXED] Canary plan-test probe uses disposable worktrees for both
  post-canary and pre-canary state.
- [FIXED] Canary that introduces a regression (plan test passes on
  BASE, fails after canary merge) auto-reverts via `git reset --hard`
  and clears `final_commit_on_base`.
- [FIXED] Canary that completes the plan (all tasks now merged) but
  leaves plan test red escalates instead of silently exiting 0.
- [FIXED] Summary output distinguishes full completion from canary
  partial completion.
- [FIXED] Rejection preflight cleans up the just-initialized
  `state.json` so the next non-resume run isn't blocked.

### Claude fallback protocol
- [FIXED] Request markers include a `<pid>-<epoch>` generation suffix
  so delayed replies from prior runs don't clobber current attempts.
- [FIXED] Resume-from-`claude-fallback` preserves the subagent's
  in-progress worktree + markers; skips the codex retry ladder.
- [FIXED] Stale marker → wait for in-flight worker reply (full 30-min
  budget) before re-gating or emitting a fresh request.
- [FIXED] Attempt-4 and resume paths both remove the request marker
  alongside the result so a later poll doesn't re-trigger fallback.
- [FIXED] Marker discovery uses python3 glob + mtime sort
  (cross-platform; safe on paths with spaces; empty-safe).
- [FIXED] Rollback uses slugs from `state.json`, not the current
  plan.json (handles plans edited between original run and rollback).
- [FIXED] Rollback runs `git worktree prune` before `branch -D` so
  deleted-out-of-band worktrees don't leave orphan branches.

### Misc correctness
- [FIXED] `awk` gsub `&` in replacement string: prompts containing
  `&&` (e.g. shell pipelines in Run:) now render correctly.
- [FIXED] codex sandbox can't commit from inside its workspace: bash
  auto-commits task worktree changes after codex returns DONE /
  DONE_WITH_CONCERNS.
- [FIXED] `codex review` CLI change in codex-cli 0.122: dropped
  positional prompt (conflicts with `--base`).
- [FIXED] Spec-check markers carry `plan_goal` / `plan_architecture` /
  `task_body` per PROTOCOL.md.
- [FIXED] Spec-check markers versioned per attempt; timeout cleans
  up stale markers.
- [FIXED] Reject remote-tracking `--base` refs (detached-HEAD
  orphaning guard); require local branch.
- [FIXED] PID-file fallback lock for systems without flock (macOS).
- [FIXED] Iterate declared wave numbers (not `seq 1..length`) to
  handle non-contiguous labels.
- [FIXED] `plan-test-passed` sentinel survives across invocations so
  non-idempotent plan tests aren't re-executed on --resume.

## Test coverage

18 integration tests cover every path above:
- `test-render-prompt-ampersand.sh` — awk gsub & regression
- `test-post-wave-recovery.sh` — global test fail → preserve → resume
- `test-resume-cleanup.sh` — dirty worktree on resume, force-clean
- `test-resume-claude-fallback.sh` — preserve subagent work on resume
- `test-only-task.sh` — canary mode runs only target task
- `test-claude-fallback.sh` — full fallback-marker protocol
- `test-cross-wave.sh` — Wave 2 reads Wave 1 artifact
- plus 11 existing tests (parse, state, worktree, dispatch, gate,
  merge-wave, rollback, e2e, preflight).
