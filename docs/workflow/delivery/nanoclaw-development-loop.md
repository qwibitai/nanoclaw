# NanoClaw Development Loop

Default delivery workflow for feature work, bug fixes, and reliability changes.

This loop is mandatory unless the task is a pure docs/ops update with no behavior change.
For meta-process/workflow-strategy changes, use `docs/workflow/strategy/workflow-optimization-loop.md`.
For cross-tool Claude/Codex execution or parallel worktree assignment, use `docs/workflow/delivery/unified-codex-claude-loop.md`.

## Precedence

1. This is the default loop for single-lane delivery work.
2. If execution is split across Claude/Codex lanes, parallel worktrees, or explicit cross-tool fanout, switch to `docs/workflow/delivery/unified-codex-claude-loop.md`.
3. When the unified loop is selected, its phase gates supersede this loop for that task.

## Goal

Ship mission-aligned changes without creating incident churn.

Mission anchor: `docs/MISSION.md`.

## Phase 0: Task Start Preflight

1. Run session recall:
   - `bash scripts/qmd-context-recall.sh --bootstrap`
2. Run skill/docs routing preflight:
   - `docs/workflow/docs-discipline/skill-routing-preflight.md`
3. If runtime issues are involved, open/continue incident tracking first:
   - `bash scripts/jarvis-ops.sh incident list --status open`

## Phase 1: Plan Gate (Before Coding)

Define and lock:

1. Requirement: what outcome must change.
2. Constraints: runtime/security/policy boundaries.
3. Invariants: what must not regress.
4. Acceptance criteria: deterministic pass/fail checks.

For non-trivial work, do not start implementation until this gate is explicit.

## Phase 2: Small-Scope Implementation

1. Keep change scope bounded to mapped feature touch-set.
2. Avoid parallel architecture rewrites in the same change.
3. Keep contract/docs/code/test updates in the same change set.

## Phase 3: Deterministic Verification

Run executable gates and produce evidence:

1. `bash scripts/jarvis-ops.sh acceptance-gate`

For Andy user-facing reliability/sign-off work:

1. `bash scripts/jarvis-ops.sh acceptance-gate --include-happiness --happiness-user-confirmation "<manual User POV runbook completed>"`

Evidence manifest is written to:

- `data/diagnostics/acceptance/acceptance-<timestamp>.json`

Do not rely on unchecked markdown checklist boxes as proof.

## Phase 4: Human Review Gate

Before finalizing:

1. Verify diff intent and rollback path.
2. Verify contract alignment across docs/code/tests.
3. Confirm you can explain every non-trivial change.

## Phase 5: Sync and Governance

When behavior/contracts change, apply:

1. `docs/operations/update-requirements-matrix.md`
2. `docs/operations/agreement-sync-protocol.md`

Keep root `CLAUDE.md` as compressed trigger index only.

## Phase 6: Incident Closure Discipline

If an incident is involved, `resolve` is allowed only after:

1. User confirmation.
2. Verification evidence.
3. Prevention note (how recurrence is blocked).
4. Lesson reference (where CLAUDE/docs was updated).

## Exit Criteria

A change is done when all are true:

1. Acceptance gate manifest status is `pass`.
2. Required contract/docs/test sync is complete.
3. Incident state is updated correctly (open/resolved with evidence).
