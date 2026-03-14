---
name: add-signal
description: Add Signal as a channel via an authenticated Android bridge. Keeps Signal-specific runtime logic outside the NanoClaw core.
---

# Add Signal Channel

This skill adds Signal support to NanoClaw without baking Signal runtime code into the core repo. The NanoClaw side stays small: a `SignalChannel` adapter talks to a separate Android bridge over HTTP.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `signal` is already in `applied_skills`, skip to Phase 3.

### Confirm bridge availability

Ask the user:

- Do you already have the Android Signal bridge running?
- If yes, collect:
  - Bridge base URL (example: `http://192.168.1.50:8420`)
  - Bridge bearer token

If not, stop and tell the user they need the companion Android bridge first. This skill only installs the NanoClaw-side adapter.

## Phase 2: Apply Code Changes

### Initialize skills system if needed

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-signal
```

This skill:

- Adds `src/channels/signal.ts`
- Adds `src/channels/signal.test.ts`
- Appends `import './signal.js'` to `src/channels/index.ts`
- Extends `setup/verify.ts` to detect Signal bridge credentials
- Records the application in `.nanoclaw/state.yaml`

### Validate code changes

```bash
npm test
npm run build
```

Build and tests must be clean before proceeding.

## Phase 3: Configure Bridge Access

Add these values to `.env`:

```bash
SIGNAL_BRIDGE_URL=http://<bridge-host>:<port>
SIGNAL_BRIDGE_TOKEN=<bridge-token>
```

Sync the environment into the runtime copy:

```bash
mkdir -p data/env
cp .env data/env/env
```

## Phase 4: Registration

### Discover available chats

List the bridge threads:

```bash
curl -s \
  -H "Authorization: Bearer ${SIGNAL_BRIDGE_TOKEN}" \
  "${SIGNAL_BRIDGE_URL%/}/threads"
```

The bridge should return thread objects with stable IDs. Register NanoClaw chats using JIDs in the form `signal:<threadId>`.

### Register the main chat

```bash
npx tsx setup/index.ts --step register -- \
  --jid "signal:<thread-id>" \
  --name "Signal Main" \
  --folder "signal_main" \
  --trigger "@Andy" \
  --channel signal \
  --is-main \
  --no-trigger-required
```

### Register additional chats

```bash
npx tsx setup/index.ts --step register -- \
  --jid "signal:<thread-id>" \
  --name "<chat-name>" \
  --folder "signal_<chat-name>" \
  --trigger "@Andy" \
  --channel signal
```

## Phase 5: Verify

### Run the built-in verification step

```bash
npx tsx setup/index.ts --step verify
```

`CHANNEL_AUTH` should include `signal`.

### Manual canary

Tell the user:

1. Send a plain text message from the registered Signal chat.
2. For non-main chats, include the trigger word (example: `@Andy hello`).
3. Confirm NanoClaw replies to the same Signal thread.

## Bridge Contract

The bridge API is documented in `SIGNAL_BRIDGE_API.md` in this skill directory. The NanoClaw adapter assumes:

- `GET /health`
- `GET /threads`
- `GET /events?cursor=...`
- `POST /messages`

All requests must use `Authorization: Bearer <token>`.

## Troubleshooting

### Verify does not show `signal`

Check:

1. `SIGNAL_BRIDGE_URL` and `SIGNAL_BRIDGE_TOKEN` exist in `.env`
2. `data/env/env` was refreshed after editing `.env`
3. The bridge responds on `/health`

### Messages do not arrive

Check:

1. The bridge can still read Signal notifications/messages on Android
2. The bridge returns new entries from `/events`
3. The chat is registered in SQLite using the exact `signal:<threadId>` JID

### Replies fail

Check:

1. `POST /messages` works with the same bearer token
2. The bridge is not filtering the NanoClaw sender as unauthorized
3. The thread ID from `/threads` matches the thread ID in incoming `/events`
