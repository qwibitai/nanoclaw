---
name: add-dingtalk
description: Add DingTalk as a channel. This skill should be used when the user asks to "add DingTalk", "setup DingTalk", "connect DingTalk", "integrate DingTalk", "use DingTalk instead of WhatsApp", or wants to receive and reply to DingTalk messages through NanoClaw. Can replace WhatsApp entirely (DINGTALK_ONLY=true) or run alongside it.
---

# Add DingTalk Channel

This skill adds DingTalk support to NanoClaw using Stream Mode (persistent WebSocket connection, not webhooks), then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `dingtalk` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

1. **Mode**: Replace WhatsApp or add alongside it?
   - Replace → will set `DINGTALK_ONLY=true`
   - Alongside → both channels active (default)

2. **Do they already have a DingTalk app (Client ID + Client Secret)?** If yes, collect them now. If no, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

Or call `initSkillsSystem()` from `skills-engine/migrate.ts`.

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-dingtalk
```

This deterministically:
- Adds `src/channels/dingtalk.ts` (DingTalkChannel class implementing Channel interface)
- Adds `src/channels/dingtalk.test.ts` (unit tests with dingtalk-stream mock)
- Three-way merges DingTalk support into `src/index.ts` (multi-channel support, `registerGroup` callback)
- Three-way merges DingTalk config into `src/config.ts` (6 new exports)
- Three-way merges updated routing tests into `src/routing.test.ts`
- Installs `dingtalk-stream` and `axios` npm dependencies
- Updates `.env.example` with DingTalk config section
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new dingtalk tests) and build must be clean before proceeding.

## Phase 3: Setup

### Create DingTalk App (if needed)

If the user doesn't have app credentials, tell them:

> I need you to create a DingTalk robot app:
>
> 1. Go to [DingTalk Developer Console](https://open-dev.dingtalk.com/) and log in
> 2. Click **Application Development** > **Internal Application** > **Robot**
> 3. Click **Create Application**, fill in the app name (e.g., "Andy Assistant") and description
> 4. In the app settings, copy:
>    - **Client ID** (App Key)
>    - **Client Secret** (App Secret)
> 5. Go to **Capabilities** > **Robot**, enable the robot and note the **Robot Code**
> 6. Go to **Message Receive Mode**, select **Stream Mode** and save
> 7. Click **Publish** to activate the app

Wait for the user to provide the credentials.

### Configure environment

Add to `.env`:

```bash
DINGTALK_CLIENT_ID=<their-client-id>
DINGTALK_CLIENT_SECRET=<their-client-secret>
DINGTALK_ROBOT_CODE=<their-robot-code>
DINGTALK_ALLOWED_USERS=*
DINGTALK_ALLOWED_GROUPS=*
```

If they chose to replace WhatsApp:

```bash
DINGTALK_ONLY=true
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

The container reads environment from `data/env/env`, not `.env` directly.

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Registration

### How auto-registration works

With `DINGTALK_ALLOWED_GROUPS=*`, the first message from any group or DM automatically registers it:

- **Group chat**: registered as `dd:<conversationId>`, folder = `dingtalk-<sanitized-id>`
- **Direct message**: registered as `dd:<senderStaffId>`, folder = `dingtalk-<sanitized-id>`
- Group chats require the trigger word (`@AssistantName`) by default
- Direct messages respond to every message (no trigger required)

To verify after sending a test message:

```bash
sqlite3 store/messages.db "SELECT jid, name, folder FROM registered_groups WHERE jid LIKE 'dd:%'"
```

### Manual registration (when DINGTALK_ALLOWED_GROUPS is restricted)

For a main chat (responds to all messages, uses `main` folder):

```typescript
registerGroup("dd:<conversationId>", {
  name: "<chat-name>",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional chats (trigger-only):

```typescript
registerGroup("dd:<conversationId>", {
  name: "<chat-name>",
  folder: "<folder-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

Finding conversationId: it appears in logs when an unregistered group sends a message:
```
Message from unregistered DingTalk chat - To register this chat, add to DINGTALK_ALLOWED_GROUPS or use: registerGroup("dd:conversationId", {...})
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message in DingTalk to test:
> - **Group chat**: Add the robot to a DingTalk group, then send `@Andy hello`
> - **Direct message**: Open a direct conversation with the robot, send any message
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

1. Check credentials are set in `.env` AND synced to `data/env/env`
2. Verify Stream Mode is enabled in Developer Console (not webhook mode)
3. Check group is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'dd:%'"`
4. For group chats: message must include trigger pattern (`@Andy`)
5. Check service is running: `launchctl list | grep nanoclaw`

### Connection disconnects repeatedly

DingTalk Stream Mode uses WebSocket with automatic reconnection (exponential backoff: 1s → 60s, max 10 attempts). If connection never stabilises:

1. Verify Client ID and Client Secret are correct (copy-paste from Developer Console)
2. Confirm the app is published in Developer Console
3. Check that Stream Mode (not webhook mode) is selected under Message Receive Mode

### Messages not delivered (no session webhook)

DingTalk replies use session webhooks cached from incoming messages. The bot cannot proactively message a chat it hasn't received from. Ensure:
- The user sends at least one message first so the webhook gets cached
- Webhooks expire after ~30 minutes of inactivity — a new message from the user refreshes them

### User not authorized

If `DINGTALK_ALLOWED_USERS` is set to specific StaffIds:
- Find the blocked user's StaffId in logs: `grep "Unauthorized DingTalk user" logs/nanoclaw.log`
- Add their StaffId to `DINGTALK_ALLOWED_USERS` in `.env` and sync to `data/env/env`

### Group not auto-registering

If groups still aren't registering with `DINGTALK_ALLOWED_GROUPS=*`:
- Confirm the robot is added to the group in DingTalk
- In groups, DingTalk only delivers messages to the robot when the robot is @mentioned
- Check for the conversationId in logs: `grep "unregistered DingTalk chat" logs/nanoclaw.log`

## After Setup

The DingTalk channel supports:
- Text messages in group chats and direct messages
- Auto-registration of new chats (with `DINGTALK_ALLOWED_GROUPS=*`)
- User-level access control via `DINGTALK_ALLOWED_USERS` (comma-separated StaffIds)
- Group-level access control via `DINGTALK_ALLOWED_GROUPS` (comma-separated conversationIds)
- Markdown responses (DingTalk renders markdown natively)
- Automatic reconnection with exponential backoff
- Message deduplication (60s TTL, handles DingTalk at-least-once delivery)
