---
name: add-matrix
description: Add Matrix as a channel. Connect to any Matrix homeserver (Synapse, Dendrite, Conduit) with optional E2EE support. Can run alongside other channels.
---

# Add Matrix Channel

This skill adds Matrix support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `matrix` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have a Matrix bot account with an access token, or do you need help creating one?

If they have credentials, collect the homeserver URL and access token now. If not, we'll set them up in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-matrix
```

This deterministically:
- Adds `src/channels/matrix.ts` (MatrixChannel class with self-registration via `registerChannel`)
- Adds `src/channels/matrix.test.ts` (39 unit tests)
- Appends `import './matrix.js'` to the channel barrel file `src/channels/index.ts`
- Installs the `matrix-bot-sdk` npm dependency
- Updates `.env.example` with `MATRIX_HOMESERVER_URL`, `MATRIX_ACCESS_TOKEN`, `MATRIX_E2EE`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new matrix tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create Matrix Bot Account (if needed)

If the user doesn't have a bot account, guide them through creating one:

> I need you to set up a Matrix bot account:
>
> 1. **Register an account** on your homeserver for the bot (e.g., `@mybot:example.com`)
>    - For Synapse: `register_new_matrix_user -c /etc/synapse/homeserver.yaml http://localhost:8008`
>    - For public servers: Register via Element or another client
> 2. **Get an access token** — log in as the bot and retrieve the token:
>    ```bash
>    curl -XPOST 'https://your-homeserver.com/_matrix/client/v3/login' \
>      -H 'Content-Type: application/json' \
>      -d '{"type":"m.login.password","user":"mybot","password":"bot-password"}'
>    ```
>    The response contains `"access_token": "..."` — copy that value.
> 3. **Note your homeserver URL** (e.g., `https://matrix.example.com`)

Wait for the user to provide the homeserver URL and access token.

### Configure environment

Add to `.env`:

```bash
MATRIX_HOMESERVER_URL=https://matrix.example.com
MATRIX_ACCESS_TOKEN=<their-access-token>
# MATRIX_E2EE=true  # Enabled by default; set to false to disable encryption
```

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Room ID

Tell the user:

> 1. Open a Matrix room where you want the bot (create one or use existing)
> 2. Invite the bot to the room — it will auto-join
> 3. Send `!chatid` in the room — the bot will reply with the room's registration ID
> 4. The ID looks like `mx:!abc123:example.com`

Wait for the user to provide the room ID.

### Register the room

Use the IPC register flow or register directly. The room ID, name, and folder name are needed.

For a main room (responds to all messages):

```typescript
registerGroup("mx:!room-id:server", {
  name: "<room-name>",
  folder: "matrix_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For additional rooms (trigger-only):

```typescript
registerGroup("mx:!room-id:server", {
  name: "<room-name>",
  folder: "matrix_<room-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered Matrix room:
> - For main room: Any message works
> - For non-main: `@Andy hello` or mention the bot's Matrix username
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `MATRIX_HOMESERVER_URL` and `MATRIX_ACCESS_TOKEN` are set in `.env` AND synced to `data/env/env`
2. Room is registered in SQLite: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'mx:%'"`
3. For non-main rooms: message includes trigger pattern (`@Andy` or bot's Matrix username)
4. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)
5. Bot has been invited to and joined the room

### E2EE issues

If the bot can't decrypt messages in encrypted rooms:
- Check logs for `Matrix failed to decrypt message` warnings
- The crypto store is at `store/matrix-crypto/` — if corrupted, delete it and restart
- Disable E2EE if not needed: set `MATRIX_E2EE=false` in `.env`
- Some homeservers require explicit key verification — consult your homeserver docs

### Bot not auto-joining rooms

The bot uses `AutojoinRoomsMixin` to accept room invitations automatically. If it's not joining:
- Verify the access token is valid: `curl -H "Authorization: Bearer $TOKEN" 'https://your-server/_matrix/client/v3/account/whoami'`
- Check logs for connection errors

### Getting room ID

If `!chatid` doesn't work:
- Verify the bot is in the room (check room member list in your Matrix client)
- Check that messages are reaching the bot (look for log entries)
- In Element: Room Settings > Advanced > Internal room ID

## After Setup

If running `npm run dev` while the service is active:
```bash
# macOS:
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
npm run dev
# When done testing:
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux:
# systemctl --user stop nanoclaw
# npm run dev
# systemctl --user start nanoclaw
```

## Removal

To remove Matrix integration:

1. Delete `src/channels/matrix.ts` and `src/channels/matrix.test.ts`
2. Remove `import './matrix.js'` from `src/channels/index.ts`
3. Remove `MATRIX_HOMESERVER_URL`, `MATRIX_ACCESS_TOKEN`, `MATRIX_E2EE` from `.env`
4. Remove Matrix registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'mx:%'"`
5. Remove crypto state: `rm -rf store/matrix-state.json store/matrix-crypto/`
6. Uninstall: `npm uninstall matrix-bot-sdk`
7. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
