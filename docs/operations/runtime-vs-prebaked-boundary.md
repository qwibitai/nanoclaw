# Runtime vs Prebaked Boundary

Canonical guide for where to place changes and which files to update, based on NanoClaw architecture and Claude Code/OpenCode operating patterns.

## Best-Practice Synthesis

1. Keep NanoClaw core small and generic; enforce contracts in host code.
2. Keep role policy in `CLAUDE.md` + focused docs, not hardcoded feature sprawl.
3. Prebake only deterministic, cross-project runtime dependencies into container images.
4. Keep task/project-specific instructions and rapidly changing process docs in runtime-local lanes.
5. Prefer stable orchestration APIs for production paths; avoid preview-only APIs in critical loops.

## Decision Rule

Use this before changing any behavior:

- Put it in **prebaked image/config** when it must be deterministic, universal, and available before task dispatch.
- Put it in **runtime-local docs/config** when it is project/lane specific, fast-changing, or policy text.
- Put it in **host orchestrator code** when it is a contract/state/authorization primitive.

## What Goes Where

| Concern | Placement | Update Locations |
|---------|-----------|------------------|
| OpenCode CLI install/version, worker runner binary, base OS deps | Prebaked worker image | `container/worker/Dockerfile`, `container/worker/build.sh`, `container/worker/runner/*` |
| Worker default model + OpenCode baseline config | Prebaked worker image | `container/worker/Dockerfile` (`OPENCODE_CONFIG_CONTENT`) |
| Worker skills/rules baseline content | Runtime-staged from repo (mounted RO) | `container/skills/*`, `container/rules/*`, staging logic in `src/container-runner.ts` |
| Per-worker task behavior/instructions | Runtime local | `groups/jarvis-worker-*/CLAUDE.md`, `groups/jarvis-worker-*/docs/workflow/*` |
| Andy control-plane behavior/instructions | Runtime local | `groups/andy-developer/CLAUDE.md`, `groups/andy-developer/docs/*` |
| Group runtime configuration files | Runtime local (tracked subset) | `groups/**/.mcp.json`, `groups/**/opencode.json`, `groups/**/container-config.*` |
| Role authority + delegation gates | Host orchestrator primitive | `src/ipc.ts`, `container/rules/*-operating-rule.md`, `docs/operations/roles-classification.md` |
| Dispatch/completion contract | Host orchestrator primitive + docs/tests | `src/dispatch-validator.ts`, `src/jarvis-worker-dispatch.test.ts`, `docs/workflow/nanoclaw-jarvis-dispatch-contract.md` |
| GitHub workflow/review governance | Control-plane (repo tracked) | `.github/workflows/*`, `docs/workflow/nanoclaw-github-control-plane.md` |
| Root instruction routing | Compressed index | `CLAUDE.md` trigger lines only |

## Ownership

| Area | Primary Owner |
|------|---------------|
| Workflow stack selection and `@claude` mode | `andy-developer` |
| GitHub Actions/review governance | `andy-developer` |
| Product implementation tasks | `jarvis-worker-*` |
| Core orchestration contracts/state/auth | core maintainer + `andy-developer` |

## Verification by Change Type

| Change Type | Minimum Verification |
|-------------|----------------------|
| Host contract/auth/state changes | `npm run build`, `npm test` |
| Worker image/runtime changes | `./container/worker/build.sh`, plus worker smoke (`npx tsx scripts/test-worker-e2e.ts`) |
| GitHub workflow governance changes | PR check run evidence + rollback note |

## Notes

- Runtime-lane docs/config agreement updates must follow `docs/operations/agreement-sync-protocol.md`.
- For workflow setup matrix and exact ownership map, see `docs/operations/workflow-setup-responsibility-map.md`.
