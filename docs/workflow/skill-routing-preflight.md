# Skill Routing Preflight

Applies at the start of every task before implementation, debugging, setup, or update actions.

## Rule

Load required docs/rules first to lock invariants, then invoke the most specific matching skill workflow.

Do not start ad-hoc edits/debug loops before this check.

## Preflight Steps

1. Classify the user intent.
2. Load required docs/rules from `CLAUDE.md` Docs Index for that intent.
3. Check local skills under `.claude/skills/*/SKILL.md`.
4. Route to the most specific matching skill or docs workflow.
5. Choose the best matching MCP tool for the intent when available.
6. If no specific skill matches, use `/customize` for feature/behavior changes.
7. If no skill/MCP applies, proceed docs-first with normal engineering flow.

## Mandatory Routing

- New feature or behavior change -> `/customize` (unless a more specific `/add-*` or domain skill exists)
- Container/auth/runtime/linking failures -> `/debug`
- Incident triage/history tracking/resolution workflow -> docs-first (`docs/workflow/nanoclaw-jarvis-debug-loop.md`, `docs/workflow/nanoclaw-container-debugging.md`, `.claude/progress/incident.json`), combine with `/debug` if runtime is failing
- Cross-tool Claude/Codex assignment, worktree parallelism, or subagent fanout policy -> docs-first (`docs/workflow/unified-codex-claude-loop.md`, `docs/operations/claude-codex-adapter-matrix.md`, `docs/operations/subagent-catalog.md`)
- First-time install/onboarding -> `/setup`
- Upstream sync request -> `/update`
- Docker -> Apple Container runtime migration -> `/convert-to-apple-container`

## Selection Priority

When multiple skills match, use this order:

1. Specific integration/domain skill (`/add-*`, `/x-integration`, etc.)
2. docs-first incident workflow (`docs/workflow/nanoclaw-jarvis-debug-loop.md` + incident registry updates)
3. `/debug` for break/fix runtime incidents
4. `/customize` for general feature/custom behavior work
5. `/setup` or `/update` for lifecycle operations

For tool routing, prefer intent-matched MCPs before ad-hoc shell/web:

1. `chrome-devtools` for browser diagnostics and browser automation tasks (default browser MCP)
2. `comet-bridge` for real-browser/deep browsing flows
3. `context7` for library/framework docs
4. `deepwiki` for GitHub repo architecture/Q&A
5. `token-efficient` for large log/CSV/data processing and sandboxed code execution

## MCP Reliability Loop (Mandatory)

When an intent-matched MCP exists, do not sidestep immediately on first failure.

1. Capture the exact tool error and failing call.
2. Attempt to fix the MCP server/config at source first (project-agnostic servers under `/Users/gurusharan/Documents/remote-claude/mcp-servers`).
3. Rebuild/restart the affected MCP server and re-run a minimal verification call.
4. Only use shell/ad-hoc fallback after at least one fix attempt or a clear external blocker.
5. Report blocker + evidence explicitly if fallback is required.

## If Skipping a Matching Skill

Only skip when blocked (missing skill files, incompatible context, or explicit user override). State the reason and use the nearest fallback path.
