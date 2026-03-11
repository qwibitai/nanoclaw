# NanoClaw Platform Claude Pickup Lane

## Purpose

Canonical workflow for the scheduled Claude Code execution lane that claims already-`Ready` NanoClaw work from Linear, implements it, and hands it to review.

## Doc Type

`workflow-loop`

## Canonical Owner

This document owns the bounded Claude Code pickup lane for NanoClaw repo work.
It does not own nightly research, morning prep, or downstream worker execution.

## Use When

- changing the `NanoClaw` scheduled Claude execution lane
- editing `.claude/commands/platform-pickup.md`
- editing `scripts/workflow/start-platform-loop.sh`
- editing platform pickup state rules in `scripts/workflow/platform-loop.js`

## Do Not Use When

- changing the overnight upstream/tooling research lane
- changing downstream `jarvis-worker-*` dispatch behavior
- changing Symphony scope

## Verification

- `node scripts/workflow/platform-loop.js next`
- `node scripts/workflow/platform-loop.js ids --issue NCL-1 --title "example"`
- `bash scripts/workflow/platform-loop-sync.sh --dry-run`
- `bash scripts/workflow/start-platform-loop.sh --dry-run`
- `npm test -- src/platform-loop.test.ts src/platform-loop-sync.test.ts`
- `bash scripts/check-workflow-contracts.sh`

## Related Docs

- `docs/workflow/control-plane/collaboration-surface-contract.md`
- `docs/workflow/control-plane/execution-lane-routing-contract.md`
- `docs/workflow/strategy/nightly-evaluation-loop.md`
- `groups/andy-developer/docs/workflow-control-admin.md`

## Precedence

1. the user shapes NanoClaw feature direction
2. `andy-developer` approves `Ready`
3. this document governs Claude Code execution after the issue is already `Ready`

## Candidate Formation

The pickup lane consumes only NanoClaw issues that are already decision-complete.

Required issue contract before pickup:

1. `Work Class = nanoclaw-core`
2. `Execution Lane = claude-code`
3. state `Ready`
4. scope
5. acceptance criteria
6. required checks
7. required evidence
8. blocked conditions
9. target repo and base branch
10. linked Notion context when non-trivial

This lane does not decide whether work is `Ready`.

## Dispatch Readiness

The issue is eligible for pickup only when all are true:

1. the active work control plane resolves successfully
2. the selected issue is `Ready`
3. no other Claude-owned NanoClaw item is already `In Progress`
4. no other Claude-owned NanoClaw item is already `Review`
5. the issue contract is complete

If any condition fails, the lane must no-op or stop with a blocker.

## Execution Flow

1. read the selected issue completely
2. respect the existing scope without widening it
3. claim the issue and move it to `In Progress`
4. leave a claim comment with request/run IDs and branch
5. implement only the scoped change
6. run required checks
7. if checks fail or scope is incomplete, move to `Blocked` with explicit next decision
8. open or update the PR with evidence and risks
9. move the issue to `Review`
10. leave a review handoff comment for Codex/human review

## Boundaries

The pickup lane must not:

1. mark work `Ready`
2. reprioritize the queue
3. invent scope
4. consume downstream project issues
5. replace the nightly or morning support lanes

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

## Exit Criteria

This workflow is operating correctly when all are true:

1. only already-`Ready` NanoClaw issues are picked up
2. every pickup creates a visible claim comment
3. every PR reaches `Review` with evidence or reaches `Blocked` with a concrete next decision
4. the lane never shapes or reprioritizes work
