---
name: add-signal
description: Add Signal as a channel via signal-cli-rest-api. Can run standalone or alongside other channels.
---

# Add Signal Channel

This skill adds Signal support to NanoClaw using `signal-cli-rest-api` for message send/receive.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `signal` is in `applied_skills`, skip to Phase 3 (Setup).

### Ask the user

Collect whether they already have a running `signal-cli-rest-api` instance and a registered Signal account number.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-signal
```

This deterministically:
- Adds `src/channels/signal.ts` (SignalChannel with polling receive loop)
- Adds `src/channels/signal.test.ts`
- Appends `import './signal.js'` to `src/channels/index.ts`
- Adds env keys:
  - `SIGNAL_API_BASE_URL`
  - `SIGNAL_ACCOUNT`
  - `SIGNAL_RECEIVE_INTERVAL_MS`

### Validate

```bash
npm test
npm run build
```

## Phase 3: Setup

### Run signal-cli-rest-api

Example docker run:

```bash
docker run --rm -p 8080:8080 \
  -v "$PWD/.signal-data:/home/.local/share/signal-cli" \
  bbernhard/signal-cli-rest-api:latest
```

Register/link your Signal account with signal-cli-rest-api (per its docs), then set:

```bash
SIGNAL_API_BASE_URL=http://127.0.0.1:8080
SIGNAL_ACCOUNT=+15551234567
SIGNAL_RECEIVE_INTERVAL_MS=2000
```

Sync env for containers:

```bash
mkdir -p data/env && cp .env data/env/env
```

Build and restart NanoClaw.

## Phase 4: Registration

Register Signal chats using these JID formats:
- Direct chat: `signal:+15550001111`
- Group chat: `signal-group:<groupId>`

Mark one as main (`requiresTrigger: false`) if desired.

## Phase 5: Verify

Send a test Signal message from a registered chat and confirm NanoClaw responds.

If no messages arrive, verify:
1. `SIGNAL_API_BASE_URL` and `SIGNAL_ACCOUNT` are set
2. signal-cli-rest-api is reachable
3. chat/group JID is registered in NanoClaw
4. service restarted after config changes
