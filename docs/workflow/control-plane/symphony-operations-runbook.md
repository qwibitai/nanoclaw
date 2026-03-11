# Symphony Operations Runbook

## Purpose

Narrow operator runbook for syncing the project registry, inspecting the ready queue, dispatching one run, and viewing Symphony state without changing the underlying routing contract.

## Doc Type

`runbook`

## Canonical Owner

`docs/workflow/control-plane/custom-symphony-orchestration-contract.md` owns Symphony architecture, registry fields, and backend-routing policy.
This runbook owns only day-to-day operator handling.

## Use When

- running the local Symphony dashboard
- syncing the Notion project registry into the runtime cache
- checking which projects are Symphony-enabled
- inspecting `Ready` issues before dispatch
- launching or reconciling a Symphony run
- exposing Symphony operations through MCP for agent use
- validating the required Linear issue shape for Symphony-routed work

## Do Not Use When

- changing backend-routing policy; use `docs/workflow/control-plane/custom-symphony-orchestration-contract.md`
- changing lane authority or `Ready` ownership; use `docs/workflow/control-plane/execution-lane-routing-contract.md`
- onboarding a new project or changing secret scopes; use `docs/workflow/control-plane/project-bootstrap-and-secret-contract.md`

## Verification

- `npm run symphony:setup`
- `npm run symphony:sync-registry`
- `npm run symphony:status`
- `npm run symphony:serve`
- `npm run symphony:daemon -- --once`
- `npm run symphony:mcp`
- `npx tsx scripts/workflow/symphony.ts list-ready --project-key nanoclaw`
- `npx tsx scripts/workflow/symphony.ts dispatch-once --project-key nanoclaw --dry-run`
- `bash scripts/check-workflow-contracts.sh`

## Related Docs

- `docs/workflow/control-plane/custom-symphony-orchestration-contract.md`
- `docs/workflow/control-plane/execution-lane-routing-contract.md`
- `docs/workflow/control-plane/project-bootstrap-and-secret-contract.md`
- `.claude/examples/symphony-linear-issue-template.md`

## Quick Diagnostic

1. Sync the project registry:
   - `npm run symphony:sync-registry`
2. Inspect configured projects:
   - `npx tsx scripts/workflow/symphony.ts show-projects`
3. Inspect current runtime state:
   - `npm run symphony:status`
4. Start the local dashboard if needed:
   - `npm run symphony:serve`
   - open `http://127.0.0.1:4318/`
5. Check the ready queue for one project:
   - `npx tsx scripts/workflow/symphony.ts list-ready --project-key nanoclaw`
6. Start the MCP server when an agent/client needs direct Symphony tools:
   - `npm run symphony:mcp`

Expected runtime files:
- `.nanoclaw/symphony/project-registry.cache.json`
- `.nanoclaw/symphony/state.json`
- `.nanoclaw/symphony/runs/*.json`
- `.nanoclaw/symphony/runs/*.log`

## Issue Categories

### Registry Problems

Symptoms:
- `show-projects` is empty
- expected project missing from dashboard
- registry sync fails loudly

Checks:
- confirm `NOTION_PROJECT_REGISTRY_DATABASE_ID`
- run `npm run symphony:sync-registry`
- inspect `.nanoclaw/symphony/project-registry.cache.json`
- confirm the project row exists and `Symphony Enabled = true`

### Ready Queue Problems

Symptoms:
- dashboard shows zero ready issues when Linear has work
- `dispatch-once` returns `no_ready_issue`

Checks:
- confirm issue state is `Ready`
- confirm the issue belongs to the correct Linear project
- confirm the issue body follows `.claude/examples/symphony-linear-issue-template.md`
- confirm `## Symphony Routing` contains:
  - `Execution Lane: symphony`
  - `Target Runtime: ...`
  - `Work Class: ...`

### Dispatch Problems

Symptoms:
- `dispatch-once` fails before launch
- run record stays `failed` or `blocked`

Checks:
- confirm the selected project allows the target backend
- confirm repo URL, base branch, acceptance criteria, required checks, and evidence sections exist
- confirm the backend command env var is set:
  - `NANOCLAW_SYMPHONY_CODEX_COMMAND`
  - `NANOCLAW_SYMPHONY_CLAUDE_CODE_COMMAND`
  - `NANOCLAW_SYMPHONY_OPENCODE_COMMAND` when relevant

### Dashboard or Daemon Problems

Symptoms:
- `http://127.0.0.1:4318/` does not load
- state stays stale
- recent runs do not reconcile

Checks:
- run `npm run symphony:serve`
- run `npm run symphony:daemon -- --once`
- inspect `.nanoclaw/symphony/state.json`
- inspect the matching run record under `.nanoclaw/symphony/runs/`

### MCP Tooling Problems

Symptoms:
- client reports no Symphony tools
- MCP-connected agents cannot inspect queues or dispatch work

Checks:
- confirm `.mcp.json` contains the `symphony` server entry
- run `npm run symphony:mcp`
- confirm the client is pointed at the repo-local MCP config
- run `npm run symphony:sync-registry` if registry-backed tools appear stale

## Branch Actions

### Observe Only

Use when you want visibility without launching anything.

1. `npm run symphony:sync-registry`
2. `npm run symphony:status`
3. `npm run symphony:serve`
4. open the dashboard and inspect projects, ready counts, and recent runs

### Prepare One Run

Use when a `Ready` issue exists but you want to validate routing before execution.

1. confirm the issue body matches `.claude/examples/symphony-linear-issue-template.md`
2. `npx tsx scripts/workflow/symphony.ts list-ready --project-key <project-key>`
3. `npx tsx scripts/workflow/symphony.ts dispatch-once --project-key <project-key> --issue <IDENTIFIER> --dry-run`

### Launch One Run

Use when the issue is `Ready`, Symphony-routed, and backend commands are configured.

1. `npm run symphony:sync-registry`
2. optional: `npm run symphony:serve`
3. `npx tsx scripts/workflow/symphony.ts dispatch-once --project-key <project-key> --issue <IDENTIFIER>`
4. inspect the dashboard or `.nanoclaw/symphony/runs/<run-id>.json`
5. run `npm run symphony:daemon -- --once` to reconcile state after backend exit

### Continuous Observation

Use when you want ongoing queue and run-state refresh.

1. `npm run symphony:serve`
2. in a separate shell: `npm run symphony:daemon`
3. when agent operability is needed, run `npm run symphony:mcp`

Default daemon behavior is observe-only unless auto-dispatch is explicitly enabled.

## Safe Handling Notes

- Treat `dispatch-once --dry-run` as the default first check for any new project or backend.
- Do not route nightly research, morning prep, governance, or research work through Symphony.
- Do not treat the dashboard as the source of truth for issue state; Linear remains authoritative for task state.
- Do not store secrets in Linear, Notion, or repo-tracked files; only references and scopes belong there.
- If a Symphony-routed issue fails validation, fix the issue body and fields instead of weakening the parser.
- The MCP server is an agent-control surface and must call the same runtime helpers as the CLI and daemon, not alternate orchestration logic.
