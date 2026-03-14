---
name: add-corsair
description: Installs the Corsair integration SDK into NanoClaw. Sets up real-time data sync via webhooks, an MCP server for native agent tool access, a permission approval endpoint, and encrypted credential storage in SQLite.
---

# Add Corsair Integrations

Corsair keeps external service data synced to a local SQLite cache via webhooks. The agent calls live data or reads the cache through native MCP tools.

> **Note:** Corsair's Slack/Discord integrations are distinct from NanoClaw Slack/Discord *channel* skills. Channels route messages *to* your agent; Corsair integrations give your agent *data access and actions*.

---

## Phase 1: Select Integrations

Ask the user which integrations they want. They can add more later.

**API key** (simpler):
- `slack`, `github`, `linear`, `hubspot`, `posthog`, `resend`, `discord`

**OAuth 2.0** (requires creating an OAuth app):
- `gmail`, `googlecalendar`, `googledrive`, `googlesheets`, `spotify`

---

## Phase 2: Apply Code Changes

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-corsair
```

This adds `src/corsair.ts`, the MCP server, webhook server, and merges startup hooks into `src/index.ts`, `src/ipc.ts`, and `src/container-runner.ts`. If there are merge conflicts, read the `.intent.md` files in `modify/`.

After applying, open `src/corsair.ts` and uncomment only the plugins selected in Phase 1.

> **Always rebuild and restart after any change to `src/corsair.ts`.** The running process only knows about plugins registered at startup.

---

## Phase 2.5: Initialize the Corsair Database

Corsair uses a separate database at `store/corsair.db`. Read the current table schemas from `node_modules/corsair/db/index.ts`, then run a migration to create the tables:

```bash
npx tsx -e "
import Database from 'better-sqlite3';
import fs from 'fs';

fs.mkdirSync('store', { recursive: true });
const db = new Database('store/corsair.db');

// Read node_modules/corsair/db/index.ts for the current column definitions, then:
db.exec(\`
  CREATE TABLE IF NOT EXISTS corsair_integrations ( ... );
  CREATE TABLE IF NOT EXISTS corsair_accounts ( ... );
  CREATE TABLE IF NOT EXISTS corsair_entities ( ... );
  CREATE TABLE IF NOT EXISTS corsair_events ( ... );
  CREATE TABLE IF NOT EXISTS corsair_permissions ( ... );
\`);

db.close();
console.log('Done');
"
```

This is idempotent — safe to re-run.

---

## Phase 3: Configure Environment

```bash
openssl rand -base64 32   # use as CORSAIR_KEK
```

Add to `.env`:

```
CORSAIR_KEK=<generated-value>
WEBHOOK_PORT=4001
CORSAIR_MCP_PORT=4002
CORSAIR_MCP_URL=http://host.docker.internal:4002/sse
```

Sync to the container:

```bash
cp .env data/env/env
```

Add to `launchd/com.nanoclaw.plist` under `EnvironmentVariables`:

```xml
<key>CORSAIR_KEK</key>
<string><generated-value></string>
<key>CORSAIR_MCP_URL</key>
<string>http://host.docker.internal:4002/sse</string>
```

Also prepend the Node.js bin directory to `PATH` so `npx` is available (required by `corsair_run`). Then rebuild and reload:

```bash
sed -e "s|{{NODE_PATH}}|$(which node)|g" \
    -e "s|{{PROJECT_ROOT}}|$(pwd)|g" \
    -e "s|{{HOME}}|$HOME|g" \
    launchd/com.nanoclaw.plist > ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux: add Environment= entries to the systemd unit file instead
```

> Use `unload` + `load`, not `kickstart` — kickstart does not re-read env vars.

---

## Phase 4: ngrok Tunnel

```bash
ngrok http 4001
```

Copy the `https://` URL. Add to `.env` and sync:

```
WEBHOOK_URL=https://abc123.ngrok-free.app
```

```bash
cp .env data/env/env
```

> ngrok URLs reset on restart unless you have a static domain. When it changes, update `WEBHOOK_URL`, re-sync, and re-register webhooks in each integration's dashboard.

---

## Phase 5: Credentials

Run `setupCorsair` with `backfill: false` — it will print exactly which credentials each plugin needs:

```bash
npx tsx -e "
import { corsair } from './src/corsair.ts';
import { setupCorsair } from 'corsair';

async function main() {
  await setupCorsair(corsair, { backfill: false });
}
main();"
```

The output will tell you what to call, for example:

```
[corsair:setup] 'googlecalendar' (oauth_2) needs credentials. Call:
  corsair.keys.googlecalendar.set_client_id(value)
  corsair.keys.googlecalendar.set_client_secret(value)
  corsair.googlecalendar.keys.set_access_token(value)
  corsair.googlecalendar.keys.set_refresh_token(value)
```

Ask the user to paste each credential value in this session. Write a short script, run it, delete it immediately. Never leave credentials in a file.

For OAuth 2.0 plugins, guide the user to create an OAuth app in the provider's console first (e.g. Google Cloud Console). Set the redirect URI to `${WEBHOOK_URL}/oauth/callback`, collect `client_id` + `client_secret`, then go through the OAuth consent flow to get `access_token` + `refresh_token`.

> Google plugins (gmail, googlecalendar, googledrive, googlesheets) share one GCP project — same `client_id`/`client_secret`, tokens stored per-plugin.

Once all credentials are set, run backfill to do the initial data sync:

```bash
npx tsx -e "
import { corsair } from './src/corsair.ts';
import { setupCorsair } from 'corsair';

async function main() {
  await setupCorsair(corsair, { backfill: true });
}
main();"
```

For webhooks: tell the user to register `${WEBHOOK_URL}/webhooks` in each integration's dashboard. If the integration provides a signing secret, store it via `corsair.<plugin>.keys.set_webhook_signature(value)`.

No restart needed after setting credentials — the running process reads keys from the DB on every request.

---

## Phase 6: Update Group Memory

Append to `groups/CLAUDE.md` and `groups/main/CLAUDE.md`:

````markdown
## Corsair — Integration SDK

Corsair gives you live access to external services via native MCP tools.

### Discovery (mandatory before any execution)
- `list_operations` — list available operations (`type`: `api`, `db`, or `webhook`)
- `get_schema` — full input/output schema for any path

**RULE: You MUST call `list_operations` before every `corsair_run` call. Never guess operation paths.**

### Execution
- `corsair_run` — run TypeScript with corsair in scope; type-checked then executed; use for live API calls, mutations, and data fetching

### Permissions
Some actions require user approval. When `corsair_run` returns an approval URL, **send it to the user immediately**. They click it, review, and approve. Use `list_pending_permissions` to check what's waiting.

### Webhook Listeners
Use `register_webhook_listener` to invoke the agent on Corsair webhook events. Always call `list_operations` with `type="webhooks"` and `get_schema` first to discover exact plugin/action strings and payload structure. Manage with `list_webhook_listeners` and `remove_webhook_listener`.

### Workflow
1. `list_operations` — required first step
2. `get_schema` to confirm input shape
3. `corsair_run` to call APIs or fetch/transform data
````

---

## Phase 7: Restart & Verify

```bash
npm run build
sed -e "s|{{NODE_PATH}}|$(which node)|g" \
    -e "s|{{PROJECT_ROOT}}|$(pwd)|g" \
    -e "s|{{HOME}}|$HOME|g" \
    launchd/com.nanoclaw.plist > ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Verify:

```bash
curl -s http://localhost:4001/api/permission/invalid
# Expect: 404 "This permission request does not exist."

launchctl list | grep nanoclaw   # should show PID, exit code 0
tail -5 logs/nanoclaw.log        # should show "Corsair MCP server on :4002"
```

---

## Troubleshooting

**`CORSAIR_KEK not set`** — check it's in `.env`, synced via `cp .env data/env/env`, and in the launchd plist. Rebuild plist, unload + load.

**Webhook returns 500** — plugin missing from `src/corsair.ts`. Add it and rebuild.

**MCP tools not in agent** — check `CORSAIR_MCP_URL` is in `data/env/env` and the launchd plist. On Linux, add `--add-host=host.docker.internal:host-gateway` to container args in `src/container-runner.ts`.

**`corsair_run` fails with `spawn npx ENOENT`** — Node.js bin not in launchd PATH. Add it to the plist, then unload + load.

**ngrok URL changed** — update `WEBHOOK_URL` in `.env`, run `cp .env data/env/env`, restart, re-register webhooks.
