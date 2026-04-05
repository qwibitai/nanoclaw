---
name: add-sentry
description: Add Sentry integration (issue lookup, event search, project management) via IPC bridge. Gives agents tools to list projects, search/resolve/ignore/assign issues, and inspect events. Host-side Python wrapper shells out to the Sentry API; container agents reach it through an MCP server over the IPC bridge.
---

# Add Sentry Integration

This skill adds Sentry issue management to NanoClaw via the host-side IPC bridge pattern. The container agent never sees the Sentry auth token — the host wrapper resolves credentials locally and only returns the API response.

**Skill type:** Feature skill (branch-based). Code lives on the `skill/sentry` branch; this SKILL.md merges it in and walks through setup.

## What It Provides

- **list_projects** — List Sentry projects in the organization
- **list_issues** — Search and filter issues (project, query, sort, limit)
- **get_issue** — Full details for a single issue
- **get_events** — Latest event occurrences for an issue
- **resolve_issue** — Mark an issue resolved
- **ignore_issue** — Ignore an issue
- **assign_issue** — Assign an issue to a user

No delete operations are exposed.

## Phase 1: Pre-flight

Check if the skill is already applied:

```bash
test -f src/sentry-ipc.ts && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Setup / Verify).

## Phase 2: Apply Code Changes

Merge the skill branch:

```bash
git fetch upstream skill/sentry
git merge upstream/skill/sentry
```

> **Note:** `upstream` is the remote pointing to `qwibitai/nanoclaw`. If your remote uses a different name, substitute accordingly.

This adds:
- `scripts/sentry_wrapper.py` — host-side Python wrapper that calls the Sentry API
- `src/sentry-ipc.ts` — host-side IPC handler bridging container requests to the wrapper
- `container/agent-runner/src/sentry-mcp-stdio.ts` — container-side MCP server exposing tools to agents
- IPC wiring in `src/ipc.ts` (registers `processSentryIpc`)
- IPC directory creation in `src/container-runner.ts` (`{group}/sentry/requests/`, `{group}/sentry/responses/`)
- MCP server registration and `mcp__sentry__*` allowed tool in `container/agent-runner/src/index.ts`

### Validate

```bash
npm install
npm run build
npm test
```

### Rebuild container

```bash
./container/build.sh
```

### Restart service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 3: Setup

### Store the Sentry auth token

The wrapper resolves the token in this order:

1. `SENTRY_AUTH_TOKEN` environment variable
2. macOS Keychain: service `nanoclaw`, account `sentry-auth-token`

On macOS, store it in Keychain so it survives reboots and isn't written to disk:

```bash
security add-generic-password -s nanoclaw -a sentry-auth-token -w "<your-token>"
```

On Linux, export `SENTRY_AUTH_TOKEN` in the environment NanoClaw runs under (e.g. the systemd unit's `Environment=` directive or `.env`).

Create a token at `https://<your-org>.sentry.io/settings/account/api/auth-tokens/` with scopes `event:read`, `org:read`, `project:read`, and `event:admin` (only if you want resolve/ignore/assign).

### Configure org and base URL

The wrapper reads these from the environment:

- `SENTRY_ORG` — **required**. Your Sentry organization slug.
- `SENTRY_BASE_URL` — optional. Defaults to `https://sentry.io`. Override for self-hosted Sentry.

Export them in whatever environment NanoClaw runs under:

```bash
# .env or equivalent
SENTRY_ORG=your-org-slug
SENTRY_BASE_URL=https://sentry.io
```

If `SENTRY_ORG` is missing, the wrapper returns `{"error": "SENTRY_ORG env var is required"}` and exits 1 — every Sentry tool call will surface that error to the agent.

### Verify end-to-end

From your main group, send a prompt that exercises the sentry tools, e.g.:

> "List the last 5 unresolved issues for project `<your-project-slug>`"

Expected:
- The agent invokes `mcp__sentry__list_issues` with `project=<slug>`, `query=is:unresolved`, `limit=5`.
- A request file appears briefly under `{group}/sentry/requests/`, then a matching response under `{group}/sentry/responses/`.
- The agent replies with issue titles and IDs.

If nothing happens, check the host process logs for `Error processing sentry IPC` and run the wrapper manually to isolate:

```bash
SENTRY_ORG=<slug> python3 scripts/sentry_wrapper.py projects
```

## Security Constraints

- **Token never enters the container.** The host wrapper reads it from Keychain or env, shells out to Sentry, and returns only the JSON response. The container side only sees the MCP tool interface.
- **No destructive Sentry operations.** The wrapper exposes resolve / ignore / assign but no delete. Any new tool that mutates Sentry state should go through explicit review.
- **Per-group IPC isolation.** Requests and responses are scoped to `{group}/sentry/`, so one group cannot read another's results.
- **Main-group or trusted-sender only** is the intended policy for destructive Sentry operations (resolve / ignore / assign). Enforcing that policy at the IPC layer is follow-up work; until then, treat those tools as available to any group with the skill enabled.

## Troubleshooting

- **`{"error": "SENTRY_ORG env var is required"}`** — export `SENTRY_ORG` in NanoClaw's environment and restart the service.
- **`401 Unauthorized` from Sentry** — the token is missing or has insufficient scopes. Re-create with `event:read`, `org:read`, `project:read` at minimum.
- **Wrapper runs manually but tools fail from the container** — the host service's environment is stale. Restart NanoClaw so it re-reads `.env` (or the Keychain token).
- **Tool calls hang** — check that `src/ipc.ts` contains the `processSentryIpc` call inside `processIpcFiles` and that the host polling loop is running (`logs/nanoclaw.log`).
