# Claude/Codex Adapter Matrix

Maps the same workflow intent to each tool's internal controls so implementation/review can be assigned to either tool without process drift.

## Policy Ownership

1. Canonical source: `CLAUDE.md`.
2. Mirror targets: `AGENTS.md`, `.codex/config.toml`, `.claude/settings.local.json`, `docs/operations/tooling-governance-budget.json`.
3. Sync checks: `bash scripts/check-claude-codex-mirror.sh` and `bash scripts/check-tooling-governance.sh`.

## Workflow Adapter Table

| Workflow Intent | Claude Code Adapter | Codex Adapter | Shared Evidence/Gate |
|----------------|---------------------|---------------|----------------------|
| Task start preflight | skill/docs routing + project hooks | plan + role-guided exploration | `bash scripts/workflow/preflight.sh` |
| Decision-complete planning | plan mode + `plan-architect` subagent | `/plan` + `explorer` role | `bash scripts/workflow/plan-lock.sh ...` |
| Bounded implementation | `feature-worker` in impl lane | `worker` role in impl lane | mapped touch-set + tests |
| Deterministic verification | `verify-app` + runtime scripts | `monitor`/`reviewer` + same scripts | `bash scripts/workflow/verify.sh` |
| Security/reliability review | `contract-auditor`, `incident-regression` | `reviewer` role + `/review` | findings with file/line refs |
| PR finalization | hook-assisted checks + ops scripts | `/diff`, `/review`, ops scripts | `bash scripts/workflow/finalize-pr.sh` |
| Governance/mirror sync | `.claude` hooks + docs routing | `.codex` role config + mirror checks | `bash scripts/workflow/sync-mirror.sh` + tooling governance lint |

## Standard Assignment Modes

### Mode A: Claude implements, Codex reviews

1. Claude: plan + implement + first-pass verify.
2. Codex: independent review + risk findings.
3. Finalizer runs shared verify/finalize scripts.

### Mode B: Codex implements, Claude reviews

1. Codex: plan + implement + first-pass verify.
2. Claude: independent review + reliability/incident lens.
3. Finalizer runs shared verify/finalize scripts.

### Mode C: Split by phase

1. One tool plans and explores.
2. Other tool implements.
3. Both review in parallel lanes.
4. Shared gates decide completion.

## Hard Requirements

1. Never skip shared workflow scripts based on tool preference.
2. Never rely on model summary without script-backed evidence.
3. Tool-specific conveniences are allowed only if shared gates still pass.
