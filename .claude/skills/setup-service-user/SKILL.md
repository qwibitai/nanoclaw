---
name: setup-service-user
description: Create a dedicated low-privilege macOS user to run the NanoClaw orchestrator as a LaunchDaemon, isolating it from the admin account.
---

# Setup Service User

Creates a dedicated `nanoclaw-svc` macOS user and migrates the NanoClaw orchestrator from a per-user LaunchAgent to a system-wide LaunchDaemon. This limits the blast radius from container escapes by running the orchestrator under a low-privilege account.

**macOS only.** Requires sudo access.

## Prerequisites

NanoClaw must already be fully set up and working via `/setup` (WhatsApp/iMessage connected, groups registered, service running as LaunchAgent).

## Phase 1: Pre-flight

Ask the user to confirm:
1. They have sudo access on this machine
2. NanoClaw is currently working (messages flowing)
3. They understand this will migrate from their user's LaunchAgent to a system LaunchDaemon

## Phase 2: Add IMESSAGE_DB_PATH support

If iMessage is enabled (`IMESSAGE_ENABLED=true` in `.env`), the service user needs to access the admin user's `chat.db` at a custom path. Apply these source changes:

1. In `src/config.ts`:
   - Add `'IMESSAGE_DB_PATH'` to the `readEnvFile()` keys array
   - Add export: `export const IMESSAGE_DB_PATH = process.env.IMESSAGE_DB_PATH || envConfig.IMESSAGE_DB_PATH || undefined;`

2. In `src/channels/imessage.ts`:
   - Import `IMESSAGE_DB_PATH` from `'../config.js'`
   - In the `connect()` method, pass it to `IMessageSDK`: `...(IMESSAGE_DB_PATH && { databasePath: IMESSAGE_DB_PATH })`

3. Rebuild: `npm run build`

If iMessage is NOT enabled, skip this phase entirely.

## Phase 3: Run setup script

Run the setup script and parse the status block:

```bash
sudo bash .claude/skills/setup-service-user/scripts/setup-service-user.sh
```

The script:
- Creates the `nanoclaw-svc` macOS user (UID 599, hidden from login screen)
- Clones the project or copies it to `/Users/nanoclaw-svc/nanoclaw`
- Copies `.env`, WhatsApp auth, messages DB, and groups
- Installs dependencies and builds
- Sets up iMessage DB access via a shared group (if enabled)
- Creates a LaunchDaemon at `/Library/LaunchDaemons/com.nanoclaw.plist`
- Unloads the old per-user LaunchAgent
- Creates an `update.sh` script for future updates

**Parse the status block** and report results to user.

**If STATUS=failed:**
- DAEMON_LOADED=false → Check `logs/setup.log` for errors. Common issue: another `com.nanoclaw` daemon already loaded. Run `sudo launchctl unload /Library/LaunchDaemons/com.nanoclaw.plist` first, then re-run.

**If IMESSAGE_ACCESS=needs_fda:**
- Tell user: "Grant Terminal Full Disk Access in System Settings > Privacy & Security > Full Disk Access, then re-run this skill."

## Phase 4: Verify

1. Check the daemon is running: `sudo launchctl list | grep nanoclaw`
2. Send a test message to a registered chat
3. Confirm the response comes back

Tell the user about the update script:
```
sudo /Users/nanoclaw-svc/nanoclaw/update.sh
```
