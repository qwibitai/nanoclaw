---
name: add-identity
description: This skill should be used when the user wants to "add identity resolution", "set up people.json", "configure who can use the assistant", "map employees to channels", "add cross-channel identity", "install the identity layer", or "run add-identity". Installs and configures the NanoClaw cross-channel identity layer: maps @almalabs.ai employees to their Slack/Telegram IDs, seeds people.json, wires setIdentityWrapper into src/index.ts, applies the identity DB schema, and verifies cross-channel resolution.
---

# Add Cross-Channel Identity

The identity layer resolves inbound messages to a canonical `@almalabs.ai` email (the `canonical_id`), attaches it and the person's roles to every message before the agent sees it, and injects `NANOCLAW_CALLER_ID` / `NANOCLAW_CALLER_ROLES` into agent containers for MCP tool authorization. Without this layer all senders are anonymous; with it, the agent knows who triggered each request and MCP servers can gate privileged operations by role.

## Prerequisites

- `src/identity/` module must be merged — it is part of the `skill/add-identity` branch and is already present if this skill is being run from that branch.
- `src/channels/registry.ts` must export `setIdentityWrapper` — this export is added by the same branch.
- `src/types.ts` must include optional `canonical_id` and `roles` fields on `NewMessage` — also added by the branch.
- `src/router.ts` and `src/container-runner.ts` must forward the new fields — patched in the same branch.
- `~/.config/nanoclaw/people.json` must exist and contain at least one admin entry. Create it from the template in Step 1 if it does not already exist.

Verify the branch is applied before proceeding:

```bash
git log --oneline | head -5
ls src/identity/index.ts 2>/dev/null && echo "identity module present" || echo "MISSING — apply skill/add-identity branch first"
```

## Step 1 — Seed people.json

Check whether the config file exists:

```bash
ls ~/.config/nanoclaw/people.json 2>/dev/null && echo "exists" || echo "missing"
```

If missing, create it with a starter entry:

```bash
mkdir -p ~/.config/nanoclaw
cat > ~/.config/nanoclaw/people.json << 'EOF'
{
  "default_role": "member",
  "people": [
    {
      "canonical_id": "you@almalabs.ai",
      "display_name": "Your Name",
      "roles": ["admin"],
      "channels": {
        "slack": "U...",
        "tg": "123456789"
      }
    }
  ]
}
EOF
```

Ask the user: "Does people.json exist and is it seeded with at least one admin?" Replace the placeholder values with real data for each person who will use the assistant. Each person needs:

- `canonical_id` — the person's `@almalabs.ai` email address; this is the stable key across all channels.
- `display_name` — human-readable name used in logs and agent context.
- `roles` — array of `"admin"` or `"member"` (or both). Admin status gates privileged slash commands.
- `channels.slack` — Slack member ID, always starts with `U` (find it via Slack profile → three-dot menu → Copy member ID).
- `channels.tg` — numeric Telegram user ID (send any message to `@userinfobot` in Telegram to receive it).

Either `slack` or `tg` can be omitted for people who only use one channel. The `default_role` top-level field applies to any sender whose channel ID does not match any `people` entry.

See `references/adding-people.md` for step-by-step instructions on locating IDs and a multi-role example.

## Step 2 — Wire setIdentityWrapper in src/index.ts

Open `src/index.ts`. Add the following near the top of the file, **before** any `import './channels/*.js'` lines that trigger channel self-registration:

```ts
import { loadPeopleConfig, wrapChannelFactory } from './identity/index.js';
import { setIdentityWrapper } from './channels/registry.js';

const peopleConfig = loadPeopleConfig();
setIdentityWrapper((name, factory) => wrapChannelFactory(name, factory, () => peopleConfig));
```

The placement is critical. Channel factories self-register at import time; the wrapper must be installed first or the identity middleware will not decorate any channel. If these lines appear after any `import './channels/...'` statement, identity resolution will silently not run.

`loadPeopleConfig` reads `~/.config/nanoclaw/people.json` (or the path in `PEOPLE_CONFIG_PATH` env var). `wrapChannelFactory` returns a new factory that calls the original and then resolves `canonical_id` and `roles` on each inbound message before it reaches the router.

## Step 3 — Apply identity DB schema

Open `src/db.ts`. Add the import at the top of the file alongside the other imports:

```ts
import { applyIdentitySchema } from './identity/index.js';
```

Inside the `createSchema` function, call it at the end of the function body:

```ts
applyIdentitySchema(database);
```

`applyIdentitySchema` creates three tables — `people`, `person_channels`, and `audit_log` — along with indexes for fast lookup by `canonical_id` and by audit timestamp. All statements use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`, so calling this function on an existing database is safe. The `people` table stores the canonical email and display name; `person_channels` maps channel-specific user IDs to canonical emails; `audit_log` records authorization decisions for tracing access over time.

## Step 4 — Build and test

```bash
npm run build
npm test
```

The TypeScript build must complete with no errors. All tests must pass. If the build fails, check the import order in `src/index.ts` first (Step 2) and confirm `src/identity/index.ts` exports all symbols referenced. Do not proceed to the next step if tests fail. The identity module ships with its own test suite in `src/identity/people.test.ts` — these run as part of `npm test` and cover the core lookup logic.

## Step 5 — Rebuild container

```bash
./container/build.sh
```

The agent container must be rebuilt after the source changes in Steps 2–3. The rebuilt image picks up the `NANOCLAW_CALLER_ID` and `NANOCLAW_CALLER_ROLES` environment variables that `src/container-runner.ts` now injects from `ContainerInput`. MCP servers running inside the container inspect these variables to authorize tool calls.

The container buildkit cache is aggressive. If the rebuild appears to succeed but the env vars are still absent inside the container, prune the builder first:

```bash
docker builder prune -f
./container/build.sh
```

## Step 6 — Restart service

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

Wait a few seconds, then confirm startup completed without errors:

```bash
tail -20 logs/nanoclaw.log
```

Look for any `identity` or `people.json` error lines. A clean start logs the number of people loaded from the config file.

## Step 7 — Verify cross-channel identity

Send a message from Slack (as the registered Slack user) and a separate message from Telegram (as the registered Telegram user). Both messages should land in `messages.db` with a non-NULL `canonical_id`. Inspect the most recent entries:

```bash
sqlite3 store/messages.db "SELECT chat_jid, sender, canonical_id FROM messages ORDER BY timestamp DESC LIMIT 10;"
```

Expected output: `canonical_id` equals the email registered in `people.json` (e.g. `andrey.o@almalabs.ai`) for both channel rows. Rows from unrecognized senders will have `canonical_id` as `NULL` and will receive `default_role` treatment.

## Troubleshooting

**`canonical_id` is NULL for all messages.** `people.json` is not being loaded or the channel-specific ID in the config does not match the sender ID arriving in the message. Confirm `PEOPLE_CONFIG_PATH` is not overriding the default path in `src/identity/people.ts`. Confirm `setIdentityWrapper` was called before any channel import in `src/index.ts` — check with `git diff src/index.ts`.

**`canonical_id` is NULL for one channel only.** The key used in `people.json` (`"slack"` or `"tg"`) does not match the channel name the channel registers with at startup. Inspect the channel's `registerChannel` call in its skill source to find the exact name string, then align the `channels` key in `people.json`.

**Build errors in `src/index.ts`.** Check import order — identity imports (`loadPeopleConfig`, `setIdentityWrapper`) must appear before all `import './channels/*.js'` lines. Move them earlier in the import block.

**`applyIdentitySchema` not exported from `./identity/index.js`.** The `skill/add-identity` branch has not been fully applied. Run `git log --oneline | head -10` to verify the branch commits are present, then confirm `src/identity/index.ts` exports `applyIdentitySchema`.

**Container does not receive `NANOCLAW_CALLER_ID`.** The container image must be rebuilt after any `src/` change. Confirm `./container/build.sh` completed successfully after Step 3. The old image does not pick up new env vars automatically. If in doubt, prune the builder and rebuild clean.

**Service fails to start after restart.** Check `logs/nanoclaw.error.log`. A malformed `people.json` (invalid JSON, missing required fields) will throw at startup. Validate the file with `node -e "require(process.env.HOME+'/.config/nanoclaw/people.json')"` before restarting.
