---
name: add-google-auth
description: Shared Google OAuth prerequisites for every Google-API skill in NanoClaw v2 (Gmail, Calendar, Sheets, Contacts). Walks the operator through the one-time OneCLI connect, the agent secret-mode flip, the credential-stub directories, and the mount-allowlist entries. Also installs two diagnostic MCP tools (`check_google_auth`, `list_google_scopes`) so agents can verify their own auth at runtime. Run this BEFORE `/add-gmail-tool`, `/add-gcal-tool`, or any other Google integration.
---

# Add Google Auth (OneCLI-native)

This is the foundation skill for every Google API integration. NanoClaw v2
holds NO raw Google OAuth tokens — the [OneCLI Agent Vault](https://onecli.sh)
owns the refresh token and injects a fresh bearer into every outbound
request to `*.googleapis.com`. Nothing in the container or in any
`groups/<folder>/.env` ever sees a real token.

This skill captures the cross-skill prerequisites once, so `/add-gmail-tool`,
`/add-gcal-tool`, `/add-sheets-tool`, and `/add-contacts-tool` can each
assume the foundation is in place.

The skill also ships two diagnostic MCP tools in the agent runner —
`check_google_auth` and `list_google_scopes` — that let an agent verify
its own Google auth from inside its container before attempting a
Gmail/Calendar/Sheets/Contacts call. Source:
`container/agent-runner/src/mcp-tools/google-auth.ts`.

## Phase 1: Pre-flight

### Step 1: Verify OneCLI is installed and running

```bash
onecli --version
curl -sf http://127.0.0.1:10254/api/health > /dev/null && echo OK
```

If either fails, run `/init-onecli` first.

### Step 2: Connect Google in the OneCLI web UI

NanoClaw does NOT do the OAuth dance — OneCLI does. Tell the operator:

> Open `http://127.0.0.1:10254` in a browser, go to **Apps → Google**, and
> click **Connect**. Sign in with the Google account the agent should act
> as. Grant every scope you might ever need from this account — Gmail
> read+modify+send, Calendar read+events, Sheets, Contacts (People API).
> Re-connecting later to widen scopes is supported but requires user
> interaction; granting up front avoids interruptions.

Verify the connection:

```bash
onecli apps get --provider google
```

Expected: `"connection": { "status": "connected" }` with the scopes you
granted listed.

### Step 3: Decide on per-account scoping (optional, multi-account)

If the operator wants a second Google account (work + personal), connect
both in the OneCLI web UI. OneCLI distinguishes by app identifier; the
nanoclaw skill that consumes the credential (e.g. `add-gmail-tool`) is
responsible for selecting the right one at request time.

## Phase 2: Apply Code Changes

### Step 1: Merge this branch

This skill ships container MCP tools at
`container/agent-runner/src/mcp-tools/google-auth.ts`. To install them
into your local NanoClaw checkout once `skill/add-google-auth` exists:

```bash
git fetch origin skill/add-google-auth
git merge --no-ff origin/skill/add-google-auth
```

> **Note (pre-split state):** as of 2026-05-11 the working branch is
> `feat/add-google-auth-v2`. The split into `skill/add-google-auth` (fork
> install target) and `add-google-auth-upstream` (PR source for
> nanocoai/nanoclaw) is deferred to the next session pending
> `/zenodotus --personas drive-by-contributor` review per `AGENTS.md`.
> Until the split lands, install by fetching the working branch directly.

### Step 2: Confirm the tools registered

Once you rebuild the agent-runner image (see Phase 4) and a session
container starts, the MCP server logs the registered tool list:

```bash
docker logs $(docker ps -q --filter 'name=nanoclaw-v2-' | head -1) 2>&1 \
  | grep 'MCP server started' | tail -1
```

`check_google_auth` and `list_google_scopes` should appear in the list.

## Phase 3: Wire Per-Agent-Group

### Step 1: Flip the agent's OneCLI secret mode to `all`

This is the most common source of "401 from a Google API after everything
looks wired" — auto-created agents start in `selective` secret mode and
no Google secret is attached even though the vault has one.

For each agent group that should have Google access:

```bash
# Find the OneCLI agent id (the identifier is the agent group id).
onecli agents list

# Flip to `all` so any vault secret with a matching host pattern injects.
onecli agents set-secret-mode --id <agent-id> --mode all

# Verify
onecli agents secrets --id <agent-id>
```

If your security posture requires `selective`:

```bash
GOOGLE_IDS=$(onecli secrets list \
  | jq -r '[.data[] | select(.name | test("(?i)google|gmail|calendar")) | .id] | join(",")')
CURRENT=$(onecli agents secrets --id <agent-id> | jq -r '[.data[]] | join(",")')
MERGED=$(printf '%s' "$CURRENT,$GOOGLE_IDS" | tr ',' '\n' | sort -u | paste -sd ',' -)
onecli agents set-secrets --id <agent-id> --secret-ids "$MERGED"
```

No container restart is needed — the OneCLI gateway resolves secrets per
request, so the next outbound call picks up the new assignment.

### Step 2: Pre-create the shared stub directories

Most Google MCP servers (`@gongrzhe/server-gmail-autoauth-mcp`,
`@cocal/google-calendar-mcp`, etc.) refuse to start without local
credential files on disk. The pattern for every Google integration is the
same: a directory under `$HOME` holding two stub files with the literal
value `onecli-managed`, which the OneCLI gateway rewrites in flight.

This skill does NOT pre-create the per-API stubs — each downstream
`/add-<tool>` skill writes the stubs in its own conventional location
(`~/.gmail-mcp/`, `~/.calendar-mcp/`, etc.) so that uninstalling one
integration cleans up its own stubs. Just make sure the directories live
somewhere covered by the mount allowlist:

### Step 3: Verify the mount allowlist

```bash
cat ~/.config/nanoclaw/mount-allowlist.json
```

A parent of every `~/.<google-thing>-mcp/` directory (typically just
`/home/<user>` or `$HOME`) must appear under `allowedRoots`. If not, run
`/manage-mounts` and add it once.

## Phase 4: Build and Restart

```bash
pnpm run build
./container/build.sh
systemctl --user restart nanoclaw   # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

Kill any existing agent containers so they respawn with the new MCP tool
registry:

```bash
docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill
```

## Phase 5: Verify

### Step 1: From a wired agent, run the diagnostic

> Tell the agent: **"Use `check_google_auth` to verify your Google
> auth."**

Expected: `Google auth OK — connected as <email>.` If the agent reports
a 401, return to Phase 3 Step 1 and verify secret mode. If it reports a
network error, the OneCLI proxy is not wired into the container — check
`HTTPS_PROXY` in `groups/<folder>/container.json`.

### Step 2: Inspect granted scopes

> Tell the agent: **"Run `list_google_scopes`."**

Expected: a list like

```
Granted scopes (access token expires in 3599s):
  - https://www.googleapis.com/auth/gmail.readonly
  - https://www.googleapis.com/auth/gmail.modify
  - https://www.googleapis.com/auth/calendar.events
  ...
```

If a scope you need is missing, return to Phase 1 Step 2 and re-connect
Google in the OneCLI web UI with the expanded scope set.

## Removal

This skill is shared infrastructure — removing it likely breaks every
`/add-<google>-tool` skill currently installed. Before removing:

```bash
grep -l 'mcp__google_auth\|check_google_auth\|list_google_scopes' \
  groups/*/container.json .claude/skills/*/SKILL.md 2>/dev/null
```

If anything references the diagnostic tools, leave the skill in place.

To remove:

1. Delete the line `import './google-auth.js';` from
   `container/agent-runner/src/mcp-tools/index.ts`.
2. Delete `container/agent-runner/src/mcp-tools/google-auth.ts` and
   `google-auth.test.ts`.
3. `pnpm run build && ./container/build.sh && systemctl --user restart nanoclaw`.
4. (Optional) Disconnect Google in the OneCLI web UI.

## Notes

- **No host wrapper, no Python, no `.env` keys.** v1 shipped a
  `scripts/google_reauth.py` and a `~/.config/nanoclaw/secrets/google-gmail.json`
  refresh-token file. v2 deletes both — OneCLI owns the OAuth flow end to
  end. If you find yourself reaching for an env var or a host-side
  refresh script, stop and re-read the [OneCLI section in
  CLAUDE.md](../../CLAUDE.md).
- **Scopes are decided at OneCLI connect time.** The diagnostic
  `list_google_scopes` reads what was granted; it cannot widen the grant.
  Widening requires the operator to re-connect Google in the OneCLI web
  UI.
- **The diagnostic tools never see a real token.** They issue HTTPS GETs
  with no Authorization header (or with the literal `onecli-managed`
  placeholder for `tokeninfo`); OneCLI injects the bearer at the proxy
  boundary. This is by design — the agent process must remain
  credential-free.

## Credits & references

- **OneCLI Agent Vault:** `https://onecli.sh` — the canonical credential
  store and proxy. The full pattern is documented in [skill patterns for
  NanoClaw v2 — API skills](../../docs/skill-patterns-v2.md) (available on
  the `feat/skill-patterns-v2-doc` branch as of 2026-05-11).
- **Container MCP tool layout:** modeled on `self-mod.ts` per the v2
  skill-patterns doc; barrel-imported in
  `container/agent-runner/src/mcp-tools/index.ts`.
- **Downstream consumers:** `/add-gmail-tool`, `/add-gcal-tool`,
  `/add-sheets-tool` (planned, #53), `/add-contacts-tool` (planned, #52),
  `/add-calendar-mgmt` (planned, #55).
- **Issue tracker:** `nanocoai/nanoclaw#50`.
