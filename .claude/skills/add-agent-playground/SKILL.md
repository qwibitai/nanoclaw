---
name: add-agent-playground
description: Add the Agent Playground — a web workbench for iterating on agent personas, skills, and provider settings before applying them to a live agent group. Triggered by /playground on Telegram (lazy-start), magic-link auth, idle-timeout protected.
---

# Add Agent Playground

Web-based workbench for tweaking agent personas + skills + provider in a
draft, testing the changes via chat with the draft agent, then applying
to the target group. Modeled after the v1 playground but rebuilt as a v2
channel adapter so the test chat reuses the standard router/container
pipeline.

## What it does

- **Drafts**: editable copies of an agent group (persona, container.json,
  skills overlay). One per target. Each draft is itself an `agent_groups`
  row with `folder = "draft_<target>"`.
- **Test chat**: send messages to the draft agent through the playground
  UI; replies stream back via Server-Sent Events. Every chat message
  spawns a real container — same pipeline as Telegram/CLI.
- **Provider toggle**: switch a draft between `claude` and `codex`
  mid-session. Container restarts, next message uses the new provider.
- **Skills library**: browse `github.com/anthropics/skills`, enable
  per-draft, see compatibility badges (`compatible` / `partial` /
  `incompatible`).
- **Files**: read/write any text file in the draft folder (with
  path-traversal defense).
- **Diff + apply**: side-by-side draft vs target view; "Apply" copies
  draft files into the target group.

## Architecture

The playground is a `ChannelAdapter` (`channel_type='playground'`). Each
draft session gets its own auto-created `messaging_groups` row with
`platform_id='playground:<draft_folder>'`. Test messages go through the
standard router → inbound.db → container → outbound.db → adapter
`deliver()` → SSE push to the browser. No bypass, no special-casing.

HTTP server is **lazy-start**: not bound at host boot. `/playground` on
Telegram starts it (and prints a magic-link URL); `/playground stop`
shuts it down.

## Install

NanoClaw doesn't ship the playground in trunk. This skill copies the
module from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/playground.ts` exists
- `src/channels/playground/library.ts` exists
- `src/channels/playground/public/{index.html,app.js,style.css}` exist
- `src/agent-builder/core.ts` exists
- `src/db/migrations/014-agent-model.ts` exists (the agent_groups.model column)
- `src/channels/index.ts` contains `import './playground.js';`
- `src/channels/telegram.ts` contains a `handlePlaygroundCommand` function

Otherwise continue.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy modules in

```bash
mkdir -p src/agent-builder src/channels/playground/public

# Core library (agent-group + draft CRUD)
git show origin/channels:src/agent-builder/core.ts > src/agent-builder/core.ts
git show origin/channels:src/agent-builder/core.test.ts > src/agent-builder/core.test.ts

# Channel adapter + UI
git show origin/channels:src/channels/playground.ts > src/channels/playground.ts
git show origin/channels:src/channels/playground/library.ts > src/channels/playground/library.ts
git show origin/channels:src/channels/playground/public/index.html > src/channels/playground/public/index.html
git show origin/channels:src/channels/playground/public/app.js     > src/channels/playground/public/app.js
git show origin/channels:src/channels/playground/public/style.css  > src/channels/playground/public/style.css

# CLI smoke (optional)
mkdir -p scripts
git show origin/channels:scripts/agent-builder-smoke.ts > scripts/agent-builder-smoke.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if already present):

```typescript
import './playground.js';
```

### 4. Add the agent-model migration

If your install predates the `agent_groups.model` column, add migration 014:

```bash
git show origin/channels:src/db/migrations/014-agent-model.ts > src/db/migrations/014-agent-model.ts
```

Then wire it into the migrations barrel — append to `src/db/migrations/index.ts`:

```typescript
import { migration014 } from './014-agent-model.js';
// …add migration014 to the migrations[] array
```

(If your install already ran the migration, skip this step.)

### 5. Add config exports

Append to `src/config.ts` (after the existing exports):

```typescript
export const PLAYGROUND_PORT = parseInt(process.env.PLAYGROUND_PORT || '3002', 10);
export const PLAYGROUND_ENABLED =
  (process.env.PLAYGROUND_ENABLED || '').toLowerCase() === '1' ||
  (process.env.PLAYGROUND_ENABLED || '').toLowerCase() === 'true';
const playgroundEnv = readEnvFile(['PLAYGROUND_BIND_HOST', 'PLAYGROUND_IDLE_MINUTES']);
export const PLAYGROUND_IDLE_MS =
  parseInt(process.env.PLAYGROUND_IDLE_MINUTES || playgroundEnv.PLAYGROUND_IDLE_MINUTES || '30', 10) * 60 * 1000;
export const PLAYGROUND_BIND_HOST: string =
  process.env.PLAYGROUND_BIND_HOST || playgroundEnv.PLAYGROUND_BIND_HOST || '0.0.0.0';
```

### 6. Wire `/playground` into the Telegram interceptor

In `src/channels/telegram.ts`, inside the message-text dispatcher
(alongside `/auth` and `/model`), add:

```typescript
if (text.startsWith('/playground')) {
  const consumed = await handlePlaygroundCommand(token, platformId, text);
  if (consumed) return;
}
```

And add the `handlePlaygroundCommand` function (also from
`origin/channels:src/channels/telegram.ts`) — search for it there and
copy it in alongside `handleAuthCommand` / `handleModelCommand`.

### 7. Build

```bash
pnpm run build
```

## Configure environment

Required:

```bash
PLAYGROUND_ENABLED=1
```

Optional:

```bash
# Default 0.0.0.0 (open beyond loopback). Set to 127.0.0.1 to require an
# SSH tunnel for browser access.
PLAYGROUND_BIND_HOST=0.0.0.0

# Auto-detect picks the first non-private IPv4 from os.networkInterfaces().
# Override if your host is multi-homed or NAT'd.
PLAYGROUND_PUBLIC_HOST=192.0.2.10

# Idle timeout in minutes (default 30). After this, the cookie is
# scrubbed and live SSE streams close. Re-send /playground for a new
# magic link.
PLAYGROUND_IDLE_MINUTES=30

# Default 3002.
PLAYGROUND_PORT=3002
```

Sync to container (containers don't read these — they're host-only):

```bash
mkdir -p data/env && cp .env data/env/env
```

## Firewall

Open the playground port for inbound traffic if your host has a
firewall. Example for UFW:

```bash
sudo ufw allow 3002/tcp
```

(Skip if you set `PLAYGROUND_BIND_HOST=127.0.0.1` and access via SSH
tunnel.)

## Use

1. Send `/playground` on Telegram.
2. Bot replies with a magic-link URL like `http://<host>:3002/auth?key=<token>`.
3. Open in any browser. The link burns on first click and sets a session
   cookie (HttpOnly, 7-day, scoped to the playground).
4. Picker shows existing drafts and "create draft" buttons for each
   non-draft agent group. Pick or create one.
5. In the workspace: chat with the draft, edit persona, toggle skills,
   switch provider, browse files, view diff, apply.
6. `/playground stop` invalidates all sessions and closes the port.

## Security notes

- **Magic-link auth** is the only way in. Each `/playground` issues a
  fresh single-use token (constant-time compared, invalidated on first
  successful exchange). The cookie value is rotated on every restart.
- **Plain HTTP** by default — cookies traverse the wire unencrypted. Put
  Caddy/Nginx with TLS in front if exposing to a hostile network.
- **Loopback fallback** — set `PLAYGROUND_BIND_HOST=127.0.0.1` and SSH
  tunnel (`ssh -L 3002:localhost:3002 user@host`) for stronger
  isolation.
- **Idle timeout** — default 30 minutes inactivity logs you out without
  re-sending `/playground`.

## Channel Info

- **type**: `playground`
- **terminology**: "draft" = editable copy of an agent group; "target" = the live group a draft points back at.
- **supports-threads**: no (single-conversation per draft session)
- **typical-use**: Iterating on personas/skills before applying to production. Side-by-side provider testing (claude vs codex). Quick container-config changes.
- **default-isolation**: Each draft is its own agent_group with its own session/container — no cross-contamination with the target.

## Verify

```bash
# Adapter registered
grep "playground" src/channels/index.ts

# All files in place
ls src/agent-builder/core.ts src/channels/playground.ts src/channels/playground/library.ts src/channels/playground/public/

# Build clean
pnpm run build

# Adapter registers at boot (after host restart)
systemctl --user restart nanoclaw && sleep 3
grep "Channel adapter started.*playground" logs/nanoclaw.log

# Manual smoke test
echo "Send /playground on Telegram — should reply with a URL."
```

## Remove

To uninstall:

```bash
rm -rf src/agent-builder/ src/channels/playground.ts src/channels/playground/
# Remove the playground import from src/channels/index.ts:
sed -i "/import '.\/playground.js';/d" src/channels/index.ts
# Remove the /playground handler from src/channels/telegram.ts (manual edit)
# Remove PLAYGROUND_* env vars from .env
pnpm run build
```

The `agent_groups.model` migration column is left in place — harmless.
Drafts and their `groups/draft_*` folders are also left alone; remove
manually with `discardDraft` calls or `rm -rf groups/draft_*` (and
clean up DB rows).
