# Project Bootstrap and Secret Contract

## Purpose

Canonical contract for onboarding a project into the `Linear + Notion + GitHub + optional Symphony` model and for assigning one reusable secret scope per project.

## Doc Type

`contract`

## Canonical Owner

This document owns project bootstrap order, project-registry expectations, and the universal secret-scope model.
It does not own execution-lane routing or shared-context content design.

## Use When

- onboarding a new project requested through WhatsApp
- normalizing an old project into the new control-plane model
- deciding whether a project is Symphony-enabled
- assigning or rotating project secret scopes
- changing where project registry data is cached locally

## Do Not Use When

- changing daily collaboration placement; use `docs/workflow/control-plane/collaboration-surface-contract.md`
- changing execution-lane routing; use `docs/workflow/control-plane/execution-lane-routing-contract.md`
- changing custom Symphony backend selection logic; use `docs/workflow/control-plane/custom-symphony-orchestration-contract.md`

## Verification

- `npx tsx scripts/workflow/symphony.ts print-example`
- `npx tsx scripts/workflow/symphony.ts validate-registry --file .claude/examples/symphony-project-registry.example.json`
- `npm run symphony:sync-registry`
- `npm run symphony:status`
- `bash scripts/check-workflow-contracts.sh`

## Related Docs

- `docs/workflow/control-plane/collaboration-surface-contract.md`
- `docs/workflow/control-plane/custom-symphony-orchestration-contract.md`
- `docs/workflow/control-plane/execution-lane-routing-contract.md`
- `docs/operations/workflow-setup-responsibility-map.md`

## Bootstrap Sequence

Every real project must be onboarded in this order:

1. create or confirm the `Linear` project
2. create or confirm the `Notion` project root
3. create or confirm the target `GitHub` repo or explicit repo decision
4. decide whether `Symphony` is enabled for the project
5. assign one project registry entry
6. assign one `secretScope`
7. only then shape committed issues in Linear

This sequence applies to both new projects and legacy projects being normalized into the new system.

## Required Registry Fields

Each project registry entry must include:

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

The registry is canonical in shared context and mirrored into a runtime-local cache for Symphony dispatch.

## Secret Model

Use one central secret model across all projects.

Levels:

1. `global workspace secrets`: shared integrations such as Linear, Notion, GitHub, OpenAI
2. `project secrets`: per-project credentials referenced by `secretScope`
3. `lane-scoped credentials`: only when a runtime needs a distinct identity or permission boundary

Rules:

1. the registry stores only the `secretScope`, never raw secrets
2. the runtime secret store keeps one file or manager entry per scope
3. agents always read secrets through the runtime-managed source, never from Notion, Linear, or repo-tracked files
4. project rotation changes only the runtime secret store plus any relevant env var references, not the registry shape

Recommended local convention:

1. `NOTION_PROJECT_REGISTRY_DATABASE_ID` points at the Notion database holding the canonical project registry
2. `NANOCLAW_SYMPHONY_SECRET_ROOT` points at the runtime-managed secret directory
3. each project uses one secret file or secret-manager entry named after `secretScope`
4. the runtime injects only the subset required by the selected backend and project

## NanoClaw Baseline

`NanoClaw` must always have:

1. one Linear project
2. one Notion project root
3. one GitHub repo entry
4. one project registry entry with `projectKey = nanoclaw`
5. one `secretScope = nanoclaw`
6. optional but explicit Symphony enablement

For NanoClaw:

1. `allowedBackends` must include `codex` and `claude-code`
2. `opencode-worker` is disallowed by default
3. nightly and morning support loops stay outside Symphony even when Symphony is enabled

## Downstream Project Baseline

Every downstream project must also have:

1. one Linear project
2. one Notion project root
3. one GitHub repo entry or repo decision
4. one project registry entry
5. one project `secretScope`

If Symphony is enabled, the registry must also declare:

1. allowed backends
2. workspace root
3. ready policy
4. supported work classes

## Exit Criteria

This contract is operating correctly when all are true:

1. every active project has one registry entry
2. every registry entry has one `secretScope`
3. no project secrets are duplicated into Notion, Linear, or repo-tracked files
4. NanoClaw and downstream projects follow the same bootstrap order
