# Getting Started with NanoClaw Factory Mode

NanoClaw factory mode is a doc-driven harness for planning, decomposition, implementation, testing, and review automation inside this repo.

---

## Prerequisites

| Tool | Minimum version |
|------|-----------------|
| Node.js | 20.x |
| npm | 10.x |
| Python | 3.10+ |
| Git | 2.x |
| Codex login | subscription auth |

---

## Use In This Repo

You can run factory mode directly from the NanoClaw repository root.

```bash
cd /Users/ravikiranvemula/Workdir/nanoclaw
python3 .codex/scripts/stage_orchestrator.py
```

---

## Put Docs In Repo First

Place the application inputs directly in the generated repo:

- `docs/product/BRIEF.md`
- `docs/architecture/`
- `docs/decisions/`

Start by reading:
- `docs/product/README.md`
- `docs/architecture/README.md`
- `docs/decisions/README.md`

This repo is intended to be self-contained. Do not make the factory depend on another local source repo path.

---

## Initialize a Feature Run

```bash
python3 .codex/scripts/intake.py --issue ENG-123 --title "Build billing dashboard"
```

That creates `.factory/run.json` and establishes the issue/branch contract.

---

## Plan and Decompose First

Use `planner-high` with `.codex/prompts/planner.md` to create the approved plan artifact. Then use `docs-decomposer` with `.codex/prompts/decomposer.md` to create the task graph.

Record decomposition with:

```bash
python3 .codex/scripts/record_decomposition_from_json.py --input /tmp/decomposition.json
python3 .codex/scripts/render_linear_task_graph.py > /tmp/linear-task-graph.md
```

When approved, move the run forward:

```bash
python3 .codex/scripts/update_run.py --phase implementing --plan-status approved --decomposition-status recorded
```

---

## Implement

Use plain Codex or OpenClaw + ACPX Codex for coding work. Keep the coordinator thin-context and use bounded tasks from the recorded decomposition.

To see the exact subagent routing and required commands for your current phase:

```bash
python3 .codex/scripts/stage_orchestrator.py
```

Implementation default:
- model: `gpt-5.3-codex`
- reasoning: `medium`

---

## Automated Testing and Verify

Run the `automated-tester` subagent before deterministic verify. If it returns structured JSON, record it with:

```bash
python3 .codex/scripts/record_test_from_json.py --kind automated --input /tmp/automated-test.json
```

Then run deterministic verify:

```bash
python3 .codex/scripts/verify.py
```

This writes `.factory/verify.json`.

If you want the harness to run deterministic verify, enforce all artifact gates, and mark PR-ready automatically, use:

```bash
python3 .codex/scripts/validate_work.py
```

---

## Spawn Review Subagents

After verification passes, have the parent Codex session explicitly spawn:
- `quality-reviewer`
- `performance-reviewer`
- `security-reviewer`

These are project-scoped custom agents defined under `.codex/agents/`. They are read-only and framework-independent.

If the parent Codex session already has structured reviewer JSON, prefer:

```bash
python3 .codex/scripts/record_review_from_json.py --aspect quality --input /tmp/quality-review.json
python3 .codex/scripts/record_review_from_json.py --aspect performance --input /tmp/performance-review.json
python3 .codex/scripts/record_review_from_json.py --aspect security --input /tmp/security-review.json
```

For manual fallback, record the results with:

```bash
python3 .codex/scripts/record_review.py --aspect quality --score 9 --summary "Code quality acceptable" --recommendation approve --reviewed-scope src/api/orders.ts
python3 .codex/scripts/record_review.py --aspect performance --score 8 --summary "No major regressions" --recommendation approve-with-caveats --reviewed-scope src/api/orders.ts
python3 .codex/scripts/record_review.py --aspect security --score 9 --summary "Security posture acceptable" --recommendation approve --reviewed-scope src/api/orders.ts
```

---

## Run Functional Checks

After review passes, run the `functional-checker` subagent. If it returns structured JSON, record it with:

```bash
python3 .codex/scripts/record_test_from_json.py --kind functional --input /tmp/functional-test.json
```

Functional checks are required before PR-ready.

---

## Mark PR Ready

```bash
python3 .codex/scripts/pr_ready.py
```

If decomposition, testing, review, or verification artifacts are missing, it exits non-zero.

`validate_work.py` already runs this check (and marks PR-ready when successful), so use `pr_ready.py` directly only when you want a separate explicit gate step.
