# NanoClaw Platform Claude Pickup Lane

## Purpose

Canonical workflow for the durable hourly Claude pickup lane that claims scoped `NanoClaw Platform` work, implements it, and hands it to Codex review.

## Doc Type

`workflow-loop`

## Canonical Owner

This document owns the autonomous `NanoClaw Platform` Claude execution lane.
It does not own the overnight research lane; that belongs to `docs/workflow/strategy/nightly-evaluation-loop.md`.

## Use When

- changing the `NanoClaw Platform` autonomous Claude pickup lane
- editing `.claude/commands/platform-pickup.md`
- editing the launch/bootstrap scripts for the autonomous pickup lane
- changing platform-board field/state rules used by the lane

## Do Not Use When

- changing the overnight upstream/tooling research lane
- changing only GitHub Actions/rulesets/review policy
- deciding whether a changelog idea should become committed work

## Verification

- `node scripts/workflow/platform-loop.js next`
- `node scripts/workflow/platform-loop.js ids --issue 1 --title "example"`
- `bash scripts/workflow/platform-loop-sync.sh --dry-run`
- `bash scripts/workflow/start-platform-loop.sh --dry-run`
- `npm test -- src/platform-loop.test.ts src/platform-loop-sync.test.ts src/github-project-sync.test.ts`
- `bash scripts/check-workflow-contracts.sh`

## Related Docs

- `docs/workflow/strategy/nightly-evaluation-loop.md`
- `docs/workflow/github/github-agent-collaboration-loop.md`
- `docs/workflow/github/nanoclaw-github-control-plane.md`
- `groups/andy-developer/docs/github-workflow-admin.md`

## Precedence

1. Discussions decide whether platform automation candidates should be piloted.
2. This doc governs the hourly Claude execution lane after a platform Issue is already `Ready`.
3. Overnight upstream/tooling research belongs to `docs/workflow/strategy/nightly-evaluation-loop.md`.

## Candidate Formation

1. Start in `SDK / Tooling Opportunities`.
2. Require Claude and Codex decision comments: `accept`, `pilot`, `defer`, or `reject`.
3. Promote to one `NanoClaw Platform` Issue only when the discussion decision is concrete enough to commit work.
4. Promotion alone does not make the Issue `Ready`.
5. Before the item can enter `Ready`, Codex must write or normalize the execution contract on the Issue:
   - `Problem Statement`
   - `Execution Board`
   - `Scope`
   - `Acceptance Criteria`
   - `Expected Productivity Gain`
   - `Base Branch`
   - `Required Checks`
   - `Required Evidence`
   - `Blocked If`
   - `Ready Checklist`

## Dispatch Readiness

The Issue is eligible for pickup only when all are true:

1. local GitHub auth is confirmed as `ingpoc`
2. `Status=Ready`
3. no other Claude-owned item is already `In Progress`
4. no Claude-owned item is already in `Review`
5. no global autonomy pause sentinel is active
6. Codex has explicitly authored or validated the execution contract before setting `Ready`
7. the Issue is not label-blocked

`Ready` is a contract state, not a generic backlog bucket. Codex is the only lane allowed to set it, and only after the issue contains:

- `Problem Statement`
- `Scope`
- `Acceptance Criteria`
- `Required Checks`
- `Required Evidence`
- `Blocked If`
- `Rollback Notes`

## Scheduler Contract

The daytime lane is not a persistent `/loop`.

It is a one-shot headless pickup lane:

1. launchd invokes `scripts/workflow/check-platform-loop.sh` every hour at minute `05`
2. `scripts/workflow/start-platform-loop.sh` performs one pickup attempt and exits
3. `scripts/workflow/check-platform-loop.sh` starts a one-shot pickup only when another pickup is not already running
4. `scripts/workflow/trigger-platform-pickup-now.sh` remains the manual one-shot trigger
5. `.nanoclaw/autonomy/pause.json` blocks only new feature pickup; it does not block Codex review or reliability repair work

## Pickup Flow

1. The scheduled or manual lane runs `bash scripts/workflow/start-platform-loop.sh`.
2. The launcher checks `bash scripts/workflow/autonomy-lane.sh pause-status` and exits with `noop` when pickup is paused.
3. The launcher acquires the `platform-pickup` lane lock under `.nanoclaw/autonomy/locks/`.
4. The launcher provisions a fresh ephemeral worktree from `origin/main` via `bash scripts/workflow/platform-loop-sync.sh`.
5. If the sync fails, Claude stops immediately instead of using stale code.
6. The launcher runs headless Claude through `scripts/workflow/run-platform-claude-session.sh`.
7. Claude confirms the active GitHub account is `ingpoc`.
8. Claude runs `node scripts/workflow/platform-loop.js next`.
9. If the helper returns `noop`, the lane stops with no work picked.
10. If the helper returns a candidate, Claude generates a `request_id`, `run_id`, and branch via `node scripts/workflow/platform-loop.js ids ...`.
11. Claude moves the board item to `In Progress` and sets `Agent=claude`.
12. Claude immediately leaves an issue comment proving claim ownership.

## Bounded Implementation

1. Claude creates the issue branch from the freshly synced ephemeral base worktree.
2. Claude works only within the scoped touch set.
3. Claude runs the required checks from the Issue.
4. Claude must not reprioritize work or widen the scope beyond the `Ready` issue contract.
5. On ambiguity, missing scope, or failed required checks, Claude sets `Status=Blocked`, writes the next decision, comments the blocker, and stops.

## PR and Review Handoff

1. Claude opens or updates a PR linked to the Issue.
2. The PR must include summary, verification evidence, risks, and rollback notes.
3. Claude moves the item to `Review`.
4. Claude leaves an issue comment with PR URL, branch, request/run ids, checks run, and known risks.
5. `Next Decision` must be a Codex review action, not a vague note.
6. Codex PR guardian is the only lane allowed to declare the PR `ready-for-user-merge`.
7. If reliability opens an incident or a pause sentinel while the PR is in `Review`, the PR stays open but no new feature pickup may begin.
8. After Claude exits, `scripts/workflow/run-platform-claude-session.sh` removes the ephemeral worktree automatically when it is clean.
9. If the worktree is dirty because the run stopped mid-change, the runner preserves it and the handoff must name the retained path explicitly.

## Runtime Surfaces

- `.claude/commands/platform-pickup.md`
- `scripts/workflow/autonomy-lane.sh`
- `scripts/workflow/run-platform-claude-session.sh`
- `scripts/workflow/platform-loop.js`
- `scripts/workflow/platform-loop-sync.sh`
- `scripts/workflow/start-platform-loop.sh`
- `scripts/workflow/start-pr-guardian.sh`
- `scripts/workflow/start-autonomy-reliability.sh`
- `scripts/workflow/trigger-platform-pickup-now.sh`
- `scripts/workflow/check-platform-loop.sh`
- `launchd/com.nanoclaw-platform-loop.plist`
- `launchd/com.nanoclaw-pr-guardian.plist`
- `launchd/com.nanoclaw-reliability-loop.plist`
- `.nanoclaw/platform-loop/` runtime state files
- `.nanoclaw/autonomy/` shared locks, pause state, and lane run logs

## Exit Criteria

This workflow is operating correctly when all are true:

1. the pickup lane runs hourly as one-shot headless Claude work, or by manual trigger
2. the lane never starts from an incomplete Issue
3. every automation PR arrives in `Review` with evidence
4. every active Claude-owned item has a visible claim comment on the linked issue
5. blocked states include a concrete next decision and a matching issue comment
6. a global pause sentinel blocks only new feature pickup
7. Codex review remains explicit and human merge remains mandatory
