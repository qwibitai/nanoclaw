---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate WhatsApp, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run setup scripts automatically. Only pause when user action is required (WhatsApp authentication, configuration choices). Scripts live in `.claude/skills/setup/scripts/` and emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. scanning a QR code, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 1. Check Environment

Run `./.claude/skills/setup/scripts/01-check-environment.sh` and parse the status block.

- If HAS_AUTH=true → note that WhatsApp auth exists, offer to skip step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record PLATFORM, APPLE_CONTAINER, and DOCKER values for step 3

**If NODE_OK=false:**

Node.js is missing or too old. Ask the user if they'd like you to install it. Offer options based on platform:

- macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
- Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm

If brew/nvm aren't installed, install them first (`/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` for brew, `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash` for nvm). After installing Node, re-run the environment check to confirm NODE_OK=true.

## 2. Install Dependencies

Run `./.claude/skills/setup/scripts/02-install-deps.sh` and parse the status block.

**If failed:** Read the tail of `logs/setup.log` to diagnose. Common fixes to try automatically:
1. Delete `node_modules` and `package-lock.json`, then re-run the script
2. If permission errors: suggest running with corrected permissions
3. If specific package fails to build (native modules like better-sqlite3): install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry

Only ask the user for help if multiple retries fail with the same error.

## 3. Container Runtime

Use the environment check results from step 1 to decide which runtime to use:

- PLATFORM=linux → Docker will be used. If the source code still references Apple Container (check for `container system status` in `src/index.ts`), run the `/convert-to-docker` skill first, then continue.
- PLATFORM=macos + APPLE_CONTAINER=installed → use apple-container
- PLATFORM=macos + DOCKER=running + APPLE_CONTAINER=not_found → use Docker. If the source code still references Apple Container, run the `/convert-to-docker` skill first.
- PLATFORM=macos + DOCKER=installed_not_running → start Docker for them: `open -a Docker`. Wait 15s, re-check with `docker info`. If still not running, tell the user Docker is starting up and poll a few more times. Then apply `/convert-to-docker` if source code needs it.
- Neither available → AskUserQuestion: Apple Container (recommended for macOS) vs Docker?
  - **If Docker chosen:** install it, then run the `/convert-to-docker` skill to update the source code.
  - Apple Container: tell user to download from https://github.com/apple/container/releases and install the .pkg. Wait for confirmation, then verify with `container --version`.
  - Docker on macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download.
  - Docker on Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

Run `./.claude/skills/setup/scripts/03-setup-container.sh --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- If it's a cache issue (stale layers): run `container builder stop && container builder rm && container builder start` (Apple Container) or `docker builder prune -f` (Docker), then retry.
- If Dockerfile syntax or missing files: diagnose from the log and fix.
- Retry the build script after fixing.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Claude Authentication (No Script)

If HAS_ENV=true from step 1, read `.env` and check if it already has `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. If so, confirm with user: "You already have Claude credentials configured. Want to keep them or reconfigure?" If keeping, skip to step 5.

AskUserQuestion: Claude subscription (Pro/Max) vs Anthropic API key?

**Subscription:** Tell the user:
1. Open another terminal and run: `claude setup-token`
2. Copy the token it outputs
3. Add it to the `.env` file in the project root: `CLAUDE_CODE_OAUTH_TOKEN=<token>`
4. Let me know when done

Do NOT ask the user to paste the token into the chat. Do NOT use AskUserQuestion to collect the token. Just tell them what to do, then wait for confirmation that they've added it to `.env`. Once confirmed, verify the `.env` file has the key.

**API key:** Tell the user to add `ANTHROPIC_API_KEY=<key>` to the `.env` file in the project root, then let you know when done. Once confirmed, verify the `.env` file has the key.

## 5. WhatsApp Authentication

If HAS_AUTH=true from step 1, confirm with user: "WhatsApp credentials already exist. Want to keep them or re-authenticate?" If keeping, skip to step 6.

AskUserQuestion: QR code in browser (recommended) vs pairing code vs QR code in terminal?

- **QR browser:** Run `./.claude/skills/setup/scripts/04-auth-whatsapp.sh --method qr-browser` (Bash timeout: 150000ms)
- **Pairing code:** Ask for phone number first (country code, no + or spaces, e.g. 14155551234). Run `./.claude/skills/setup/scripts/04-auth-whatsapp.sh --method pairing-code --phone NUMBER` (Bash timeout: 150000ms). Display the PAIRING_CODE from the status block with instructions.
- **QR terminal:** Run `./.claude/skills/setup/scripts/04-auth-whatsapp.sh --method qr-terminal`. Tell user to run `cd PROJECT_PATH && npm run auth` in another terminal. Wait for confirmation.

If AUTH_STATUS=already_authenticated → skip ahead.

**If failed:**
- qr_timeout → QR expired. Automatically re-run the auth script to generate a fresh QR. Tell user a new QR is ready.
- logged_out → Delete `store/auth/` and re-run auth automatically.
- 515 → Stream error during pairing. The auth script handles reconnection, but if it persists, re-run the auth script.
- timeout → Auth took too long. Ask user if they scanned/entered the code, offer to retry.

## 6. Configure Trigger and Channel Type

First, determine the phone number situation. Get the bot's WhatsApp number from `store/auth/creds.json`:
`node -e "const c=require('./store/auth/creds.json');console.log(c.me.id.split(':')[0].split('@')[0])"`

AskUserQuestion: Does the bot share your personal WhatsApp number, or does it have its own dedicated phone number?

AskUserQuestion: What trigger word? (default: Andy). In group chats, messages starting with @TriggerWord go to Claude. In the main channel, no prefix needed.

AskUserQuestion: Main channel type? (options depend on phone number setup)

**If bot shares user's number (same phone):**
1. Self-chat (chat with yourself) — Recommended. You message yourself and the bot responds.
2. Solo group (just you) — A group where you're the only member. Good if you want message history separate from self-chat.

**If bot has its own dedicated phone number:**
1. DM with the bot — Recommended. You message the bot's number directly.
2. Solo group with the bot — A group with just you and the bot, no one else.

Do NOT show options that don't apply to the user's setup. For example, don't offer "DM with the bot" if the bot shares the user's number (you can't DM yourself on WhatsApp).

## 7. Sync and Select Group (If Group Channel)

**For personal chat:** The JID is the bot's own phone number from step 6. Construct as `NUMBER@s.whatsapp.net`.

**For DM with bot's dedicated number:** Ask for the bot's phone number, construct JID as `NUMBER@s.whatsapp.net`.

**For group (solo or with bot):**
1. Run `./.claude/skills/setup/scripts/05-sync-groups.sh` (Bash timeout: 60000ms)
2. **If BUILD=failed:** Read `logs/setup.log`, fix the TypeScript error, re-run.
3. **If GROUPS_IN_DB=0:** Check `logs/setup.log` for the sync output. Common causes: WhatsApp auth expired (re-run step 5), connection timeout (re-run sync script with longer timeout).
4. Run `./.claude/skills/setup/scripts/05b-list-groups.sh` to get groups (pipe-separated JID|name lines). Do NOT display the output to the user.
5. Pick the most likely candidates (e.g. groups with the trigger word or "NanoClaw" in the name, small/solo groups) and present them as AskUserQuestion options — show names only, not JIDs. Include an "Other" option if their group isn't listed. If they pick Other, search by name in the DB or re-run with a higher limit.

## 8. Register Channel

Run `./.claude/skills/setup/scripts/06-register-channel.sh` with args:
- `--jid "JID"` — from step 7
- `--name "main"` — always "main" for the first channel
- `--trigger "@TriggerWord"` — from step 6
- `--folder "main"` — always "main" for the first channel
- `--no-trigger-required` — if personal chat, DM, or solo group
- `--assistant-name "Name"` — if trigger word differs from "Andy"

## 9. Mount Allowlist

AskUserQuestion: Want the agent to access directories outside the NanoClaw project? (Git repos, project folders, documents, etc.)

**If no:** Run `./.claude/skills/setup/scripts/07-configure-mounts.sh --empty`

**If yes:** Collect directory paths and permissions (read-write vs read-only). Ask about non-main group read-only restriction (recommended: yes). Build the JSON and pipe it to the script:

`echo '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}' | ./.claude/skills/setup/scripts/07-configure-mounts.sh`

Tell user how to grant a group access: add `containerConfig.additionalMounts` to their entry in `data/registered_groups.json`.

## 10. Start Service

If the service is already running (check `launchctl list | grep nanoclaw` on macOS), unload it first: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` — then proceed with a clean install.

Run `./.claude/skills/setup/scripts/08-setup-service.sh` and parse the status block.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- Common fix: plist already loaded with different path. Unload the old one first, then re-run.
- On macOS: check `launchctl list | grep nanoclaw` to see if it's loaded with an error status. If the PID column is `-` and the status column is non-zero, the service is crashing. Read `logs/nanoclaw.error.log` for the crash reason and fix it (common: wrong Node path, missing .env, missing auth).
- On Linux: check `systemctl --user status nanoclaw` for the error and fix accordingly.
- Re-run the setup-service script after fixing.

## 11. Verify

Run `./.claude/skills/setup/scripts/09-verify.sh` and parse the status block.

**If STATUS=failed, fix each failing component:**
- SERVICE=stopped → run `npm run build` first, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux). Re-check.
- SERVICE=not_found → re-run step 10.
- CREDENTIALS=missing → re-run step 4.
- WHATSAPP_AUTH=not_found → re-run step 5.
- REGISTERED_GROUPS=0 → re-run steps 7-8.
- MOUNT_ALLOWLIST=missing → run `./.claude/skills/setup/scripts/07-configure-mounts.sh --empty` to create a default.

After fixing, re-run `09-verify.sh` to confirm everything passes.

Tell user to test: send a message in their registered chat (with or without trigger depending on channel type).

Show the log tail command: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common causes: wrong Node path in plist (re-run step 10), missing `.env` (re-run step 4), missing WhatsApp auth (re-run step 5).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure the container runtime is running — start it: `container system start` (Apple Container) or `open -a Docker` (macOS Docker). Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Verify the trigger pattern matches. Main channel and personal/solo chats don't need a prefix. Check the registered JID in the database: `sqlite3 store/messages.db "SELECT * FROM registered_groups"`. Check `logs/nanoclaw.log`.

**Messages sent but not received (DMs):** WhatsApp may use LID (Linked Identity) JIDs. Check logs for LID translation. Verify the registered JID has no device suffix (should be `number@s.whatsapp.net`, not `number:0@s.whatsapp.net`).

**WhatsApp disconnected:** Run `npm run auth` to re-authenticate, then `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw`.

**Unload service:** `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
