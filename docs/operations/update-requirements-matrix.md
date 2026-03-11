# Update Requirements Matrix

Where updates are required for each change type.

| Change Type | Required Updates |
|-------------|------------------|
| Core orchestrator flow (`src/index.ts`, queue, IPC lifecycle) | `docs/reference/REQUIREMENTS.md`, `docs/reference/SPEC.md`, `docs/architecture/nanoclaw-system-architecture.md`, `CLAUDE.md` triggers if behavior scope changes |
| Jarvis dispatch/completion schema | `src/dispatch-validator.ts`, `docs/workflow/runtime/nanoclaw-jarvis-dispatch-contract.md`, `docs/architecture/nanoclaw-jarvis.md`, checklist evidence in `docs/workflow/delivery/nanoclaw-jarvis-acceptance-checklist.md` |
| Worker runtime/image/mount/model changes | `container/worker/*`, `src/container-runner.ts`, `docs/workflow/runtime/nanoclaw-jarvis-worker-runtime.md`, `docs/operations/update-requirements-matrix.md`, smoke evidence |
| Runtime vs prebaked placement boundary changes | `docs/operations/runtime-vs-prebaked-boundary.md`, `docs/operations/workflow-setup-responsibility-map.md`, root `CLAUDE.md` trigger index |
| Role authority changes (`andy-bot`, `andy-developer`, workers) | `docs/operations/roles-classification.md`, `src/ipc.ts` auth gates, `container/rules/*-operating-rule.md`, `docs/architecture/nanoclaw-jarvis.md` |
| Workflow setup mode / review policy ownership changes | `docs/workflow/github/github-delivery-governance.md`, `docs/operations/workflow-setup-responsibility-map.md`, `docs/operations/roles-classification.md`, relevant `.github/workflows/*` |
| User-review handoff/readiness gate changes | `docs/workflow/delivery/nanoclaw-andy-user-happiness-gate.md`, `docs/operations/roles-classification.md`, `groups/andy-developer/docs/review-handoff.md`, `container/rules/andy-developer-operating-rule.md` |
| Container lifecycle reliability/recovery changes (orphan cleanup, timeout stop, stale same-group container stop) | `src/container-runtime.ts`, `src/container-runner.ts`, `docs/workflow/runtime/nanoclaw-jarvis-worker-runtime.md`, `docs/troubleshooting/DEBUG_CHECKLIST.md`, runtime smoke evidence |
| Accepted Andy/Jarvis operating agreement changes | `docs/operations/agreement-sync-protocol.md`, affected `docs/operations/*` or `docs/workflow/*`, affected `groups/*` lane docs, root `CLAUDE.md` trigger lines |
| Debug workflow/playbook changes | `docs/workflow/runtime/nanoclaw-jarvis-debug-loop.md`, `docs/troubleshooting/DEBUG_CHECKLIST.md` or `docs/troubleshooting/APPLE-CONTAINER-NETWORKING.md` as applicable, `DOCS.md` map |
| Development workflow gate/policy changes | `docs/workflow/delivery/nanoclaw-development-loop.md`, `docs/workflow/strategy/workflow-optimization-loop.md`, `docs/workflow/strategy/weekly-slop-optimization-loop.md`, `CLAUDE.md` trigger index, `docs/workflow/docs-discipline/skill-routing-preflight.md`, related scripts under `scripts/jarvis-ops.sh`, and `scripts/check-tooling-governance.sh` |
| Unified Claude/Codex workflow policy, adapters, and role/hook enforcement changes | `docs/workflow/delivery/unified-codex-claude-loop.md`, `docs/operations/claude-codex-adapter-matrix.md`, `docs/operations/subagent-catalog.md`, `docs/operations/tooling-governance-budget.json`, `CLAUDE.md` triggers, `AGENTS.md` mirror, `.codex/config.toml`, `.codex/agents/*`, `.claude/settings.local.json`, `.claude/hooks/*`, `scripts/check-claude-codex-mirror.sh`, and `scripts/check-tooling-governance.sh` |
| Worker workflow policy changes | `groups/<worker>/workflow execution loop`, `groups/<worker>/workflow skill policy`, relevant role rules |
| Root documentation structure/classification | `DOCS.md`, `README.md` docs link, `CLAUDE.md` trigger index |

## Minimum Verification

After any non-trivial runtime or contract change:

1. `npm run build`
2. `npm test`
3. `bash scripts/check-workflow-contracts.sh`
4. `bash scripts/check-claude-codex-mirror.sh`
5. `bash scripts/check-tooling-governance.sh`
6. `bash scripts/check-docs-hygiene.sh` (if docs were added, renamed, deleted, or materially restructured)
7. `bash scripts/jarvis-ops.sh acceptance-gate`
8. `./container/worker/build.sh` (if worker runtime/image path touched)
9. `npx tsx scripts/test-worker-e2e.ts` (if delegation/worker path touched)
