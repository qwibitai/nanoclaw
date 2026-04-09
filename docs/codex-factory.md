# Codex Factory

NanoClaw can run a doc-driven Codex factory mode with optional OpenClaw orchestration.

## Runtime Model
- Product intent lives in `docs/product/BRIEF.md`.
- Architecture and decision docs live in the repo before planning starts.
- A planner owns decomposition and writes a Linear-first task graph.
- Plain Codex or OpenClaw + ACP/ACPX handles implementation.
- Codex custom subagents handle testing and isolated review.
- Linear is the source of truth.
- GitHub mirrors implementation state and PR status.

## Why ACP/ACPX Is Optional
OpenClaw ACP is useful for orchestration and long-running issue runs, but this template must also work in plain Codex without ACP.

## Why Custom Subagents
Codex subagents are explicit, parallel, and configurable per role. Project-scoped agents under `.codex/agents/*.toml` let the implementation session fan out into narrow specialists without mixing all concerns into one thread.

The default specialist set is:
- `planner-high`
- `docs-decomposer`
- `automated-tester`
- `functional-checker`
- `quality-reviewer`
- `performance-reviewer`
- `security-reviewer`

Reasoning policy:
- planning and decomposition: high
- implementation default: medium
- review and testing: explicit overrides

## Factory Directories
- `.codex/` — hooks, agents, prompts, and deterministic scripts
- `.factory/` — machine-readable run state
- `plans/` — durable plan history
- `docs/product/` — product intent and brief
- `docs/architecture/` and `docs/decisions/` — in-repo source of truth

## Golden Path
1. Run intake to initialize `.factory/run.json`
2. Review product, architecture, and decision docs
3. Produce and approve a plan
4. Record decomposition from the docs
5. Implement one bounded leaf task
6. Run automated testing and deterministic verify
7. Spawn the three review subagents and wait for all results
8. Run the functional checker
9. Mark PR ready and sync GitHub + Linear
