---
name: add-signal
description: Add Signal as a messaging channel using signal-cli. Can replace WhatsApp or run alongside it.
---

# Add Signal Channel

Deploy Signal support in NanoClaw using the signal-cli REST API container. This skill creates the Signal channel implementation, configures the sidecar container, links the Signal account, wires everything into the main application, and optionally adds rich features (profile customisation, stickers, group management, IPC handlers for container agents).

For architecture details and security considerations, see [docs/SIGNAL.md](../../../docs/SIGNAL.md).

## Architecture

NanoClaw uses a **Channel abstraction** (`Channel` interface in `src/types.ts`). The Signal channel follows the same pattern as WhatsApp and Telegram:

| File | Purpose |
|------|---------|
| `src/types.ts` | `Channel` interface definition |
| `src/channels/signal.ts` | `SignalChannel` class |
| `src/signal/client.ts` | WebSocket (receiving) and REST (sending) client |
| `src/config.ts` | Signal configuration exports |
| `src/router.ts` | `findChannel()`, `routeOutbound()`, `formatOutbound()` |
| `src/index.ts` | Orchestrator: creates channels, wires callbacks, starts subsystems |

The channel implements `connect`, `sendMessage`, `ownsJid`, `disconnect`, and `setTyping`. Inbound messages are delivered via `onMessage` / `onChatMetadata` callbacks, and the existing message loop in `src/index.ts` picks them up automatically.

## Phase 1: Collect Configuration

Gather all required information before starting deployment.

### Step 1: Detect container runtime

```bash
HAS_DOCKER=$(command -v docker >/dev/null 2>&1 && echo "yes" || echo "no")
```

- If Docker is not found, stop and tell the user they need Docker installed first. The signal-cli REST API runs as a Docker sidecar container.

### Step 2: Ask preference questions

Use `AskUserQuestion` with the applicable questions. Batch as many questions as possible into single `AskUserQuestion` calls (up to 4 per call) for a smoother experience.

**First question batch:**

```json
[
  {
    "question": "What level of Signal integration do you need?",
    "header": "Features",
    "options": [
      {"label": "Full features (Recommended)", "description": "Send/receive plus profile, stickers, group management, IPC handlers"},
      {"label": "Basic channel only", "description": "Just send and receive messages"}
    ],
    "multiSelect": false
  },
  {
    "question": "Should Signal replace WhatsApp or run alongside it?",
    "header": "Mode",
    "options": [
      {"label": "Run alongside (Recommended)", "description": "Both Signal and WhatsApp channels active"},
      {"label": "Replace WhatsApp", "description": "Signal becomes the only channel"}
    ],
    "multiSelect": false
  },
  {
    "question": "Who should the bot respond to within registered chats?",
    "header": "Sender filter",
    "options": [
      {"label": "Specific numbers only (Recommended)", "description": "Only approved phone numbers are processed within registered chats"},
      {"label": "All members", "description": "Anyone in a registered chat can trigger the agent"}
    ],
    "multiSelect": false
  }
]
```

**Second question batch - Main channel setup:**

> **Important: Your "main" channel is your admin control portal.**
>
> The main channel has elevated privileges:
> - Can see messages from ALL other registered groups
> - Can manage and delete tasks across all groups
> - Can write to global memory that all groups can read
> - Has read-write access to the entire NanoClaw project
>
> **Recommendation:** Use a DM with the bot's number (Note to Self equivalent) or a solo Signal group as your main channel. This ensures only you have admin control.

```json
[
  {
    "question": "Which setup will you use for your main channel?",
    "header": "Main channel",
    "options": [
      {"label": "DM with a specific number (Recommended)", "description": "Your personal number messaging the bot. Only you have admin control."},
      {"label": "Solo Signal group (just me)", "description": "A Signal group with only you in it."},
      {"label": "Group with other people", "description": "Everyone in the group gets admin privileges (security implications)."}
    ],
    "multiSelect": false
  }
]
```

If they choose "Group with other people", ask a follow-up confirmation:

```json
[
  {
    "question": "Are you sure? Everyone in the group will be able to read messages from other chats, schedule tasks, and access mounted directories.",
    "header": "Confirm",
    "options": [
      {"label": "Yes, I understand", "description": "Proceed with a shared admin group"},
      {"label": "No, use a DM instead", "description": "Switch to a private DM as main channel"}
    ],
    "multiSelect": false
  }
]
```

### Step 3: Collect text inputs

Ask for required text values based on Step 2 answers:

**Always ask:**
- Bot's phone number (E.164 format, e.g., `+61412345678`)

**If main channel is "DM with a specific number":**
- The phone number to use as the main channel DM (e.g., the user's personal number). The JID will be `signal:<phoneNumber>`.

**If main channel is a group:**
- Tell the user they'll select the group after Signal is linked (Step 13), since groups can't be queried until the account is connected.

**If "Specific numbers only" was selected:**
- Allowed sender numbers (comma-separated E.164)

**If "Full features" was selected:**
- Bot display name (optional, max 26 characters, e.g., "NanoClaw" or "Jarvis")
- Bot status text (optional, max 140 characters)

### Step 4: Configuration summary

Display a summary table and confirm before deployment:

> **Signal Channel Configuration**
>
> | Setting | Value |
> |---------|-------|
> | Runtime | Docker |
> | Features | Full |
> | Phone number | +61412345678 |
> | Display name | Jarvis |
> | Sender filter | All members |
> | Mode | Run alongside WhatsApp |
> | Main channel | DM with +61498765432 |
>
> Proceed with deployment?

Once confirmed, execute all implementation steps without further interaction.

## Phase 1.5: Pre-flight Checks

Before starting implementation, check what already exists to avoid duplicate work or overwriting previous configuration.

```bash
# Check for existing Signal source files
ls src/signal/client.ts src/channels/signal.ts src/ipc-signal.ts 2>/dev/null

# Check for existing .env Signal configuration
grep -E '^SIGNAL_' .env 2>/dev/null

# Check for existing Signal registration in DB
sqlite3 store/messages.db "SELECT jid FROM registered_groups WHERE jid LIKE 'signal:%'" 2>/dev/null

# Check for existing docker-compose with signal-cli
grep signal-cli docker-compose.yml 2>/dev/null

# Check if signal-cli container is already running
docker ps --filter "name=signal-cli" --format "{{.Names}}" 2>/dev/null

# Check plist working directory matches current project
grep WorkingDirectory ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null
```

Use these results to skip steps that are already complete:
- If Signal source files exist, skip Steps 1-4 (file copies and config merge)
- If `.env` already has `SIGNAL_ACCOUNT`, skip Step 9 (but verify values match Phase 1 answers)
- If the DB already has a `signal:` registration, skip Step 12
- If `docker-compose.yml` already has `signal-cli`, skip Step 6
- If the signal-cli container is already running and healthy, skip Steps 6-7
- If the plist `WorkingDirectory` doesn't match `pwd`, update it in Step 10

## Phase 2: Implementation

### Step 1: Install WebSocket Dependency

```bash
npm install ws @types/ws
```

### Step 2: Create Signal Client

Copy `src/signal/client.ts` from the skill's source files into the project:

```bash
mkdir -p src/signal
cp <skill>/src/signal/client.ts src/signal/client.ts
cp <skill>/src/signal/poll-store.ts src/signal/poll-store.ts
```

`client.ts` handles all HTTP and WebSocket communication with the signal-cli REST API, including message sending (v1/v2), reactions, polls, stickers, group management, profile updates, typing indicators, receipts, and the WebSocket event stream.

`poll-store.ts` provides an in-memory poll vote accumulator. Signal has no server-side vote aggregation, so NanoClaw must track votes itself by listening to `pollCreate`, `pollVote`, and `pollTerminate` WebSocket events. The store registers poll metadata when polls are created (either by the bot via IPC or by other users via the event stream), records per-voter selections as they arrive, and exposes aggregated results via `getPollResults()` and `getChatPolls()`. Votes are ephemeral and lost on process restart.

### Step 3: Create Signal Channel

Copy `src/channels/signal.ts` from the skill's source files:

```bash
mkdir -p src/channels
cp <skill>/src/channels/signal.ts src/channels/signal.ts
```

`SignalChannel` implements the `Channel` interface (`connect`, `sendMessage`, `ownsJid`, `disconnect`, `setTyping`). It uses the WebSocket stream from `client.ts` for inbound messages and the REST API for outbound. Inbound messages are filtered by `SIGNAL_ALLOW_FROM` if configured, and delivered via the shared `onMessage` / `onChatMetadata` callbacks.

### Step 4: Update Configuration

Merge the contents of `src/config-signal.ts` into `src/config.ts` (add near other channel configuration exports):

```bash
cat <skill>/src/config-signal.ts  # review contents, then merge manually
```

### Step 5: Update Main Application

Modify `src/index.ts` to introduce multi-channel support. **First, read the file** to check whether it already has a `channels: Channel[]` array (from a previous channel integration like Telegram). If it does, skip sub-steps 5.1 through 5.7 and only add the Signal-specific channel creation in the `main()` function.

If the file still uses a single hardcoded WhatsApp channel, apply all sub-steps below to convert it to a `channels[]` array.

**Patch approach:** Each sub-step describes the semantic location (function name, surrounding context) and shows the target code alongside the replacement. Always read `src/index.ts` first, then locate each patch point by intent rather than exact string match, since upstream may have changed formatting or variable names. The code blocks below are reference examples, not exact strings to match.

#### 5.1. Add imports

At the top of `src/index.ts`, add:

```typescript
import { SignalChannel } from './channels/signal.js';
import { findChannel, formatOutbound } from './router.js';
import { Channel } from './types.js';
import {
  SIGNAL_ACCOUNT,
  SIGNAL_HTTP_HOST,
  SIGNAL_HTTP_PORT,
  SIGNAL_ALLOW_FROM,
  SIGNAL_ONLY,
} from './config.js';
```

Note: `formatOutbound` is already imported from `./router.js` in the existing code. Add `findChannel` to the existing import. Add `Channel` to the existing `./types.js` import (which currently imports `NewMessage` and `RegisteredGroup`).

#### 5.2. Add channels array

Replace the existing:

```typescript
let whatsapp: WhatsAppChannel;
```

with:

```typescript
let whatsapp: WhatsAppChannel;
const channels: Channel[] = [];
```

#### 5.3. Update `processGroupMessages`

The existing function has two direct `whatsapp` references that must use channel lookup instead.

**Replace** the typing + send calls. Find this block (around the `await whatsapp.setTyping(chatJid, true)` call):

```typescript
  await whatsapp.setTyping(chatJid, true);
```

Replace with:

```typescript
  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel found for JID');
    return true;
  }
  await channel.setTyping?.(chatJid, true);
```

Find the corresponding:

```typescript
  await whatsapp.setTyping(chatJid, false);
```

Replace with:

```typescript
  await channel.setTyping?.(chatJid, false);
```

**Replace** the send call inside the `onOutput` callback. Find:

```typescript
        await whatsapp.sendMessage(chatJid, `${ASSISTANT_NAME}: ${text}`);
```

Replace with:

```typescript
        const formatted = formatOutbound(text);
        if (formatted) await channel.sendMessage(chatJid, formatted);
```

#### 5.4. Update `startMessageLoop`

The message loop has a direct `whatsapp.setTyping` call when piping messages to an active container. Find:

```typescript
            whatsapp.setTyping(chatJid, true);
```

Replace with:

```typescript
            const pipeChannel = findChannel(channels, chatJid);
            pipeChannel?.setTyping?.(chatJid, true);
```

#### 5.5. Update `getAvailableGroups`

The existing filter only matches WhatsApp JIDs. Find:

```typescript
    .filter((c) => c.jid !== '__group_sync__' && c.jid.endsWith('@g.us'))
```

Replace with:

```typescript
    .filter((c) =>
      c.jid !== '__group_sync__' &&
      (c.jid.endsWith('@g.us') || c.jid.startsWith('signal:')),
    )
```

#### 5.6. Update `main()` function

The existing `main()` creates WhatsApp unconditionally and wires subsystems directly to it. Replace the channel creation and subsystem wiring section.

**Replace** the WhatsApp creation block (from `whatsapp = new WhatsAppChannel({` through `await whatsapp.connect();`):

```typescript
  // Shared callbacks for all channels
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => storeMessage(msg),
    onChatMetadata: (chatJid: string, timestamp: string, name?: string) =>
      storeChatMetadata(chatJid, timestamp, name),
    registeredGroups: () => registeredGroups,
  };

  // Create channels based on configuration
  if (!SIGNAL_ONLY) {
    whatsapp = new WhatsAppChannel(channelOpts);
    channels.push(whatsapp);
    await whatsapp.connect();
  }

  if (SIGNAL_ACCOUNT) {
    const signal = new SignalChannel({
      ...channelOpts,
      account: SIGNAL_ACCOUNT,
      httpHost: SIGNAL_HTTP_HOST,
      httpPort: SIGNAL_HTTP_PORT,
      allowFrom: SIGNAL_ALLOW_FROM,
    });
    channels.push(signal);
    await signal.connect();
  }

  if (channels.length === 0) {
    logger.error('No channels configured. Set SIGNAL_ACCOUNT or disable SIGNAL_ONLY.');
    process.exit(1);
  }
```

**Replace** the `startSchedulerLoop` call. The existing `sendMessage` callback is hardcoded to WhatsApp. Find:

```typescript
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (text) await whatsapp.sendMessage(jid, text);
    },
  });
```

Replace with:

```typescript
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const ch = findChannel(channels, jid);
      if (!ch) { logger.warn({ jid }, 'No channel for scheduled message'); return; }
      const text = formatOutbound(rawText);
      if (text) await ch.sendMessage(jid, text);
    },
  });
```

**Replace** the `startIpcWatcher` call. The existing `sendMessage` callback is hardcoded to WhatsApp. Find:

```typescript
  startIpcWatcher({
    sendMessage: (jid, text) => whatsapp.sendMessage(jid, text),
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: (force) => whatsapp.syncGroupMetadata(force),
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
```

Replace with:

```typescript
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const ch = findChannel(channels, jid);
      if (!ch) { logger.warn({ jid }, 'No channel for IPC message'); return; }
      await ch.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: async (force) => {
      // Only WhatsApp has group metadata sync; other channels discover groups inline
      if (whatsapp) await whatsapp.syncGroupMetadata(force);
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
  });
```

#### 5.7. Update shutdown handler

Find:

```typescript
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    await whatsapp.disconnect();
    process.exit(0);
  };
```

Replace with:

```typescript
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
```

### Step 6: Start Signal Sidecar Container

Pin to a specific version. Signal-cli must stay compatible with Signal's servers. The `MODE=json-rpc` environment variable is required for WebSocket message streaming.

Check whether `docker-compose.yml` exists first. If it does, add the `signal-cli` service to the existing file rather than overwriting it.

**Important:** The container must be named `signal-cli` (not `nanoclaw-signal-cli` or any `nanoclaw-*` name) because the NanoClaw startup code kills all Docker containers matching the `nanoclaw-*` prefix as orphaned agent containers. This naming convention applies to all sidecar containers that should persist across restarts.

```yaml
services:
  signal-cli:
    image: bbernhard/signal-cli-rest-api:0.97
    container_name: signal-cli
    environment:
      - MODE=json-rpc
    volumes:
      - signal-cli-data:/home/.local/share/signal-cli
    ports:
      - "8080:8080"
    restart: unless-stopped

volumes:
  signal-cli-data:
```

```bash
docker compose up -d signal-cli
```

### Step 7: Wait for Container Readiness

```bash
until curl -sf http://localhost:8080/v1/health > /dev/null 2>&1; do
  echo "Waiting for signal-cli to start..."
  sleep 2
done
echo "signal-cli is ready"
```

### Step 8: Link Signal Account

Detect the machine's local IP address to build the QR code URL:

```bash
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
SIGNAL_PORT=$(grep SIGNAL_HTTP_PORT .env 2>/dev/null | cut -d= -f2 || echo 8080)
echo "http://${LOCAL_IP}:${SIGNAL_PORT}/v1/qrcodelink?device_name=nanoclaw"
```

Tell the user, substituting the detected IP and port into the URL:

> Link your Signal account:
> 1. Open **http://LOCAL_IP:PORT/v1/qrcodelink?device_name=nanoclaw** in any browser (phone or computer)
> 2. Open Signal on your phone > **Settings** > **Linked Devices** > **Link New Device**
> 3. Scan the QR code shown in the browser
>
> The QR code expires quickly. Refresh if it fails.

Wait for the user to confirm they've linked the account, then verify in container logs:

```bash
docker logs signal-cli 2>&1 | tail -20
```

Look for "Successfully linked" or similar confirmation.

**If linking fails:**
1. Restart the container and generate a fresh QR code
2. Ensure the Signal app is updated to the latest version
3. If the account already has 4 linked devices, the user must unlink one first (Signal Settings > Linked Devices)
4. If repeated failures occur, ask the user to confirm the linking worked before continuing

### Step 9: Update Environment

Add to `.env` (use the phone number collected in Phase 1):

```bash
SIGNAL_ACCOUNT=+61412345678
SIGNAL_HTTP_HOST=127.0.0.1
SIGNAL_HTTP_PORT=8080
```

If "Replace WhatsApp" was selected, also add:

```bash
SIGNAL_ONLY=true
```

If "Specific numbers only" was selected, also add:

```bash
SIGNAL_ALLOW_FROM=+61412345678,+61498765432
```

Sync to container environment:

```bash
mkdir -p data/env
cp .env data/env/env
```

### Step 10: Update launchd Environment (macOS)

The launchd plist doesn't read `.env` files. Add these keys to `~/Library/LaunchAgents/com.nanoclaw.plist` inside `EnvironmentVariables`:

```xml
<key>SIGNAL_ACCOUNT</key>
<string>+61412345678</string>
<key>SIGNAL_HTTP_HOST</key>
<string>127.0.0.1</string>
<key>SIGNAL_HTTP_PORT</key>
<string>8080</string>
```

Add `SIGNAL_ONLY` and `SIGNAL_ALLOW_FROM` keys if those variables were configured in Step 10.

### Step 11: Build and Restart

```bash
npm run build
```

Verify build succeeded before continuing. If build fails, fix errors before proceeding.

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

### Step 12: Register Main Channel

Use the main channel type and phone number collected in Phase 1, Step 2-3.

#### 12a. Get the main channel JID

**For DM** (collected in Phase 1):

The JID is `signal:<phoneNumber>` using the phone number already collected (e.g. `signal:+61412345678`).

**For group** (selected in Phase 1):

Query the signal-cli REST API to list available groups:

```bash
SIGNAL_ACCOUNT=$(grep SIGNAL_ACCOUNT .env | cut -d= -f2)
curl -s "http://localhost:8080/v1/groups/${SIGNAL_ACCOUNT}" | python3 -m json.tool
```

Show the group names and IDs to the user and ask them to pick one. If no groups appear, tell the user to send a message in their Signal group first, then re-query.

#### 12b. Write the registration

Once you have the JID, write to `data/registered_groups.json`. Create the file if it doesn't exist, or merge into it if it does.

```bash
mkdir -p data
```

For DMs (no trigger prefix needed), set `requiresTrigger` to `false`:

```json
{
  "signal:+61412345678": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "CURRENT_ISO_TIMESTAMP",
    "requiresTrigger": false
  }
}
```

For groups, keep `requiresTrigger` as `true` (default) unless it's a solo group where the user wants all messages processed:

```json
{
  "signal:group:<groupId>": {
    "name": "main",
    "folder": "main",
    "trigger": "@ASSISTANT_NAME",
    "added_at": "CURRENT_ISO_TIMESTAMP",
    "requiresTrigger": false
  }
}
```

Replace `ASSISTANT_NAME` with the configured assistant name (check `src/config.ts` for the current value).

Ensure the groups folder exists:

```bash
mkdir -p groups/main/logs
```

#### 12c. Rebuild and restart

```bash
npm run build
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

> **Note:** Use `unload`/`load` (not `kickstart -k`) whenever the plist XML has been modified (e.g. new environment variables in Step 10). `kickstart -k` only restarts the process without re-reading the plist definition.

### Step 13: Test

Tell the user (using the configured assistant name):

> Send a message to your registered Signal chat:
> - **Main channel**: No prefix needed, just send `hello`
> - **Other chats**: `@AssistantName hello`
>
> Check logs: `tail -f logs/nanoclaw.log`

## Phase 3: Enhanced Features (Full features mode only)

**Skip this entire phase if "Basic channel only" was selected in Phase 1.**

### Step 1: Set Initial Profile

If the user provided a display name or status text:

```bash
SIGNAL_ACCOUNT=$(grep SIGNAL_ACCOUNT .env | cut -d= -f2)
curl -X PUT "http://localhost:8080/v1/profiles/${SIGNAL_ACCOUNT}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "YOUR_BOT_NAME",
    "about": "YOUR_STATUS_TEXT"
  }'
```

Replace `YOUR_BOT_NAME` and `YOUR_STATUS_TEXT` with the user's values from Phase 1.


### Step 2: Add IPC Handlers

> Signal IPC handlers follow a two-tier security model: messaging enhancements (reactions, polls, stickers) are available to all registered chats, while account-level actions (profile updates, group management) are restricted to the main group only.

Copy `src/ipc-signal.ts` from the skill's source files into the project as a standalone module:

```bash
cp <skill>/src/ipc-signal.ts src/ipc-signal.ts
```

The file exports a `handleSignalIpc` function that handles all Signal IPC cases. Import and call it from the `default:` case in the `processTaskIpc` switch block in `src/ipc.ts`:

```typescript
// At the top of src/ipc.ts, add:
import { handleSignalIpc } from './ipc-signal.js';

// Replace the default: case with:
default: {
  const registeredGroupsMap = deps.registeredGroups();
  const handled = await handleSignalIpc(
    data as Parameters<typeof handleSignalIpc>[0],
    sourceGroup,
    isMain,
    registeredGroupsMap,
    DATA_DIR,
  );
  if (!handled) {
    logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
  break;
}
```

This approach keeps the Signal IPC handlers in their own module rather than inlining hundreds of lines into the existing switch block.

The file includes:

**Message reference validation (`validateMessageReference`):**

IPC cases that target specific messages (`signal_react`, `signal_remove_reaction`, `signal_delete_message`, `signal_send_receipt`, `signal_edit_message`) validate that the provided author/timestamp pair exists in the messages database before executing. This prevents the agent from hallucinating phone numbers or timestamps. The validation queries the DB directly (not the snapshot file), so it always has the latest data including outbound messages sent during the current session. Three validation modes are supported:

- `exact`: Both `sender` and `source_timestamp` must match (used for reactions)
- `own`: `source_timestamp` must match a message where `is_from_me` is true (used for edit/delete)
- `any`: `source_timestamp` must match any message (used for receipts)

If validation fails, the IPC case logs a warning and breaks without calling the Signal API. The agent sees no response, which is the same behaviour as other IPC failures.

**Important:** The validation function imports `getRecentMessages` from `./db.js`. Ensure this import is added when merging into `src/ipc.ts`.

**Messaging IPC (all groups, scoped to own chats via `authorizeSignalChat`):**
- `signal_react`, `signal_remove_reaction` (validated: exact)
- `signal_create_poll`, `signal_close_poll`, `signal_vote_poll`, `signal_get_poll_results`
- `signal_typing`, `signal_send_sticker`, `signal_list_sticker_packs`
- `signal_send_receipt` (validated: any), `signal_delete_message` (validated: own)

The `signal_create_poll` handler registers new polls in the in-memory poll store so that incoming votes can be tracked. The `signal_get_poll_results` handler reads from the poll store and writes aggregated results to the IPC responses directory using a caller-provided `responseId` for deterministic file lookup.

**Admin IPC (main channel only):**
- `update_signal_profile`
- `signal_create_group`, `signal_update_group`
- `signal_add_group_members`, `signal_remove_group_members`, `signal_quit_group`

### Step 3: Enable Message Timestamps

The container agent needs message timestamps back from `send_message` so it can edit/delete its own messages.

**3.1. Update `Channel` interface in `src/types.ts`:**

Change `sendMessage` to return an optional timestamp:

```typescript
sendMessage(jid: string, text: string): Promise<{ timestamp?: number } | void>;
```

**3.2. Update `routeOutbound` in `src/router.ts`:**

The `routeOutbound` function calls `channel.sendMessage()`, so its return type must match. Change:

```typescript
): Promise<void> {
```

to:

```typescript
): Promise<{ timestamp?: number } | void> {
```

**3.3. Update `SignalChannel.sendMessage` in `src/channels/signal.ts`:**

Change from `Promise<void>` to `Promise<{ timestamp?: number }>` and return the result from `sendMessageExtended`:

```typescript
async sendMessage(jid: string, text: string): Promise<{ timestamp?: number }> {
  if (!this.connected) {
    this.outgoingQueue.push({ jid, text });
    return {};
  }
  try {
    return await this.sendMessageExtended(jid, text);
  } catch (err) {
    this.outgoingQueue.push({ jid, text });
    return {};
  }
}
```

**3.4. Update IPC watcher dep in `src/ipc.ts`:**

Change the `sendMessage` type to return the timestamp:

```typescript
sendMessage: (jid: string, text: string) => Promise<{ timestamp?: number } | void>;
```

And in the message handler, capture the result, store the outbound message in the DB (so validation can verify it), and write the timestamp back:

```typescript
const sendResult = await deps.sendMessage(data.chatJid, data.text);

// Store outbound message in DB so validation can verify it
const outboundTs = (sendResult && 'timestamp' in sendResult) ? sendResult.timestamp : undefined;
const outboundId = outboundTs ? String(outboundTs) : `out-${Date.now()}`;
const outboundSender = data.chatJid.startsWith('signal:') ? SIGNAL_ACCOUNT : ASSISTANT_NAME;
storeMessage({
  id: outboundId,
  chat_jid: data.chatJid,
  sender: outboundSender,
  sender_name: ASSISTANT_NAME,
  content: data.text,
  timestamp: new Date().toISOString(),
  source_timestamp: outboundTs,
  is_from_me: true,
});

// Append to the live snapshot so the container agent can see
// its own messages via get_recent_messages
const snapshotPath = path.join(ipcBaseDir, sourceGroup, 'recent_messages.json');
try {
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
  snapshot.messages.push({
    source_timestamp: outboundTs ?? null,
    sender_id: outboundSender,
    sender_name: ASSISTANT_NAME,
    content: data.text.slice(0, 200),
    timestamp: new Date().toISOString(),
    is_from_me: true,
  });
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
} catch {
  // Snapshot may not exist yet; non-fatal
}

// Write timestamp back to agent if responseId was provided
if (data.responseId && sendResult && 'timestamp' in sendResult) {
  const responsesDir = path.join(ipcBaseDir, sourceGroup, 'responses');
  fs.mkdirSync(responsesDir, { recursive: true });
  fs.writeFileSync(
    path.join(responsesDir, `${data.responseId}.json`),
    JSON.stringify({ timestamp: sendResult.timestamp }),
  );
}
```

**Note:** Import `storeMessage` from `./db.js` at the top of `src/ipc.ts`.

**3.5. Update IPC watcher callback in `src/index.ts`:**

The `sendMessage` callback in `startIpcWatcher` must return the channel result:

```typescript
sendMessage: async (jid, text) => {
  const ch = findChannel(channels, jid);
  if (!ch) { logger.warn({ jid }, 'No channel for IPC message'); return; }
  return await ch.sendMessage(jid, text);
},
```

Now the chat context changes:

**3.6. Add `chatName` and `responses/` directory to `src/container-runner.ts`:**

Find the `ContainerInput` interface and add `chatName`:

```typescript
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  chatName?: string;  // <-- add this
  isMain: boolean;
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
}
```

Also find the IPC directory creation block (where `messages/`, `tasks/`, and `input/` subdirectories are created with `mkdirSync`) and add a `responses/` directory alongside them:

```typescript
fs.mkdirSync(path.join(groupIpcDir, 'responses'), { recursive: true });
```

This directory must exist before the container starts because the agent's `send_message` tool polls it for timestamp responses.

**3.7. Pass `chatName` from the orchestrator in `src/index.ts`:**

Find the `runContainerAgent` call in the `runAgent` function and add `chatName: group.name`:

```typescript
const output = await runContainerAgent(
  group,
  {
    prompt,
    sessionId,
    groupFolder: group.folder,
    chatJid,
    chatName: group.name,  // <-- add this
    isMain,
  },
  ...
```

**3.8. Add `chatName` to `ContainerInput` in `container/agent-runner/src/index.ts` and pass it as env var:**

Add `chatName?: string` to the `ContainerInput` interface (same as 3a), then find the MCP server env block and add `NANOCLAW_CHAT_NAME`:

```typescript
env: {
  NANOCLAW_CHAT_JID: containerInput.chatJid,
  NANOCLAW_CHAT_NAME: containerInput.chatName || containerInput.groupFolder,  // <-- add this
  NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
  NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
},
```

**3.9. Read the env var in `container/agent-runner/src/ipc-mcp-stdio.ts`:**

Add after the existing `CHAT_JID` line:

```typescript
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const CHAT_JID = chatJid;
const chatName = process.env.NANOCLAW_CHAT_NAME || '';  // <-- add this
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
```

### Step 4: Add Agent MCP Tools

The container agent needs MCP tools to invoke Signal features via IPC. Merge the tool registrations from `<skill>/src/mcp-signal-tools.ts` into `container/agent-runner/src/ipc-mcp-stdio.ts` before the `// Start the stdio transport` line.

**Important:** Do NOT copy `mcp-signal-tools.ts` into `container/agent-runner/src/` as a standalone file. It is a code snippet that references variables (`server`, `z`, `CHAT_JID`, `writeIpcFile`, etc.) from `ipc-mcp-stdio.ts` without its own imports, so TypeScript will fail to compile it as a separate module. Read it as a reference and inline the tool registrations directly into `ipc-mcp-stdio.ts`.

The file contains:

- **Updated `send_message`** - replaces the existing tool to support timestamp responses (needed for edit/delete). The agent sends a `responseId` and polls for the host to write back the sent message timestamp.
- **`get_chat_info`** - exposes chat name, JID, group folder, and main channel status
- **`get_recent_messages`** - reads from a `recent_messages.json` snapshot for sender phone numbers and source timestamps
- **Signal messaging tools (all groups):** `signal_react`, `signal_remove_reaction`, `signal_create_poll`, `signal_close_poll`, `signal_get_poll_results`, `signal_typing`, `signal_send_sticker`, `signal_list_sticker_packs`, `signal_send_receipt`, `signal_delete_message`, `signal_edit_message`, `signal_download_attachment`, `signal_send_with_preview`
- **Admin tools (main channel only):** `signal_update_profile`, `signal_create_group`

All messaging MCP tools include `chatJid: CHAT_JID` in the IPC payload so the host-side handler can verify the action targets a chat owned by the calling group. All `recipient` parameters default to `CHAT_JID` so the agent doesn't need to look up the JID. The `get_recent_messages` tool reads from a `recent_messages.json` snapshot written by the host before each container spawn, providing deterministic sender phone numbers and source timestamps that the agent must use instead of guessing.

### Step 4a: Add Message Metadata to Types and Router

The agent needs sender phone numbers and numeric timestamps in the message XML for Signal tools. Add optional fields to the `NewMessage` interface in `src/types.ts`:

```typescript
export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  sender_id?: string;        // Raw identifier (phone number for Signal)
  content: string;
  timestamp: string;
  source_timestamp?: number;  // Original numeric timestamp from platform
  is_from_me?: boolean;
}
```

Update `formatMessages()` in `src/router.ts` to include the new fields as XML attributes when present:

```typescript
export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) => {
    const attrs = [
      `sender="${escapeXml(m.sender_name)}"`,
      `time="${m.timestamp}"`,
    ];
    if (m.sender_id) attrs.push(`sender_id="${escapeXml(m.sender_id)}"`);
    if (m.source_timestamp) attrs.push(`source_timestamp="${m.source_timestamp}"`);
    return `<message ${attrs.join(' ')}>${escapeXml(m.content)}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}
```

### Step 4b: Add Recent Messages Snapshot

Add a `getRecentMessages` function to `src/db.ts` to query the last N messages for a chat:

```typescript
export function getRecentMessages(
  chatJid: string,
  limit = 50,
): Array<{ id: string; sender: string; sender_name: string; content: string; timestamp: string; is_from_me: number }> {
  const sql = `
    SELECT id, sender, sender_name, content, timestamp, is_from_me
    FROM messages
    WHERE chat_jid = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(chatJid, limit) as Array<{
    id: string; sender: string; sender_name: string; content: string; timestamp: string; is_from_me: number;
  }>;
  return rows.reverse();
}
```

Add a `writeMessagesSnapshot` function to `src/container-runner.ts` (following the same pattern as `writeGroupsSnapshot`):

```typescript
export function writeMessagesSnapshot(
  groupFolder: string,
  messages: Array<{
    id: string;
    sender: string;
    sender_name: string;
    content: string;
    timestamp: string;
    is_from_me: number;
  }>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const file = path.join(groupIpcDir, 'recent_messages.json');
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        messages: messages.map((m) => ({
          source_timestamp: Number(m.id) || null,
          sender_id: m.sender,
          sender_name: m.sender_name,
          content: m.content.slice(0, 200),
          timestamp: m.timestamp,
          is_from_me: Boolean(m.is_from_me),
        })),
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
```

Call it in `src/index.ts` alongside the other snapshots, right after `writeGroupsSnapshot`:

```typescript
writeMessagesSnapshot(group.folder, getRecentMessages(chatJid));
```

### Step 4c: Update Global CLAUDE.md

Add these sections to `groups/global/CLAUDE.md` so the agent knows the correct patterns:

```markdown
## Group Registration

When registering new groups, ALWAYS use the `mcp__nanoclaw__register_group` tool. NEVER write directly to `registered_groups.json` or the database. The IPC tool updates the running process in-memory, so the bot starts responding immediately without a restart.

## Signal Tools: Required Lookup

When using signal_react, signal_remove_reaction, signal_delete_message, signal_send_receipt, signal_edit_message, or signal_close_poll, you MUST call get_recent_messages first to look up the exact sender_id (phone number) and source_timestamp (numeric millisecond timestamp). NEVER guess or fabricate phone numbers or timestamps. These values come from the database and are the only way to target the correct message. The host validates all message references against the snapshot and silently rejects any that don't match.
```

### Step 5: Rebuild Container and Restart

```bash
npm run build
./container/build.sh
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Step 6: Verify Enhancements

Tell the user:

> Signal enhanced features are now available. The agent can use typing indicators, stickers, group management, and profile updates via IPC.
>
> Check logs: `tail -f logs/nanoclaw.log`

## Troubleshooting

### Container not starting

```bash
docker logs signal-cli
```

Common issues:
- Port 8080 in use: Change `SIGNAL_HTTP_PORT` in `.env`, the launchd plist, and the container port mapping (`-p <new-port>:8080`)
- Volume permissions: Ensure container can write to data directory

### Account not linking

1. Verify container is running: `docker ps | grep signal-cli`
2. Test QR endpoint: `curl -sf http://${LOCAL_IP}:8080/v1/qrcodelink?device_name=nanoclaw -o /dev/null && echo "OK" || echo "FAIL"` (where `LOCAL_IP` is from `ipconfig getifaddr en0`)
3. Restart container if endpoint fails
4. Ensure Signal app is up to date

### Messages not received

1. Check container logs for "Successfully linked"
2. Verify chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'signal:%'"`
3. Check `SIGNAL_ALLOW_FROM` if configured
4. Check NanoClaw logs: `tail -f logs/nanoclaw.log`

### Profile update fails

```bash
curl -X PUT "http://localhost:8080/v1/profiles/+YOUR_NUMBER" \
  -H "Content-Type: application/json" \
  -d '{"name": "Test"}'
```

### Sticker packs empty

Sticker packs must be installed on the Signal account first. Install them via the Signal app on your phone.

### IPC handlers not working

1. Check build succeeded: `npm run build`
2. Check NanoClaw restarted: `launchctl list | grep nanoclaw`
3. Check logs for IPC errors: `grep -i "ipc" logs/nanoclaw.log | tail -20`

For additional troubleshooting (WebSocket issues, rate limiting, keeping signal-cli updated), see [docs/SIGNAL.md](../../../docs/SIGNAL.md).

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `SIGNAL_ACCOUNT` | Bot's phone number (E.164) | Required |
| `SIGNAL_HTTP_HOST` | signal-cli container HTTP host | `127.0.0.1` |
| `SIGNAL_HTTP_PORT` | signal-cli container HTTP port | `8080` |
| `SIGNAL_ALLOW_FROM` | Comma-separated allowed numbers | All |
| `SIGNAL_ONLY` | `true` to disable WhatsApp | `false` |
