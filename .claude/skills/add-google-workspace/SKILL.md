---
name: add-google-workspace
description: Add Google Workspace integration to NanoClaw. Gives agents access to Gmail, Calendar, Drive, Docs, Sheets, and more via a thin MCP wrapper around the gws CLI. Write operations require user confirmation. All calls are audit-logged.
---

# Add Google Workspace Integration

This skill adds Google Workspace access to NanoClaw agents via a custom MCP server that wraps the [Google Workspace CLI](https://github.com/googleworkspace/cli) (`gws`). The MCP server exposes just 3 tools (discover, help, run) instead of gws's 200+ API methods, keeping the agent's context window clean.

**Note:** gws previously shipped a built-in MCP mode (`gws mcp`) but removed it in v0.8.0 due to context bloat. This skill provides a curated alternative. If gws reintroduces a built-in MCP mode with a curated tool set, that would be preferable to this wrapper.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q "gws-mcp-stdio" container/agent-runner/src/index.ts && echo "GWS_APPLIED=true" || echo "GWS_APPLIED=false"
```

If GWS_APPLIED=true, skip to Phase 3 (Host Setup).

### Check host prerequisites

```bash
command -v gws >/dev/null 2>&1 && echo "GWS_INSTALLED=true" || echo "GWS_INSTALLED=false"
ls ~/.config/gws/credentials.json 2>/dev/null && echo "GWS_AUTHENTICATED=true" || echo "GWS_AUTHENTICATED=false"
```

## Phase 2: Apply Code Changes

### Merge the skill branch

```bash
git fetch upstream skill/google-workspace
git merge upstream/skill/google-workspace || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

If `upstream` remote doesn't exist:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
git fetch upstream skill/google-workspace
git merge upstream/skill/google-workspace
```

This merges in:
- `container/agent-runner/src/gws-mcp-stdio.ts` — MCP server with 3 tools: gws_discover, gws_help, gws_run
- `container/skills/google-workspace/SKILL.md` — container-side skill docs
- `container/Dockerfile` — adds `@googleworkspace/cli` to global npm install
- `container/agent-runner/src/index.ts` — registers the gws MCP server + allows `mcp__gws__*` tools
- `src/container-runner.ts` — conditional read-only mount of `~/.config/gws/` into containers

### Validate build

```bash
npm install
npm run build
```

## Phase 3: Host Setup

### Install Google Workspace CLI (if not installed)

```bash
npm install -g @googleworkspace/cli
```

### Authenticate (if not authenticated)

Tell the user:

> First, set up a Google Cloud project with OAuth:

```bash
gws auth setup
```

> Follow the prompts:
> - Select "External" user type for personal accounts
> - Add your email as a test user
> - Choose "Desktop app" when creating OAuth client
>
> Then authenticate:

```bash
gws auth login
```

> Select the scopes you need (Gmail, Calendar, Drive, etc.).

### Headless servers

On headless servers, `gws auth login` won't work because it opens a browser. Two options:

1. **SSH tunnel:** Authenticate on a machine with a browser using an SSH tunnel to forward the OAuth callback
2. **Manual credentials:** Run `gws auth login` on a local machine, then copy `~/.config/gws/credentials.json` (containing client_id, client_secret, refresh_token) to the server. The MCP server handles token refresh automatically.

### Verify authentication

```bash
gws auth status
```

## Phase 4: Rebuild and Restart

```bash
rm -r data/sessions/*/agent-runner-src 2>/dev/null || true
cd container && ./build.sh && cd ..
npm run build
```

Restart the service:

```bash
# macOS:
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux:
systemctl --user restart nanoclaw
```

## Phase 5: Verify

Ask the agent: "Check my calendar for today", "What are my recent emails?", or "Search Drive for quarterly report".

## Key Features

- **3-tool MCP design** — gws_discover, gws_help, gws_run. Avoids the context bloat of exposing 200+ API methods.
- **Write guardrails** — write operations (send, create, update, delete) require nonce-based user confirmation. The agent must ask the user before executing.
- **Audit logging** — every tool call logged to `{group}/logs/gws-audit.jsonl` with timestamps, classification, duration, and results.
- **Auto token refresh** — the MCP server reads `credentials.json` and refreshes OAuth tokens automatically, working around gws's keyring-based credential storage that doesn't work in containers.

## Troubleshooting

- **"gws: command not found" in container** — rebuild the container image (`./container/build.sh`)
- **"Authentication failed"** — run `gws auth login` on the host, or copy credentials.json for headless servers
- **Token refresh fails** — check that `~/.config/gws/credentials.json` contains `client_id`, `client_secret`, and `refresh_token`
- **Agent doesn't use gws tools** — verify `mcp__gws__*` is in allowedTools in `container/agent-runner/src/index.ts`
- **Mount not appearing** — verify `~/.config/gws/` exists on the host. The mount is conditional.

## Removal

1. Remove gws MCP server registration and `mcp__gws__*` from allowedTools in `container/agent-runner/src/index.ts`
2. Delete `container/agent-runner/src/gws-mcp-stdio.ts`
3. Delete `container/skills/google-workspace/`
4. Remove `@googleworkspace/cli` from the Dockerfile npm install line
5. Remove the gws mount block from `src/container-runner.ts`
6. Rebuild: `./container/build.sh && npm run build` and restart the service
