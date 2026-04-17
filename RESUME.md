# /codex implement orchestrator — Resume Brief

**Branch:** `feat/codex-implement`
**Worktree:** `/Users/will/nanoclaw/.worktrees/feat-codex-implement`
**Plan:** `docs/superpowers/plans/2026-04-15-codex-implement-orchestrator.md`
**Spec:** `docs/superpowers/specs/2026-04-15-codex-implement-orchestrator-design.md`

## Completed (T1–T6, all committed + passing)

| Task | Commit | What |
|------|--------|------|
| T1 | c256e28 | Scaffolding + fake codex shim |
| T1 fix | 162bcce | Harden codex-fake exit parser + CODEX_FAKE_LOG test |
| T2 | dfaa73d | Plan parser (bash+python, wave DAG, 5 validation checks) |
| T3 | 78994bc | State library (flock + atomic writes) |
| T3 fix | 1caf9cd | Stale-lock recovery + tmpfile cleanup |
| T4 | 12a6227 | Worktree setup/teardown helpers |
| T5 | b76d8f7 | Codex dispatch wrapper + prompt template |
| T5 fix | 12726d8 | Fix set-u unbound variable on empty TO_CMD array |
| T6 | 784030f | Stage-2 codex review gate wrapper |

**Test suite:** 6/6 passed (`run-all.sh`)

## Remaining (T7–T14)

| Task | Wave | What |
|------|------|------|
| T7 | 2 | Claude spec-check + fallback prompt templates + PROTOCOL.md |
| T8 | 3 | 3-stage gate loop (codex-gate) — chains stage 1/2/3 |
| T9 | 4 | Parallel wave runner (codex-run-wave) |
| T10 | 4 | Wave merger + squash-merge (codex-merge-wave) |
| T11 | 5 | Top-level orchestrator (codex-implement entry point) |
| T12 | 5 | Rollback integration test |
| T13 | 5 | SKILL.md Step 2D + CLAUDE.md reference |
| T14 | 5 | End-to-end integration test |
| Followup | — | Parser code-fence fix (embedded `### Task N:` in code blocks parsed as real tasks) |

## How to continue

1. Start a new session `cd /Users/will/nanoclaw/.worktrees/feat-codex-implement`
2. Read this file + the plan file
3. Continue from T7: create 3 prompt template files + PROTOCOL.md (no test, doc-only task)
4. Implement T8–T14 following the plan's TDD structure

## Key decisions locked

- Full-auto mode: no permission prompts, no check-ins between tasks
- Direct Bash/Write/Edit in main session (NOT subagent Agent dispatches — those trigger permission prompts in worktrees)
- Two review insights to carry forward:
  - Parser doesn't mask code fences — plan files with embedded `### Task N:` in code blocks get corrupted. Fix before dogfooding.
  - T9's `wait -n` requires bash 4.3+; macOS ships bash 3.2. Use `brew install bash` or replace with a portable wait loop.
