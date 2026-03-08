---
name: add-napcat
description: Add QQ as a channel via NapCat (OneBot 11 WebSocket protocol). Connects to a running NapCat instance to send and receive QQ messages.
---

# Add NapCat (QQ) Channel

This skill adds QQ messaging support to NanoClaw via [NapCat](https://github.com/NapNeko/NapCatQQ), which implements the OneBot 11 protocol. NanoClaw connects to NapCat's WebSocket server to receive and send QQ messages.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `napcat` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have a running NapCat instance, or do you need help setting one up?

If they have one, collect the WebSocket URL and access token. If not, guide them through setup in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-napcat
```

This deterministically:
- Adds `src/channels/napcat.ts` (NapCatChannel class with self-registration via `registerChannel`)
- Adds `src/channels/napcat.test.ts` (unit tests)
- Appends `import './napcat.js'` to the channel barrel file `src/channels/index.ts`
- Installs the `ws` npm dependency
- Updates `.env.example` with `NAPCAT_WS_URL` and `NAPCAT_ACCESS_TOKEN`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Setup

### Install NapCat (if needed)

If the user doesn't have NapCat running, tell them:

> I need you to set up NapCat first. NapCat is a QQ bot framework that implements the OneBot 11 protocol.
>
> 1. Download NapCat from [GitHub Releases](https://github.com/NapNeko/NapCatQQ/releases)
> 2. Follow the [NapCat documentation](https://napcat.napneko.icu/) for installation
> 3. Log in with your QQ account in NapCat
> 4. Configure NapCat to enable **Forward WebSocket** (正向 WebSocket):
>    - Open NapCat's WebUI (usually at `http://localhost:6099`)
>    - Go to network settings
>    - Enable WebSocket server
>    - Set the host to `0.0.0.0` (or `127.0.0.1` if NanoClaw runs on the same machine)
>    - Set the port (default: `3001`)
>    - Optionally set an access token for security
>    - Save and restart NapCat

Wait for the user to confirm NapCat is running.

### Configure environment

Add to `.env`:

```bash
NAPCAT_WS_URL=ws://127.0.0.1:3001
NAPCAT_ACCESS_TOKEN=<their-token-if-set>
```

- `NAPCAT_WS_URL` — The WebSocket URL of the NapCat instance (required)
- `NAPCAT_ACCESS_TOKEN` — The access token configured in NapCat (optional, but recommended for security)

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> NapCat uses QQ numbers as chat identifiers:
> - **Private chat**: The QQ number of the user (e.g., `qq:123456789`)
> - **Group chat**: The QQ group number (e.g., `qq:987654321`)
>
> You can find group numbers in QQ by right-clicking the group → Group Info.
> Your QQ number is in your QQ profile settings.

Wait for the user to provide the chat ID.

### Register the chat

For a main chat (responds to all messages):

```typescript
registerGroup("qq:<chat-id>", {
  name: "<chat-name>",
  folder: "qq_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For additional chats (trigger-only):

```typescript
registerGroup("qq:<chat-id>", {
  name: "<chat-name>",
  folder: "qq_<group-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered QQ chat:
> - For main chat: Any message works
> - For non-main: @mention the bot in the group
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. NapCat is running and the QQ account is logged in
2. `NAPCAT_WS_URL` is set in `.env` AND synced to `data/env/env`
3. NapCat's WebSocket server is enabled and listening on the configured port
4. Chat is registered in SQLite: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'qq:%'"`
5. For non-main chats: message includes trigger pattern (@mention the bot)
6. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### WebSocket connection fails

1. Verify NapCat is running: check NapCat's WebUI or logs
2. Test WebSocket connectivity: `wscat -c ws://127.0.0.1:3001`
3. If using access token, ensure it matches between `.env` and NapCat config
4. Check firewall rules if NapCat is on a different machine

### Bot sees messages but doesn't respond

1. Check if the chat JID is registered: the format must be `qq:<number>`
2. For group chats, ensure the bot QQ account is a member of the group
3. Check NanoClaw logs for errors: `tail -f logs/nanoclaw.log`

### NapCat disconnects frequently

1. Check NapCat's stability — it may need a QQ client restart
2. NanoClaw auto-reconnects every 5 seconds on disconnect
3. Check NapCat logs for QQ protocol errors

## Removal

To remove NapCat integration:

1. Delete `src/channels/napcat.ts` and `src/channels/napcat.test.ts`
2. Remove `import './napcat.js'` from `src/channels/index.ts`
3. Remove `NAPCAT_WS_URL` and `NAPCAT_ACCESS_TOKEN` from `.env`
4. Remove QQ registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'qq:%'"`
5. Uninstall: `npm uninstall ws`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
