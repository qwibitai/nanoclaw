---
name: add-corsair
description: Installs the Corsair integration SDK into NanoClaw. Sets up real-time data sync via webhooks, an MCP server for native agent tool access, a permission approval endpoint, and encrypted credential storage in SQLite.
---

# Add Corsair Integrations

Corsair keeps external service data synced to a local SQLite cache via webhooks. The agent calls live data or reads the cache through native MCP tools — no bash scripts, no inline API key management.

> **Note:** Corsair's Slack/Discord integrations are distinct from the NanoClaw Slack/Discord *channel* skills. NanoClaw channels route messages *to* your agent; Corsair integrations give your agent *data access and actions*.

---

## Phase 1: Select Integrations

Ask the user to pick a few of the following to get started. Tell the user they can select more integrations later but to just pick a few for now. The user can respond in a text entry.

**API key integrations** (simpler — just an API key):
- `slack` — channels, messages, users, reactions
- `github` — repos, issues, pull requests, releases, workflows
- `linear` — issues, teams, projects, comments
- `hubspot` — contacts, companies, deals, tickets
- `posthog` — event tracking, analytics
- `resend` — transactional email
- `discord` — messages, channels, members

**OAuth 2.0 integrations** (requires creating an OAuth app):
- `gmail` — messages, drafts, threads, labels
- `googlecalendar` — events, calendars
- `googledrive` — files, folders, search
- `googlesheets` — spreadsheets, sheet data
- `spotify` — playback, playlists, search

Store the list — it drives every subsequent phase.

---

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package:

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-corsair
```

This deterministically:
- Adds `src/corsair.ts` — Corsair instance and SQLite database
- Adds `src/corsair-mcp.ts` — MCP server with 4 tools + IPC helpers + permission poller
- Adds `src/corsair-webhooks.ts` — external webhook server (port 4001) + permission approval page
- Adds `src/webhook-server.ts` — internal webhook listener server (port 3456, localhost only)
- Merges Corsair startup + webhook listener server into `src/index.ts`
- Merges webhook listener IPC cases into `src/ipc.ts`
- Merges secret forwarding into `src/container-runner.ts`
- Merges MCP wiring into `container/agent-runner/src/index.ts` (guarded by `CORSAIR_MCP_URL`)
- Installs npm dependencies
- Updates `.env.example`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md`
- `modify/src/ipc.ts.intent.md`
- `modify/src/container-runner.ts.intent.md`
- `modify/container/agent-runner/src/index.ts.intent.md`

After applying, open `src/corsair.ts` and uncomment only the plugins selected in Phase 1.

### Validate & Restart

Build must be clean before proceeding. Then rebuild the plist and reload the launchd service to register the new plugins with the running process.

> **Always rebuild and restart after any change to `src/corsair.ts`** (adding/removing plugins). The running process only knows about plugins registered at startup.

---

## Phase 2.5: Initialize the Corsair SQLite Database

Corsair uses a **separate, fresh database** at `data/store/corsair.db` — it is not NanoClaw's existing `messages.db`. `createCorsair()` wraps it in Kysely but does **not** auto-create tables, so you must run the migration manually.

### Get the current table schemas

Read the schemas from the installed package before writing the migration:

```
node_modules/corsair/db/index.ts           — table column definitions (Zod schemas)
```

These are the source of truth. If the package version has changed, the columns there take precedence over any hardcoded SQL below.

### Run the migration

Write and execute a one-time migration script:

```bash
npx tsx -e "
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const storeDir = 'store';
fs.mkdirSync(storeDir, { recursive: true });
const db = new Database(path.join(storeDir, 'corsair.db'));

// Read node_modules/corsair/db/index.ts and node_modules/corsair/db/kysely/database.ts
// to get the current column definitions for all 5 tables, then generate the SQL below.
db.exec(\`
  -- CREATE TABLE IF NOT EXISTS corsair_integrations ( ... );
  -- CREATE TABLE IF NOT EXISTS corsair_accounts ( ... );
  -- CREATE TABLE IF NOT EXISTS corsair_entities ( ... );
  -- CREATE TABLE IF NOT EXISTS corsair_events ( ... );
  -- CREATE TABLE IF NOT EXISTS corsair_permissions ( ... );
\`);

db.close();
console.log('Corsair DB initialized at store/corsair.db');
"
```

> **Note:** This is idempotent — safe to re-run. If the schema in `node_modules/corsair/db/index.ts` has changed since this skill was written, update the SQL above to match before running.

### Verify

```bash
npx tsx -e "
import Database from 'better-sqlite3';
const db = new Database('store/corsair.db');
const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all();
console.log('Tables:', tables.map((t: any) => t.name).join(', '));
db.close();
"
```

Expected output: `Tables: corsair_integrations, corsair_accounts, corsair_entities, corsair_events, corsair_permissions`

---

## Phase 3: Configure Environment

### Generate a Key Encryption Key

```bash
openssl rand -base64 32
```

Add to `.env`:

```
CORSAIR_KEK=<generated-value>
WEBHOOK_PORT=4001
CORSAIR_MCP_PORT=4002
CORSAIR_MCP_URL=http://host.docker.internal:4002/sse
```

NanoClaw reads `.env` directly via `readEnvFile` (not `dotenv`) — `CORSAIR_KEK` is read from `process.env`, so you need it in two places:

**1. Container environment** (for the agent container):

```bash
cp .env data/env/env
```

**2. Host process environment** (for NanoClaw itself):

Add three entries to `launchd/com.nanoclaw.plist` under `EnvironmentVariables`:

```xml
<key>CORSAIR_KEK</key>
<string><generated-value></string>
<key>CORSAIR_MCP_URL</key>
<string>http://host.docker.internal:4002/sse</string>
```

Also prepend the Node.js bin directory to the `PATH` entry so that `npx` is available to the host process (required by `corsair_run`). Derive it from `NODE_PATH` — e.g. if node is at `/Users/you/.nvm/versions/node/v22.16.0/bin/node`, add `/Users/you/.nvm/versions/node/v22.16.0/bin`:

```xml
<key>PATH</key>
<string>/path/to/node/bin:{{HOME}}/.local/bin:...</string>
```

The plist uses template variables (`{{NODE_PATH}}`, `{{HOME}}`, `{{PROJECT_ROOT}}`). Substitute them before copying — do NOT use `cp` directly:

```bash
sed -e "s|{{NODE_PATH}}|$(which node)|g" \
    -e "s|{{PROJECT_ROOT}}|$(pwd)|g" \
    -e "s|{{HOME}}|$HOME|g" \
    launchd/com.nanoclaw.plist > ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

> `kickstart` does NOT re-read plist environment variables — you must `unload` + `load` to pick up new env vars.

> For Linux (systemd), add `Environment=CORSAIR_KEK=<value>` and `Environment=CORSAIR_MCP_URL=http://host.docker.internal:4002/sse` to the service unit file.

---

## Phase 4: ngrok Tunnel

If ngrok isn't installed, direct the user to https://ngrok.com/download.

```bash
ngrok http 4001
```

Copy the `https://` Forwarding URL. Add to `.env` and sync:

```
WEBHOOK_URL=https://abc123.ngrok-free.app
```

```bash
cp .env data/env/env
```

> **Tip:** ngrok URLs reset on restart unless you have a static domain. When the URL changes, update `WEBHOOK_URL`, re-sync, and re-register webhooks in each integration's dashboard.

---

## Phase 5: Credentials

Walk through each selected integration one at a time.

### Key storage model

Keys are **never stored in `.env`** long-term. The only things that permanently belong in `.env` are `CORSAIR_KEK` and the AI provider key. Everything else (Slack tokens, OAuth credentials, etc.) is stored **encrypted in `store/corsair.db`** using envelope encryption — a Data Encryption Key (DEK) wrapped by the KEK.

### Two-level key model

Every plugin has two key managers:

**Integration level — `corsair.keys.<plugin>`**
Provider/app credentials shared across all users.

| Auth type | Integration fields |
|-----------|-------------------|
| `api_key` | *(none)* |
| `oauth_2` | `client_id`, `client_secret`, `redirect_url` |

**Account level — `corsair.<plugin>.keys`**
Per-user credentials. Tenant ID is always `'default'` in single-tenant setups.

| Auth type | Account fields |
|-----------|---------------|
| `api_key` | `api_key`, `webhook_signature` |
| `oauth_2` | `access_token`, `refresh_token`, `expires_at`, `scope`, `webhook_signature` |

Each level has auto-generated `get_<field>()` and `set_<field>()` methods.

### DB rows required

Before calling any `set_*` or `issue_new_dek()` method, two rows must exist in the Corsair DB:
1. A row in `corsair_integrations` with `name = '<plugin-id>'`
2. A row in `corsair_accounts` with `tenant_id = 'default'` and the matching `integration_id`

Then each level needs its DEK initialised via `issue_new_dek()` before any field can be encrypted.

### Collecting credentials

Always collect and store credentials locally — never instruct the user to add them remotely via the agent. Ask the user to paste the key directly in this Claude Code session. Write the setup script, run it, then delete it immediately. Never leave credentials in a file.

### Script pattern — `api_key` plugins

Write `scripts/setup-<plugin>.ts`, run it, then delete it. Scripts run on the **host** (not inside a container):

```typescript
// NanoClaw does not use dotenv — read CORSAIR_KEK directly from .env
import { readEnvFile } from './src/env.js';
import { STORE_DIR } from './src/config.js';
import Database from 'better-sqlite3';

const { CORSAIR_KEK } = readEnvFile(['CORSAIR_KEK']);
if (!CORSAIR_KEK) throw new Error('CORSAIR_KEK not found in .env');
process.env.CORSAIR_KEK = CORSAIR_KEK;

// Dynamic import so src/corsair.ts initializes after CORSAIR_KEK is set above
const { corsair } = await import('./src/corsair.js');

const PLUGIN = 'slack'; // replace with actual plugin id
const TENANT_ID = 'default';

// ── credentials (fill these in) ──────────────────────────────────────────────
const API_KEY = 'xoxb-...';
const WEBHOOK_SIGNATURE = '...'; // if webhooks enabled
// ─────────────────────────────────────────────────────────────────────────────

export const db: InstanceType<typeof Database> = new Database(`${STORE_DIR}/corsair.db`);

async function main() {
  // 1. Ensure integration row exists
  let integration = db
    .prepare('SELECT id FROM corsair_integrations WHERE name = ?')
    .get(PLUGIN) as { id: string } | undefined;

  if (!integration) {
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(
      'INSERT INTO corsair_integrations (id, created_at, updated_at, name, config) VALUES (?, ?, ?, ?, ?)',
    ).run(id, now, now, PLUGIN, '{}');
    integration = { id };
    console.log(`✓ Created integration: ${PLUGIN}`);
  }

  // 2. Issue (or rotate) integration-level DEK
  await corsair.keys.slack.issue_new_dek(); // replace 'slack' with actual plugin
  console.log('✓ Integration DEK ready');

  // 3. Ensure account row exists
  const account = db
    .prepare('SELECT id FROM corsair_accounts WHERE tenant_id = ? AND integration_id = ?')
    .get(TENANT_ID, integration.id);

  if (!account) {
    const now = Date.now();
    db.prepare(
      'INSERT INTO corsair_accounts (id, created_at, updated_at, tenant_id, integration_id, config) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(crypto.randomUUID(), now, now, TENANT_ID, integration.id, '{}');
    console.log('✓ Created account');
  }

  // 4. Issue (or rotate) account-level DEK
  await corsair.slack.keys.issue_new_dek(); // replace 'slack' with actual plugin
  console.log('✓ Account DEK ready');

  // 5. Store credentials
  await corsair.slack.keys.set_api_key(API_KEY); // replace 'slack' with actual plugin
  // await corsair.slack.keys.set_webhook_signature(WEBHOOK_SIGNATURE); // if also setting up webhooks

  // 6. Verify
  const stored = await corsair.slack.keys.get_api_key(); // replace 'slack'
  console.log(`✓ Done. Key starts with: ${stored?.slice(0, 8)}...`);

  db.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Run the script then delete it immediately.

No restart needed for credentials. The running process reads keys from the DB on every request.

### Webhooks (api_key plugins)

After storing the API key, ask the user: **"Do you want to set up webhooks for this integration?"**

If yes:
1. Tell the user the webhook URL to register in the integration's dashboard: `${WEBHOOK_URL}/webhooks` (read `WEBHOOK_URL` from `.env`)
2. Ask them to paste the signing secret/signature back here
3. Store it via a second script using `corsair.<plugin>.keys.set_webhook_signature(SIGNATURE)`, then delete the script

### Script pattern — `oauth_2` plugins

OAuth 2.0 plugins need both integration-level (app credentials) and account-level (user tokens) keys. Follow the same row-creation and DEK steps above, then:

```typescript
// Integration level (OAuth app credentials — shared across users)
await corsair.keys.googlecalendar.issue_new_dek();
await corsair.keys.googlecalendar.set_client_id(CLIENT_ID);
await corsair.keys.googlecalendar.set_client_secret(CLIENT_SECRET);
await corsair.keys.googlecalendar.set_redirect_url(`${process.env.WEBHOOK_URL}/oauth/callback`);

// Account level (user tokens)
await corsair.googlecalendar.keys.issue_new_dek();
await corsair.googlecalendar.keys.set_refresh_token(REFRESH_TOKEN);
await corsair.googlecalendar.keys.set_access_token(ACCESS_TOKEN);
```

**Steps for OAuth 2.0 integrations:**

1. **Create an OAuth app** in the provider's console (Google Cloud Console for Google plugins; Spotify Developer Dashboard for Spotify). Set redirect URI to `${WEBHOOK_URL}/oauth/callback`.
2. **Collect** `client_id`, `client_secret`.
3. **Run the setup script** using the oauth_2 template above.
4. **Exchange tokens** — guide the user through the OAuth consent flow to get `access_token` + `refresh_token`, then store them via `set_access_token()` / `set_refresh_token()`.

> **Google plugins share one OAuth app.** One GCP project with all needed APIs enabled — same `client_id`/`client_secret`; tokens are stored per-plugin.

---

## Phase 6: Update Group Memory

Append to `groups/CLAUDE.md` and `groups/main/CLAUDE.md`:

````markdown
## Corsair — Integration SDK

Corsair gives you live access to external services via native MCP tools.

### Discovery (mandatory before any execution)
- `list_operations` — list available operations (`type`: `api`, `db`, or `webhook`)
- `get_schema` — full input/output schema for any path

**RULE: You MUST call `list_operations` before every `corsair_run` call. Never guess or assume operation paths — even if you think you know them from training data. Paths in Corsair are not the same as the underlying service's raw API paths.**

### Execution
- `corsair_run` — run TypeScript with corsair in scope; type-checked before execution, then run; use for live API calls, mutations, and data fetching

### Permissions
Some actions require user approval. When `corsair_run` returns an approval URL, **send that URL to the user immediately** — do not wait. The user clicks the URL, reviews the full action details on the page, and clicks Approve. The action executes automatically. To deny: the user ignores the URL and tells you what to do instead. Use `list_pending_permissions` to check what is still waiting.

### Webhook Listeners
Use `register_webhook_listener` to invoke the agent automatically when a Corsair webhook event arrives.

**Before registering, always discover the exact plugin and action strings:**
1. `mcp__corsair__list_operations` with `type="webhooks"` — see all available webhook event types
2. `mcp__corsair__get_schema` on a specific webhook — understand the event payload structure

The prompt template supports:
- `{{event}}` — the raw webhook request body as JSON (capped at 8000 chars)
- `{{event.field.subfield}}` — dot-notation access into the event body (use `get_schema` to discover exact paths — do not guess)
- `{{plugin}}`, `{{action}}` — the plugin and action strings

Manage with `list_webhook_listeners` and `remove_webhook_listener`.

### Workflow
1. `list_operations` — **required first step, no exceptions**
2. `get_schema` to confirm input shape
3. `corsair_run` to call APIs, act, or fetch and transform data inline
4. Chain integrations in a single `corsair_run` call

### Deduction
Fetch the full list, find close matches, proceed if obvious. Ask only when genuinely ambiguous.
````

---

## Phase 7: Restart & Verify

```bash
npm run build
# macOS — must use unload/load (not kickstart) to pick up new env vars
sed -e "s|{{NODE_PATH}}|$(which node)|g" \
    -e "s|{{PROJECT_ROOT}}|$(pwd)|g" \
    -e "s|{{HOME}}|$HOME|g" \
    launchd/com.nanoclaw.plist > ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux: systemctl --user restart nanoclaw
```

Verify webhook server:

```bash
curl -s http://localhost:4001/api/permission/invalid
# Expect: 404 HTML page "This permission request does not exist."
```

Verify MCP server:

```bash
curl -s -X POST http://localhost:4002/sse \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  -D - 2>&1 | head -5
# Expect: HTTP/1.1 200 OK with mcp-session-id header
```

Verify `npx` is accessible to the host process (required by `corsair_run`):

```bash
launchctl list | grep nanoclaw   # should show PID with exit code 0
tail -5 logs/nanoclaw.log        # should show "Corsair MCP server on :4002"
```

Then register your webhook URL in each integration's settings dashboard pointing to `${WEBHOOK_URL}/webhooks`.

---

## Troubleshooting

**`CORSAIR_KEK not set`** — check two things: (1) it's in `.env` and synced to the container via `cp .env data/env/env`; (2) it's in the launchctl plist `EnvironmentVariables` for the host process. Rebuild the plist, reload, and restart.

**Webhook returns 500** — plugin not included in `createCorsair({ plugins })`. Add it to `src/corsair.ts` and rebuild.

**DEK errors ("no DEK found")** — the setup script didn't complete. Re-run it; `issue_new_dek()` is safe to call again.

**ngrok URL changed** — update `WEBHOOK_URL` in `.env`, run `cp .env data/env/env`, restart, and re-register webhook URLs in each integration's dashboard.

**`corsair_run` doesn't return an approval URL** — the action may not be configured as protected. Check corsair's permission mode settings; `open` mode allows everything without approval.

**Permission page returns 410** — the token was already used or the permission expired. The agent will need to retry the action to generate a new permission row.

**MCP tools not available in agent** — check three things: (1) `CORSAIR_MCP_URL` is in `data/env/env`; (2) `CORSAIR_MCP_URL` is in the launchd plist `EnvironmentVariables` so the host process has it in `process.env` (required for the container passthrough); (3) logs show "Corsair MCP server on :4002". On Linux, add `--add-host=host.docker.internal:host-gateway` to container args in `src/container-runner.ts`.

**`corsair_run` fails with `spawn npx ENOENT`** — `npx` is not in the launchd process PATH. Add the Node.js bin directory (e.g. `~/.nvm/versions/node/vX.Y.Z/bin`) to the `PATH` in `launchd/com.nanoclaw.plist`, then `unload` + `load` the service. Check with `tail logs/nanoclaw.log` for `corsair_run error` entries.

**`_cr_*.ts` temp files left behind** — the service crashed or was restarted while `corsair_run` was executing. Safe to delete. They are cleaned up automatically on next startup.

**`corsair_run` output invisible** — output is logged to `logs/nanoclaw.log` at INFO level with the key `corsair_run output`. Use `tail -f logs/nanoclaw.log` to watch in real time.

**Webhook listeners not firing** — check `data/webhook-listeners.json` exists and plugin name matches exactly. Look for IPC task files in `data/ipc/main/tasks/` after a webhook arrives.

**`corsair_run` fails with import error** — check `src/corsair.ts` exists and `npm run build` completed. The MCP server runs from the project root so relative imports resolve correctly.
