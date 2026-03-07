# Skill Routing Preflight

Applies at the start of every task before implementation, debugging, setup, or update actions.

Policy source of truth: `docs/operations/skills-vs-docs-map.md`.
This document is the executable checklist for applying that policy at task start.
If there is any conflict, `docs/operations/skills-vs-docs-map.md` wins.

## Rule

Load required docs/rules first to lock invariants, then invoke the most specific matching skill workflow.

Do not start ad-hoc edits/debug loops before this check.

## Preflight Steps

1. Classify the user intent.
2. Load required docs/rules from `CLAUDE.md` Docs Index for that intent.
3. Use `docs/operations/skills-vs-docs-map.md` to choose the canonical skill-first or docs-first path.
4. Check local skills under `.claude/skills/*/SKILL.md`.
5. Route to the most specific matching skill or docs workflow.
6. Choose the best matching MCP tool for the intent when available.
7. If no specific skill matches, use `/customize` for feature/behavior changes.
8. If no skill/MCP applies, proceed docs-first with normal engineering flow.

## Quick Routing Shortcuts

- Feature or behavior change: use the most specific `/add-*` skill, otherwise `/customize`.
- Container/auth/runtime failures: `/debug`.
- Incident lifecycle work: docs-first via `docs/workflow/runtime/nanoclaw-jarvis-debug-loop.md`, `docs/workflow/runtime/nanoclaw-container-debugging.md`, and `.claude/progress/incident.json`.
- Cross-tool Claude/Codex execution policy, worktrees, or subagent fanout: docs-first via `docs/workflow/delivery/unified-codex-claude-loop.md`, `docs/operations/claude-codex-adapter-matrix.md`, and `docs/operations/subagent-catalog.md`.
- Setup, upstream sync, and Apple Container migration: `/setup`, `/update`, `/convert-to-apple-container`.

## MCP Reliability Loop (Mandatory)

When an intent-matched MCP exists, do not sidestep immediately on first failure.
Preferred MCP routing and fallback policy are defined in `docs/operations/skills-vs-docs-map.md`.

1. Capture the exact tool error and failing call.
2. Attempt to fix the MCP server/config at source first (project-agnostic servers under `/Users/gurusharan/Documents/remote-claude/mcp-servers`).
3. Rebuild/restart the affected MCP server and re-run a minimal verification call.
4. Only use shell/ad-hoc fallback after at least one fix attempt or a clear external blocker.
5. Report blocker + evidence explicitly if fallback is required.

## If Skipping a Matching Skill

Only skip when blocked (missing skill files, incompatible context, or explicit user override). State the reason and use the nearest fallback path.
