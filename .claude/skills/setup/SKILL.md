---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate messaging channels, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run setup steps automatically. Only pause when user action is required (channel authentication, configuration choices). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. authenticating a channel, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for multiple-choice questions only (e.g. "Docker or Apple Container?", "which channels?"). Do NOT use it when free-text input is needed (e.g. phone numbers, tokens, paths) — just ask the question in plain text and wait for the user's reply.

## 0. Git & Fork Setup

Check the git remote configuration to ensure the user has a fork and upstream is configured.

Run:
- `git remote -v`

**Case A — `origin` points to `qwibitai/nanoclaw` (user cloned directly):**

The user cloned instead of forking. AskUserQuestion: "You cloned NanoClaw directly. We recommend forking so you can push your customizations. Would you like to set up a fork?"
- Fork now (recommended) — walk them through it
- Continue without fork — they'll only have local changes

If fork: instruct the user to fork `qwibitai/nanoclaw` on GitHub (they need to do this in their browser), then ask them for their GitHub username. Run:
```bash
git remote rename origin upstream
git remote add origin https://github.com/<their-username>/nanoclaw.git
git push --force origin main
```
Verify with `git remote -v`.

If continue without fork: add upstream so they can still pull updates:
```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

**Case B — `origin` points to user's fork, no `upstream` remote:**

Add upstream:
```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

**Case C — both `origin` (user's fork) and `upstream` (qwibitai) exist:**

Already configured. Continue.

**Verify:** `git remote -v` should show `origin` → user's repo, `upstream` → `qwibitai/nanoclaw.git`.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  - macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
  - Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm
  - After installing Node, re-run `bash setup.sh`
- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules`, re-run `bash setup.sh`. If native module build fails, install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry.
- If NATIVE_OK=false → better-sqlite3 failed to load. Install build tools and re-run.
- Record PLATFORM and IS_WSL for later steps.

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_AUTH=true → WhatsApp is already configured, note for step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record APPLE_CONTAINER and DOCKER values for step 3

### OpenClaw Migration Detection

Check for an existing OpenClaw installation:

```bash
ls -d ~/.openclaw 2>/dev/null || ls -d ~/.clawdbot 2>/dev/null
```

If a directory is found, AskUserQuestion:

1. **Migrate now** — "Import identity, credentials, and settings from OpenClaw before continuing setup."
2. **Fresh start** — "Skip migration and set up NanoClaw from scratch."
3. **Migrate later** — "Continue setup now, run `/migrate-from-openclaw` anytime later."

If "Migrate now": invoke `/migrate-from-openclaw`, then return here and continue at step 2a (Timezone).

## 2a. Timezone

Run `npx tsx setup/index.ts --step timezone` and parse the status block.

- If NEEDS_USER_INPUT=true → The system timezone could not be autodetected (e.g. POSIX-style TZ like `IST-2`). AskUserQuestion: "What is your timezone?" with common options (America/New_York, Europe/London, Asia/Jerusalem, Asia/Tokyo) and an "Other" escape. Then re-run: `npx tsx setup/index.ts --step timezone -- --tz <their-answer>`.
- If STATUS=success → Timezone is configured. Note RESOLVED_TZ for reference.

## 3. Container Runtime

### 3a. Choose runtime

Check the preflight results for `APPLE_CONTAINER` and `DOCKER`, and the PLATFORM from step 1.

- PLATFORM=linux → Docker (only option)
- PLATFORM=macos + APPLE_CONTAINER=installed → AskUserQuestion with two options:
  1. **Docker (recommended)** — description: "Cross-platform, better credential management, well-tested."
  2. **Apple Container (experimental)** — description: "Native macOS runtime. Requires advanced setup."
  If Apple Container, run `/convert-to-apple-container` now, then skip to 3c.
- PLATFORM=macos + APPLE_CONTAINER=not_found → Docker

### 3a-docker. Install Docker

- DOCKER=running → continue to 4b
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

**If the chosen runtime is Docker**, no conversion is needed. Continue to 3c.

### 3c. Build and test

Run `npx tsx setup/index.ts --step container -- --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue (stale layers): `docker builder prune -f` (Docker) or `container builder stop && container builder rm && container builder start` (Apple Container). Retry.
- Dockerfile syntax or missing files: diagnose from the log and fix, then retry.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Credential System

### 4-pre. Choose AI backend

AskUserQuestion: Which AI backend do you want to use?

1. **Claude (Anthropic)** — description: "Uses Anthropic's Claude models via the Claude Agent SDK. Requires a Claude subscription or Anthropic API key."
2. **GitHub Copilot** — description: "Uses GitHub Copilot models (GPT-4.1, etc.) via the Copilot SDK. Requires a GitHub Copilot subscription."

Set `NANOCLAW_SDK` in `.env`:
- Claude: `NANOCLAW_SDK=claude` (or omit — it's the default)
- Copilot: `NANOCLAW_SDK=copilot`

For Copilot, also ask which model:
```bash
grep -q 'COPILOT_MODEL' .env 2>/dev/null || echo 'COPILOT_MODEL=gpt-4.1' >> .env
```

**If Claude:** continue to 4a.
**If Copilot:** skip to 4c.

### 4a. Claude + Docker → OneCLI

Install OneCLI and its CLI tool:

```bash
curl -fsSL onecli.sh/install | sh
curl -fsSL onecli.sh/cli/install | sh
```

Verify both installed: `onecli version`. If the command is not found, the CLI was likely installed to `~/.local/bin/`. Add it to PATH for the current session and persist it:

```bash
export PATH="$HOME/.local/bin:$PATH"
# Persist for future sessions (append to shell profile if not already present)
grep -q '.local/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
grep -q '.local/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Then re-verify with `onecli version`.

Point the CLI at the local OneCLI instance, the ONECLI_URL was output from the install script above:
```bash
onecli config set api-host ${ONECLI_URL}
```

Ensure `.env` has the OneCLI URL (create the file if it doesn't exist):
```bash
grep -q 'ONECLI_URL' .env 2>/dev/null || echo 'ONECLI_URL=${ONECLI_URL}' >> .env
```

Check if a secret already exists:
```bash
onecli secrets list
```

If an Anthropic secret is listed, confirm with user: keep or reconfigure? If keeping, skip to step 5.

AskUserQuestion: Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

1. **Claude subscription (Pro/Max)** — description: "Uses your existing Claude Pro or Max subscription. You'll run `claude setup-token` in another terminal to get your token."
2. **Anthropic API key** — description: "Pay-per-use API key from console.anthropic.com."

#### Subscription path

Tell the user:

> Run `claude setup-token` in another terminal. It will output a token — copy it but don't paste it here.

Then stop and wait for the user to confirm they have the token. Do NOT proceed until they respond.

Once they confirm, they register it with OneCLI. AskUserQuestion with two options:

1. **Dashboard** — description: "Best if you have a browser on this machine. Open ${ONECLI_URL} and add the secret in the UI. Use type 'anthropic' and paste your token as the value."
2. **CLI** — description: "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_TOKEN --host-pattern api.anthropic.com`"

#### API key path

Tell the user to get an API key from https://console.anthropic.com/settings/keys if they don't have one.

Then AskUserQuestion with two options:

1. **Dashboard** — description: "Best if you have a browser on this machine. Open ${ONECLI_URL} and add the secret in the UI."
2. **CLI** — description: "Best for remote/headless servers. Run: `onecli secrets create --name Anthropic --type anthropic --value YOUR_KEY --host-pattern api.anthropic.com`"

#### After either path

Ask them to let you know when done.

**If the user's response happens to contain a token or key** (starts with `sk-ant-`): handle it gracefully — run the `onecli secrets create` command with that value on their behalf.

**After user confirms:** verify with `onecli secrets list` that an Anthropic secret exists. If not, ask again.

### 4c. GitHub Copilot → Copilot CLI auth

OneCLI is still needed (the container proxy infrastructure requires it), but no Anthropic secret is needed. Install OneCLI if not already installed (same commands as 4a), then configure:

```bash
grep -q 'ONECLI_URL' .env 2>/dev/null || echo 'ONECLI_URL=http://127.0.0.1:10254' >> .env
```

#### Copilot authentication

The Copilot SDK reads OAuth credentials from `~/.copilot/config.json`, which is mounted read-only into containers. The user must authenticate with the Copilot CLI.

Check if already authenticated:
```bash
test -f ~/.copilot/config.json && node -e "const c=JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.copilot/config.json','utf-8')); console.log(c.copilot_tokens ? 'AUTHENTICATED' : 'NOT_AUTHENTICATED')" 2>/dev/null || echo "NOT_AUTHENTICATED"
```

**If NOT_AUTHENTICATED:**

Tell the user:

> You need to authenticate with the Copilot CLI. On Linux, the token must be stored as a file (not just in the system keyring) so Docker containers can read it.

**Linux:**
```bash
DBUS_SESSION_BUS_ADDRESS= copilot login
```
The `DBUS_SESSION_BUS_ADDRESS=` prefix disables the system keyring so the token is saved to `~/.copilot/config.json` as a plain text file.

**macOS:**
```bash
copilot login
```
macOS Keychain is not accessible from Docker containers, so also use the env var trick:
```bash
DBUS_SESSION_BUS_ADDRESS= copilot login
```

Wait for the user to confirm they've completed the login.

**After login:** verify:
```bash
node -e "const c=JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.copilot/config.json','utf-8')); console.log(c.copilot_tokens ? 'OK' : 'MISSING')"
```

If `MISSING`, ask the user to re-run `copilot login` with the `DBUS_SESSION_BUS_ADDRESS=` prefix.

### 4b. Apple Container → Native Credential Proxy

Apple Container is not compatible with OneCLI. The credential proxy code is already included in the apple-container branch — do NOT invoke `/use-native-credential-proxy` (it would conflict with already-applied code).

Instead, just configure the credentials in `.env`:

AskUserQuestion: Do you want to use your **Claude subscription** (Pro/Max) or an **Anthropic API key**?

1. **Claude subscription (Pro/Max)** — description: "Uses your existing Claude Pro or Max subscription. Run `claude setup-token` in another terminal to get your token."
2. **Anthropic API key** — description: "Pay-per-use API key from console.anthropic.com."

For subscription: tell the user to run `claude setup-token` in another terminal. Stop and wait for the user to confirm they have completed this step successfully before proceeding.

Once confirmed, add the token to `.env`:
```bash
echo 'CLAUDE_CODE_OAUTH_TOKEN=<their-token>' >> .env
```

For API key: add to `.env`:
```bash
echo 'ANTHROPIC_API_KEY=<their-key>' >> .env
```

Verify the proxy starts: `npm run dev` should show "Credential proxy listening" in the logs.

## 5. Set Up Channels

AskUserQuestion (multiSelect): Which messaging channels do you want to enable?
- WhatsApp (authenticates via QR code or pairing code)
- Telegram (authenticates via bot token from @BotFather)
- Slack (authenticates via Slack app with Socket Mode)
- Discord (authenticates via Discord bot token)

**Delegate to each selected channel's own skill.** Each channel skill handles its own code installation, authentication, registration, and JID resolution. This avoids duplicating channel-specific logic and ensures JIDs are always correct.

For each selected channel, invoke its skill:

- **WhatsApp:** Invoke `/add-whatsapp`
- **Telegram:** Invoke `/add-telegram`
- **Slack:** Invoke `/add-slack`
- **Discord:** Invoke `/add-discord`

Each skill will:
1. Install the channel code (via `git merge` of the skill branch)
2. Collect credentials/tokens and write to `.env`
3. Authenticate (WhatsApp QR/pairing, or verify token-based connection)
4. Register the chat with the correct JID format
5. Build and verify

**After all channel skills complete**, install dependencies and rebuild — channel merges may introduce new packages:

```bash
npm install && npm run build
```

If the build fails, read the error output and fix it (usually a missing dependency). Then continue to step 6.

## 6. Mount Allowlist

AskUserQuestion: Agent access to external directories?

**No:** `npx tsx setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

## 7. Start Service

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

## 8. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux) or `bash start-nanoclaw.sh` (WSL nohup)
- SERVICE=not_found → re-run step 7
- CREDENTIALS=missing → re-run step 4 (Docker: check `onecli secrets list`; Apple Container: check `.env` for credentials)
- CHANNEL_AUTH shows `not_found` for any channel → re-invoke that channel's skill (e.g. `/add-telegram`)
- REGISTERED_GROUPS=0 → re-invoke the channel skills from step 5
- MOUNT_ALLOWLIST=missing → `npx tsx setup/index.ts --step mounts -- --empty`

Tell user to test: send a message in their registered chat. Show: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 7), credential system not running (Docker: check `curl ${ONECLI_URL}/api/health`; Apple Container: check `.env` credentials), missing channel credentials (re-invoke channel skill).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure the container runtime is running — `open -a Docker` (macOS Docker), `container system start` (Apple Container), or `sudo systemctl start docker` (Linux). Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Check trigger pattern. Main channel doesn't need prefix. Check DB: `npx tsx setup/index.ts --step verify`. Check `logs/nanoclaw.log`.

**Channel not connecting:** Verify the channel's credentials are set in `.env`. Channels auto-enable when their credentials are present. For WhatsApp: check `store/auth/creds.json` exists. For token-based channels: check token values in `.env`. Restart the service after any `.env` change.

**Unload service:** macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` | Linux: `systemctl --user stop nanoclaw`


## 9. Diagnostics

1. Use the Read tool to read `.claude/skills/setup/diagnostics.md`.
2. Follow every step in that file before completing setup.
