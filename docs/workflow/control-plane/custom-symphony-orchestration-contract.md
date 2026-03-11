# Custom Symphony Orchestration Contract

## Purpose

Canonical contract for NanoClaw's custom Symphony implementation, including project registry shape, backend selection, and runtime boundaries.

## Doc Type

`contract`

## Canonical Owner

This document owns the custom Symphony framework contract for this repository.
It does not own shared-context placement, GitHub governance, or worker runtime internals.

## Use When

- changing custom Symphony architecture
- changing project registry shape
- changing backend runner selection
- changing how Symphony routes between `codex`, `claude-code`, and `OpenCode`
- changing which project classes may be Symphony-enabled

## Do Not Use When

- changing general Linear/Notion/GitHub surface split; use `docs/workflow/control-plane/collaboration-surface-contract.md`
- changing general execution-lane ownership; use `docs/workflow/control-plane/execution-lane-routing-contract.md`
- changing worker runtime behavior; use `docs/workflow/runtime/nanoclaw-jarvis-worker-runtime.md`

## Verification

- `npm run symphony:setup`
- `npm run symphony:sync-registry`
- `npm run symphony:status`
- `npm run symphony:serve`
- `npm run symphony:daemon -- --once`
- `npm run symphony:mcp`
- `npx tsx scripts/workflow/symphony.ts print-example`
- `npx tsx scripts/workflow/symphony.ts list-ready --project-key nanoclaw`
- `npx tsx scripts/workflow/symphony.ts plan-run --issue-file <path>`
- `npx tsx scripts/workflow/symphony.ts dispatch-once --project-key nanoclaw --dry-run`
- `npm test -- src/symphony-routing.test.ts`
- `npm test -- src/symphony-registry.test.ts`
- `npm test -- src/symphony-state.test.ts`
- `npm test -- src/symphony-server.test.ts`
- `bash scripts/check-workflow-contracts.sh`

## Related Docs

- `docs/workflow/control-plane/execution-lane-routing-contract.md`
- `docs/workflow/control-plane/collaboration-surface-contract.md`
- `docs/workflow/control-plane/project-bootstrap-and-secret-contract.md`
- `docs/workflow/control-plane/symphony-operations-runbook.md`
- `docs/operations/workflow-setup-responsibility-map.md`

## Requirements

### Core framework

Custom Symphony is a reusable multi-project orchestration framework.

It must provide:

1. project registry lookup
2. Linear issue eligibility and routing
3. workspace provisioning
4. backend selection per issue
5. backend runner lifecycle
6. structured observability
7. persistent local run-state
8. local dashboard and JSON status surface
9. MCP control surface for agents and browser tooling

### Supported backends

The backend abstraction must support:

1. `codex`
2. `claude-code`
3. `opencode-worker`

The orchestrator decides backend per issue using project policy plus issue fields.

### Project registry

The canonical registry is shared-context owned and runtime-cached.

Required fields:

1. `projectKey`
2. `displayName`
3. `linearProject`
4. `notionRoot`
5. `githubRepo`
6. `symphonyEnabled`
7. `allowedBackends`
8. `defaultBackend`
9. `workClassesSupported`
10. `secretScope`
11. `workspaceRoot`
12. `readyPolicy`

Runtime expectations:

1. canonical project identity lives in the shared-context project registry
2. Symphony reads a runtime-local cache materialized from that registry
3. the Notion registry database is configured by `NOTION_PROJECT_REGISTRY_DATABASE_ID`
4. the local cache path is configured by `NANOCLAW_SYMPHONY_REGISTRY_PATH`
5. the checked-in example file is schema documentation only, not the live registry

### Secret scopes

Every registry entry must map to exactly one `secretScope`.

Rules:

1. `secretScope` points at runtime-managed secrets, not repo-tracked files
2. backend runners receive only the secrets required for the selected backend and project
3. global integrations such as Linear, Notion, and GitHub stay in the workspace secret layer
4. project-specific secrets stay under the project scope

### NanoClaw enablement

`NanoClaw` is Symphony-enabled.

Allowed backends for NanoClaw:

1. `codex`
2. `claude-code`

Disallowed by default for NanoClaw:

1. `opencode-worker`

### Downstream project enablement

Downstream projects may allow:

1. `opencode-worker`
2. `codex`
3. `claude-code`

Each project must explicitly list its allowed backends in the registry.

## Field Rules

Symphony-routed issues must include:

1. `Execution Lane = symphony`
2. `Target Runtime = codex | claude-code | opencode`
3. `Work Class`
4. `Repo URL`
5. `Base Branch`
6. `Notion Context URL` when non-trivial

If `Execution Lane = symphony`, `Target Runtime` is mandatory.

Required issue-body section:

```md
## Symphony Routing
- Execution Lane: symphony
- Target Runtime: codex | claude-code | opencode
- Work Class: nanoclaw-core | downstream-project
```

The dispatch path must fail loud when this section is missing or malformed.

## Validation Gates

Before dispatch, custom Symphony must reject the issue if any are true:

1. project is not registry-known
2. project is not Symphony-enabled
3. issue is not `Ready`
4. issue is missing `Target Runtime`
5. target runtime is not allowed for the project
6. work class is `governance` or `research`
7. repo/base branch/context contract is incomplete

## Exit Criteria

This contract is operating correctly when all are true:

1. NanoClaw issues may route through Symphony to `codex` or `claude-code`
2. downstream issues may route through Symphony to allowed backends
3. backend selection is deterministic per issue
4. invalid issue/project combinations fail loudly before dispatch
5. local runtime state is persisted under `.nanoclaw/symphony/`
6. the local dashboard shows configured projects and recent runs
7. agents can inspect projects, queues, runs, and dispatch/reconcile operations through the Symphony MCP server
