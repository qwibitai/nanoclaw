# FACTORY.md

## Purpose

This document is the operating contract for the factory beyond the short root `AGENTS.md`.

## Runtime Matrix

### Plain Codex
Use when:
- working directly in the repo
- no orchestration daemon is needed
- one engineer is driving one issue or small set of issues

Capabilities:
- planning
- decomposition
- implementation
- testing
- review subagents
- PR packaging

### OpenClaw + ACP/ACPX
Use when:
- a long-running or scheduled orchestrator is needed
- many issues are being managed concurrently
- you want a persistent issue session per task

Capabilities:
- everything in plain Codex mode
- plus persistent orchestration, issue polling, and higher-level coordination

### Rule
The repo contract and artifacts must be identical in both modes.

## Prompt Usage Model

Prompt files under `.codex/prompts/` are explicit phase contracts.

They are used in three ways:
- `SessionStart` and `UserPromptSubmit` hooks inject context and enforce gates
- the parent Codex session explicitly loads the relevant phase prompt before acting
- custom agents use their own `.codex/agents/*.toml` instructions as role-specific prompts

Hooks are not the workflow engine. They only add guardrails and continuation logic.

## Recommended Specialist Set

Minimum set for a production run:
- `planner-high`
- `docs-decomposer`
- `automated-tester`
- `functional-checker`
- `quality-reviewer`
- `performance-reviewer`
- `security-reviewer`

This is enough for planning, decomposition, implementation support, testing, and isolated review. Add more agents only when the repo has a repeated bottleneck that justifies another role.

## Reasoning Matrix

Use strong reasoning selectively.

- planner / decomposer / architecture reconciler
  - model: `gpt-5.4`
  - reasoning: `high`
- implementation default
  - model: `gpt-5.3-codex`
  - reasoning: `medium`
- implementation escalation cases
  - model: `gpt-5.3-codex`
  - reasoning: `high`
  - use only for migrations, cross-domain refactors, concurrency, security-sensitive work, or ambiguous failure modes
- reviewers
  - model: `gpt-5.3-codex`
  - reasoning: `high`
- functional checker
  - model: `gpt-5.4`
  - reasoning: `high`

Defaulting all work to `high` is a bad tradeoff for cost, latency, and focus.

## In-Repo Docs Contract

The generated application repo is self-contained.

Put source material directly in:
- `docs/product/BRIEF.md`
- `docs/architecture/`
- `docs/decisions/`

Use:
- `docs/product/README.md` for the product brief contract
- `docs/architecture/README.md` for the architecture doc contract
- `docs/decisions/README.md` for the decision record contract

Optional supporting docs can live in:
- `plans/`
- `docs/product/`
- `docs/operations/`

Planning and decomposition should read only the in-repo docs, not an external source repo path.

## Decomposition Rules

The planner owns decomposition.

Decompose by:
- capability
- runtime seam
- data boundary
- vertical slice

Do not decompose by:
- markdown file
- ADR count
- arbitrary file count
- implementation agent convenience

Each leaf task must include:
- title
- objective
- doc references
- write scope
- dependencies
- acceptance criteria
- verify commands
- required tests
- reviewer focus

Store the decomposition in `.factory/decomposition.json` and mirror it into Linear.
Use `python3 .codex/scripts/render_linear_task_graph.py` when you want a deterministic Markdown view of the task graph before syncing it to Linear.

## AGENTS Hygiene

Root `AGENTS.md` should stay near 100 lines.

Mechanically enforce:
- size cap
- required headings
- linked-doc existence
- no large duplicated policy blocks

Maintenance cadence:
- per PR: lint AGENTS and docs links
- weekly: stale rule scan
- monthly: compact overgrown instructions
