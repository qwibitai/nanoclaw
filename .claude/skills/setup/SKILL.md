---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate with a messaging channel (WhatsApp, Telegram, or Feishu), register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run setup steps automatically. Only pause when user action is required (WhatsApp authentication, configuration choices). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. scanning a QR code, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules` and `package-lock.json`, re-run `bash setup.sh`. If native module build fails, install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry.
- If NATIVE_OK=false → better-sqlite3 failed to load. Install build tools and re-run.
- Record PLATFORM and IS_WSL for later steps.

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_AUTH=true → note that WhatsApp auth exists, offer to skip step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record APPLE_CONTAINER and DOCKER values for step 3

## 3. Container Runtime

### 3a. Choose runtime

Check the preflight results for `APPLE_CONTAINER` and `DOCKER`, and the PLATFORM from step 1.

- PLATFORM=linux → Docker (only option)
- PLATFORM=macos + APPLE_CONTAINER=installed → Use `AskUserQuestion: Docker (default, cross-platform) or Apple Container (native macOS)?` If Apple Container, run `/convert-to-apple-container` now, then skip to 3c.
- PLATFORM=macos + APPLE_CONTAINER=not_found → Docker (default)

### 3a-docker. Install Docker

- DOCKER=running → continue to 3b
- DOCKER=installed_not_running → start Docker: `open -a Docker` (macOS) or `sudo systemctl start docker` (Linux). Wait 15s, re-check with `docker info`.
- DOCKER=not_found → Use `AskUserQuestion: Docker is required for running agents. Would you like me to install it?` If confirmed:
  - macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download at https://docker.com/products/docker-desktop
  - Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

### 3b. Apple Container conversion gate (if needed)

**If the chosen runtime is Apple Container**, you MUST check whether the source code has already been converted from Docker to Apple Container. Do NOT skip this step. Run:

```bash
grep -q "CONTAINER_RUNTIME_BIN = 'container'" src/container-runtime.ts && echo "ALREADY_CONVERTED" || echo "NEEDS_CONVERSION"
```

**If NEEDS_CONVERSION**, the source code still uses Docker as the runtime. You MUST run the `/convert-to-apple-container` skill NOW, before proceeding to the build step.

**If ALREADY_CONVERTED**, the code already uses Apple Container. Continue to 3c.

**If the chosen runtime is Docker**, no conversion is needed — Docker is the default. Continue to 3c.

### 3c. Build and test

Run `npx tsx setup/index.ts --step container -- --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue (stale layers): `docker builder prune -f` (Docker) or `container builder stop && container builder rm && container builder start` (Apple Container). Retry.
- Dockerfile syntax or missing files: diagnose from the log and fix, then retry.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Choose Messaging Channel

AskUserQuestion: Which messaging channel do you want to use?
- **WhatsApp** (default)
- **Telegram**
- **Feishu / Lark**

You can also enable multiple channels at once (e.g. WhatsApp + Telegram). Record the choice as `CHOSEN_CHANNELS` (comma-separated, lowercase).

Write `CHANNEL=<CHOSEN_CHANNELS>` to `.env` (create the file if it doesn't exist, preserving any existing keys).

---

## 5a. Claude Authentication (No Script)

If HAS_ENV=true from step 2, read `.env` and check for `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. If present, confirm with user: keep or reconfigure?

AskUserQuestion: Claude subscription (Pro/Max) vs Anthropic API key?

**Subscription:** Tell user to run `claude setup-token` in another terminal, copy the token, add `CLAUDE_CODE_OAUTH_TOKEN=<token>` to `.env`. Do NOT collect the token in chat.

**API key:** Tell user to add `ANTHROPIC_API_KEY=<key>` to `.env`.

---

## 5b. Channel Authentication

Run the authentication step(s) for each chosen channel:

### If WhatsApp is chosen

If HAS_AUTH=true, confirm: keep or re-authenticate?

**Choose auth method based on environment (from step 2):**

If IS_HEADLESS=true AND IS_WSL=false → AskUserQuestion: Pairing code (recommended) vs QR code in terminal?
Otherwise (macOS, desktop Linux, or WSL) → AskUserQuestion: QR code in browser (recommended) vs pairing code vs QR code in terminal?

- **QR browser:** `npx tsx setup/index.ts --step whatsapp-auth -- --method qr-browser` (Bash timeout: 150000ms)
- **Pairing code:** Ask for phone number first. `npx tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone NUMBER` (Bash timeout: 150000ms). Display PAIRING_CODE.
- **QR terminal:** `npx tsx setup/index.ts --step whatsapp-auth -- --method qr-terminal`. Tell user to run `npm run auth` in another terminal.

**If failed:** qr_timeout → re-run. logged_out → delete `store/auth/` and re-run. 515 → re-run. timeout → ask user, offer retry.

### If Telegram is chosen

1. Tell the user: "Open Telegram and message **@BotFather**. Send `/newbot`, follow the prompts to name your bot, then copy the **bot token** it gives you."
2. AskUserQuestion: Please paste your Telegram bot token.
3. Write `TELEGRAM_BOT_TOKEN=<token>` to `.env`.
4. Confirm: `node -e "const t=require('fs').readFileSync('.env','utf8');console.log(t.includes('TELEGRAM_BOT_TOKEN') ? 'OK' : 'MISSING')"`

### If Feishu / Lark is chosen

1. Tell the user:
   - Go to [Feishu Open Platform](https://open.feishu.cn/) → **Create app** → Self-built app.
   - Under **Permissions & Scopes**, add: `im:message`, `im:message:send_as_bot`, `im:chat`.
   - Under **Event Subscriptions**, enable **"Use WebSocket to receive events"** and subscribe to the `im.message.receive_v1` event.
   - Copy the **App ID** and **App Secret** from the Credentials page.
2. AskUserQuestion: Please paste your Feishu App ID.
3. AskUserQuestion: Please paste your Feishu App Secret.
4. Write `FEISHU_APP_ID=<id>` and `FEISHU_APP_SECRET=<secret>` to `.env`.

---

## 6. Configure Trigger and Channel Type

**If WhatsApp is chosen:**

Get bot's WhatsApp number: `node -e "const c=require('./store/auth/creds.json');console.log(c.me.id.split(':')[0].split('@')[0])"`

AskUserQuestion: Shared number or dedicated? → AskUserQuestion: Trigger word? → AskUserQuestion: Main channel type?

**Shared number:** Self-chat (recommended) or Solo group
**Dedicated number:** DM with bot (recommended) or Solo group with bot

**If Telegram is chosen:**

AskUserQuestion: Trigger word (default: Andy)?

Main channel will be a Telegram group or DM. The bot will respond to messages starting with `@<TriggerWord>`.

**If Feishu is chosen:**

AskUserQuestion: Group chat or private DM with the bot?
- **Group chat** — Add the bot to a group
- **Private DM** — Chat with the bot directly one-on-one (recommended for personal use)

AskUserQuestion: Trigger word (default: Andy)?

- **Group chat:** Bot responds to messages starting with `@<TriggerWord>`
- **DM:** Trigger word not required — every message is forwarded to the agent

## 7. Sync and Select Group (If Group Channel)

**WhatsApp — Personal chat:** JID = `NUMBER@s.whatsapp.net`
**WhatsApp — DM with bot:** Ask for bot's number, JID = `NUMBER@s.whatsapp.net`

**WhatsApp — Group:**
1. `npx tsx setup/index.ts --step groups` (Bash timeout: 60000ms)
2. BUILD=failed → fix TypeScript, re-run. GROUPS_IN_DB=0 → check logs.
3. `npx tsx setup/index.ts --step groups -- --list` for pipe-separated JID|name lines.
4. Present candidates as AskUserQuestion (names only, not JIDs).

**Telegram — Group:**
1. Tell the user: "Add your bot to the Telegram group, then send any message in it."
2. Tell the user: "Run `npm run dev` briefly, watch the log for a line like `onChatMetadata chatJid=-1001234567890@telegram`. Copy that JID."
3. AskUserQuestion: Paste the Telegram group JID (e.g. `-1001234567890@telegram`).
4. Use that as the JID directly.

**Telegram — DM:**
1. Tell the user to message the bot directly.
2. The JID will be `<user_chat_id>@telegram`. Prompt them to find it the same way as above.

**Feishu — Group chat:**
1. Tell the user: "Add the bot to your Feishu group chat, then send a message."
2. Run `npm run dev` briefly, watch logs for `onChatMetadata chatJid=oc_...@feishu`. Copy that JID.
3. AskUserQuestion: Paste the Feishu group JID (e.g. `oc_abcdef1234@feishu`).

**Feishu — Private DM:**
1. Tell the user: "Open Feishu, search for your bot by name, and send it any message."
2. Run `npm run dev` briefly, watch logs for `onChatMetadata chatJid=...@feishu`. Copy that JID. (DM JIDs start with `ou_` for the user's p2p chat.)
3. AskUserQuestion: Paste the Feishu DM JID.
4. Use `--no-trigger-required` when registering in Step 8 — no trigger word needed for DMs.

## 8. Register Channel

Run `npx tsx setup/index.ts --step register -- --jid "JID" --name "main" --trigger "@TriggerWord" --folder "main"` plus `--no-trigger-required` if personal/DM/solo, `--assistant-name "Name"` if not Andy.

## 9. Mount Allowlist

AskUserQuestion: Agent access to external directories?

**No:** `npx tsx setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

## 10. Start Service

If service already running: unload first.
- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
- Linux: `systemctl --user stop nanoclaw` (or `systemctl stop nanoclaw` if root)

Run `npx tsx setup/index.ts --step service` and parse the status block.

**If FALLBACK=wsl_no_systemd:** WSL without systemd detected. Tell user they can either enable systemd in WSL (`echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf` then restart WSL) or use the generated `start-nanoclaw.sh` wrapper.

**If DOCKER_GROUP_STALE=true:** The user was added to the docker group after their session started — the systemd service can't reach the Docker socket. Ask user to run these two commands:

1. Immediate fix: `sudo setfacl -m u:$(whoami):rw /var/run/docker.sock`
2. Persistent fix (re-applies after every Docker restart):
```bash
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/socket-acl.conf << 'EOF'
[Service]
ExecStartPost=/usr/bin/setfacl -m u:USERNAME:rw /var/run/docker.sock
EOF
sudo systemctl daemon-reload
```
Replace `USERNAME` with the actual username (from `whoami`). Run the two `sudo` commands separately — the `tee` heredoc first, then `daemon-reload`. After user confirms setfacl ran, re-run the service step.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- macOS: check `launchctl list | grep nanoclaw`. If PID=`-` and status non-zero, read `logs/nanoclaw.error.log`.
- Linux: check `systemctl --user status nanoclaw`.
- Re-run the service step after fixing.

## 11. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux) or `bash start-nanoclaw.sh` (WSL nohup)
- SERVICE=not_found → re-run step 10
- CREDENTIALS=missing → re-run step 4
- WHATSAPP_AUTH=not_found → re-run step 5
- REGISTERED_GROUPS=0 → re-run steps 7-8
- MOUNT_ALLOWLIST=missing → `npx tsx setup/index.ts --step mounts -- --empty`

Tell user to test: send a message in their registered chat. Show: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 10), missing `.env` (step 4), missing auth (step 5).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure the container runtime is running — `open -a Docker` (macOS Docker), `container system start` (Apple Container), or `sudo systemctl start docker` (Linux). Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Check trigger pattern. Main channel doesn't need prefix. Check DB: `npx tsx setup/index.ts --step verify`. Check `logs/nanoclaw.log`.

**WhatsApp disconnected:** `npm run auth` then rebuild and restart: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux).

**Telegram bot not responding:** Confirm `TELEGRAM_BOT_TOKEN` is correctly set in `.env`. Check that the bot was added to the group and has permission to read messages (disable privacy mode via @BotFather → `/setprivacy` → Disable).

**Feishu bot not responding:** Confirm `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set. Ensure WebSocket event subscription is enabled and `im.message.receive_v1` is subscribed. Check that the bot is added to the target group.

**Unload service:** macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` | Linux: `systemctl --user stop nanoclaw`
