# AGENTS.md

## Instruction Source

- Read and follow `CLAUDE.md` as the single source of truth for repository instructions, including upstream sync policy.
- At the start of every task, load `CLAUDE.md` first, then follow its `Docs Index` trigger lines for progressive disclosure.
- At session start or when resuming interrupted work, follow `docs/workflow/session-recall.md` to reconstruct personal session context before loading project docs.
- Use `scripts/qmd-context-recall.sh` for recall-only workflows and `scripts/qmd-session-sync.sh` for session export sync + qmd update + git add/commit.
- Before ending a session with in-progress work or blockers, follow `docs/workflow/session-recall.md` handoff flow (`qctx --close`).
- Before changing session recall/sync/export behavior, follow `docs/workflow/session-recall.md`.
- Run the task-start skill/MCP routing preflight defined by `CLAUDE.md` before ad-hoc implementation/debugging.
- Before starting feature/bug/reliability implementation, follow `docs/workflow/nanoclaw-development-loop.md`.
- Before changing workflow strategy/cadence based on external research, follow `docs/workflow/workflow-optimization-loop.md`.
- Before running weekly docs/scripts/config/code slop cleanup during optimization cycles, follow `docs/workflow/weekly-slop-optimization-loop.md`.
- Before reviewing hooks/subagents or built-in tool routing governance, follow `docs/workflow/weekly-slop-optimization-loop.md` and `docs/operations/tooling-governance-budget.json`.
- Before running parallel Claude/Codex worktrees or splitting execution/review ownership across tools, follow `docs/workflow/unified-codex-claude-loop.md`.
- Before defining subagent fanout for plan/review/verification, follow `docs/operations/subagent-catalog.md` and `docs/operations/subagent-routing.md`.
- Before adapting behavior between Claude and Codex runtimes, follow `docs/operations/claude-codex-adapter-matrix.md`.
- Before deciding what to offload to GitHub Actions/rulesets vs keep in local lanes, follow `docs/workflow/github-offload-boundary-loop.md`.
- Before setting up multi-agent GitHub coordination using Issues/Projects/Discussions/rulesets, follow `docs/workflow/github-multi-agent-collaboration-loop.md`.
- Before consulting Claude Code CLI via resumed/forked sessions for parallel reasoning/review, follow `docs/workflow/claude-cli-resume-consult-lane.md`.
- If `AGENTS.md` and `CLAUDE.md` ever conflict, `CLAUDE.md` wins.

## Mission-Aligned Engineering Contract (Mirror)

- Ground every task in `docs/MISSION.md` and make alignment explicit in reasoning and decisions.
- Think from first principles: requirements, constraints, invariants, and tradeoffs before implementation choice.
- Operate as an expert with a clear technical opinion on the correct mission-aligned path.
- Prioritize reliability, optimization, and efficiency as core defaults.
- Use the most relevant internal skills/tools first and verify outcomes with concrete evidence.
- If a better mission-aligned approach exists, surface it proactively and reason with the user before execution.
- Do not rely on assumptions when facts are retrievable; gather repo facts from code/docs and use DeepWiki for repository documentation when more context is required.
- Any issue discovered during work must be logged/updated in `.claude/progress/incident.json` via the incident workflow before closure.
- Any new feature request not already mapped must be feature-tracked and work-item tracked before implementation.

## Skill Routing Mirror

- Runtime/auth/container failures route to `/debug`.
- Incident triage, recurring issue investigation, and incident lifecycle tracking are docs-first via `docs/workflow/nanoclaw-jarvis-debug-loop.md` + `docs/workflow/nanoclaw-container-debugging.md`.
- Incident lifecycle state is tracked in `.claude/progress/incident.json` (open/resolved + notes).
- Feature mapping/touch-set discipline routes to `feature-tracking`; feature execution tracking routes to `nanoclaw-orchestrator` work items.
- Reliability validation can use `scripts/jarvis-ops.sh verify-worker-connectivity` after `preflight`/`trace`.
- Andy user-facing reliability sign-off should follow `docs/workflow/nanoclaw-andy-user-happiness-gate.md` and run `bash scripts/jarvis-ops.sh happiness-gate --user-confirmation "<manual User POV runbook completed>"`.
