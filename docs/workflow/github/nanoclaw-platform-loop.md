# NanoClaw Platform Claude Loop

## Purpose

Canonical workflow for the dedicated Claude Code `/loop` lane that autonomously picks scoped `NanoClaw Platform` work, implements it, and hands it to Codex review.

## Doc Type

`workflow-loop`

## Canonical Owner

This document owns the NanoClaw Platform `/loop` execution flow.
It does not replace:

- `docs/workflow/github/github-agent-collaboration-loop.md` for day-to-day GitHub surface usage
- `docs/workflow/github/nanoclaw-github-control-plane.md` for GitHub-hosted review/governance policy
- `docs/workflow/strategy/workflow-optimization-loop.md` for changelog research, pilot gating, and adoption decisions

## Use When

- changing the `NanoClaw Platform` autonomous Claude lane
- editing `.claude/commands/platform-pickup.md`
- editing the launch/bootstrap scripts for the dedicated platform loop session
- changing platform-board field/state rules used by the loop

## Do Not Use When

- working on `Andy/Jarvis Delivery`
- changing only GitHub Actions/rulesets/review policy
- deciding whether a changelog idea should become committed work

## Verification

- `node scripts/workflow/platform-loop.js next`
- `node scripts/workflow/platform-loop.js ids --issue 1 --title "example"`
- `npm test -- src/platform-loop.test.ts src/github-project-sync.test.ts`
- `bash scripts/check-workflow-contracts.sh`
- `bash scripts/check-claude-codex-mirror.sh`
- `bash scripts/check-tooling-governance.sh`

## Related Docs

- `docs/workflow/github/github-agent-collaboration-loop.md`
- `docs/workflow/github/nanoclaw-github-control-plane.md`
- `docs/workflow/strategy/workflow-optimization-loop.md`
- `groups/andy-developer/docs/github-workflow-admin.md`

## Precedence

1. Discussions decide whether platform automation candidates should be piloted.
2. This doc governs the recurring Claude implementation lane after a platform Issue is already `Ready for Dispatch`.
3. Codex review, merge policy, and required checks remain governed by the normal GitHub control-plane docs.

## Phases

### 1. Candidate Formation

1. Start in `SDK / Tooling Opportunities`.
2. Require Claude and Codex decision comments: `accept`, `pilot`, `defer`, or `reject`.
3. Promote to one `NanoClaw Platform` Issue only when scope and acceptance are concrete.
4. Scope the first change as a pilot when it affects workflow, autonomy, or operator load.

### 2. Dispatch Readiness

The Issue is eligible for the loop only when all are true:

1. `Workflow Status=Ready for Dispatch`
2. no other item is `Claude Running`
3. no item is in `Review Queue`
4. the Issue body includes:
   - `Problem Statement`
   - `Scope`
   - `Acceptance Criteria`
   - `Expected Productivity Gain`
   - `Required Checks`
   - `Required Evidence`
   - `Blocked If`
5. the Issue is not label-blocked

### 3. Claude Pickup

1. The dedicated Claude session runs `/loop 1h /platform-pickup`.
2. `/platform-pickup` must begin by running `node scripts/workflow/platform-loop.js next`.
3. If the helper returns `noop`, Claude stops immediately with no work picked.
4. If the helper returns a candidate, Claude generates a `request_id`, `run_id`, and branch via `node scripts/workflow/platform-loop.js ids ...`.
5. Claude moves the board item to `Claude Running` using `node scripts/workflow/platform-loop.js set-status ...`.

### 4. Bounded Implementation

1. Claude creates or reuses the dedicated issue branch.
2. Claude works only within the scoped touch set.
3. Claude runs the required checks from the Issue.
4. On ambiguity, missing scope, or failed required checks, Claude sets `Workflow Status=Blocked`, writes the next decision, and stops.

### 5. PR and Review Handoff

1. Claude opens or updates a PR linked to the Issue.
2. The PR must include:
   - summary
   - verification evidence
   - risks
   - rollback notes
3. Claude moves the item to `Review Queue`.
4. `Next Decision` must be a Codex review action, not a vague note.

### 6. Loop Runtime

1. The loop is session-scoped inside Claude Code.
2. The repo tracks the command and bootstrap surfaces:
   - `.claude/commands/platform-pickup.md`
   - `scripts/workflow/start-platform-loop.sh`
   - `scripts/workflow/check-platform-loop.sh`
   - `launchd/com.nanoclaw-platform-loop.plist`
3. The dedicated session is re-armed locally by the health/bootstrap scripts.
4. The loop never merges PRs and never bypasses required checks.
5. Use interactive Claude Code for the `/loop` lane. Do not try to run `/platform-pickup` through `claude -p`:
   - the official headless/programmatic CLI flow is `claude -p`
   - interactive slash commands are not available in `-p` mode
   - use headless mode only for non-interactive follow-up automation that does not depend on slash commands

## Exit Criteria

This workflow is operating correctly when all are true:

1. only one platform item can be active in the Claude lane at a time
2. the loop never starts from an incomplete Issue
3. every automation PR arrives in `Review Queue` with evidence
4. blocked states include a concrete next decision
5. Codex review remains explicit and human merge remains mandatory

## Anti-Patterns

1. letting `/loop` decide strategy from a vague issue
2. using the board as long-form planning storage
3. running multiple platform pilots in parallel
4. letting the loop continue while another item is already in `Review Queue`
5. treating `/loop` as durable without a local rebootstrap path
