# AGENTS.md

## Instruction Source

- Read and follow `CLAUDE.md` as the single source of truth for repository instructions, including upstream sync policy.
- At the start of every task, load `CLAUDE.md` first, then follow its `Docs Index` trigger lines for progressive disclosure.
- At session start or when resuming interrupted work, follow `docs/workflow/session-recall.md` to reconstruct personal session context before loading project docs.
- Use `scripts/qmd-context-recall.sh` for recall-only workflows and `scripts/qmd-session-sync.sh` for session export sync + qmd update + git add/commit.
- Before ending a session with in-progress work or blockers, follow `docs/workflow/session-recall.md` handoff flow (`qctx --close`).
- Before changing session recall/sync/export behavior, follow `docs/workflow/session-recall.md`.
- Run the task-start skill/MCP routing preflight defined by `CLAUDE.md` before ad-hoc implementation/debugging.
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
- Incident triage, recurring issue investigation, and incident lifecycle tracking route to `/incident-debugger`.
- Incident lifecycle state is tracked in `.claude/progress/incident.json` (open/resolved + notes).
- Feature mapping/touch-set discipline routes to `feature-tracking`; feature execution tracking routes to `nanoclaw-orchestrator` work items.
- Reliability validation can use `scripts/jarvis-ops.sh verify-worker-connectivity` after `preflight`/`trace`.
- Andy user-facing reliability sign-off should follow `docs/workflow/nanoclaw-andy-user-happiness-gate.md` and run `bash scripts/jarvis-ops.sh happiness-gate`.
