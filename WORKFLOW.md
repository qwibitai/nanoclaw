# WORKFLOW.md — NanoClaw Codex Factory

## Source of Truth
- Linear owns task and decomposition state.
- GitHub mirrors branch, PR, checks, and review evidence.
- The repo owns workflow policy, prompts, and run artifacts.
- Product intent lives in `docs/product/BRIEF.md`.
- Architecture and decision docs live in the repo under `docs/architecture/` and `docs/decisions/`.
- `docs/decisions/` overrides ambiguous or conflicting architecture guidance.

## Runtime Modes
- **Plain Codex**: local implementation and subagent runs.
- **OpenClaw + ACP/ACPX**: orchestrated implementation sessions for long-running work.

Both modes must produce the same `.factory` artifacts.

## Factory Phases
1. `planning`
2. `decomposing`
3. `awaiting-approval`
4. `implementing`
5. `testing`
6. `reviewing`
7. `functional-check`
8. `pr-ready`
9. `done` or `blocked`

## Task Graph Rules
- The planner owns decomposition.
- Decomposition is capability-driven and Linear-first.
- Each leaf task must have write scope, dependencies, acceptance criteria, verify commands, and reviewer focus.
- One task should fit one implementation session and one review package.

## Artifacts
Required run artifacts:
- `.factory/run.json`
- `.factory/decomposition.json`
- `.factory/verify.json`
- `.factory/tests.json`
- `.factory/reviews/quality.json`
- `.factory/reviews/performance.json`
- `.factory/reviews/security.json`

## Execution Order
1. ensure architecture and decision docs are present in-repo
2. create an approved plan
3. record decomposition
4. implement one leaf task
5. run `automated-tester`
6. run `python3 .codex/scripts/verify.py` (or `python3 .codex/scripts/validate_work.py`)
7. spawn review subagents
8. run `functional-checker`
9. run `python3 .codex/scripts/pr_ready.py` (or rely on `validate_work.py` to mark PR-ready)

Use `python3 .codex/scripts/stage_orchestrator.py` to get the exact subagent and command contract for the current phase.

## PR Ready Contract
A branch is PR-ready only when:
- plan status is `approved`
- decomposition status is `recorded`
- deterministic verification passes
- automated and functional test artifacts exist with no blockers
- all three review artifacts exist with score >= 8 and no blockers
- acceptance criteria have direct evidence
