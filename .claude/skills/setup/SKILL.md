---
name: setup
description: Run initial NanoClaw setup for Feishu. Use when user wants to install dependencies, configure Feishu, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup (Feishu)

Run setup steps automatically. Only pause when user action is required (Feishu app configuration, configuration choices). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

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

- If HAS_ENV=true → note existing .env file
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

## 4. Claude Authentication

If HAS_ENV=true from step 2, read `.env` and check for `ANTHROPIC_API_KEY`. If present, confirm with user: keep or reconfigure?

AskUserQuestion: Do you have an Anthropic API key?

**Yes:** Tell user to add these to `.env`:
```
ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_BASE_URL=https://api.anthropic.com  # or your proxy URL
MODEL=claude-sonnet-4-6
FALLBACK_MODEL=claude-opus-4-6
```

**No:** Direct user to https://console.anthropic.com/ to get an API key.

## 5. Feishu Configuration

### 5a. Create Feishu App

Guide user through Feishu app creation:

1. **Create app:**
   - Go to https://open.feishu.cn/app
   - Click "创建企业自建应用" (Create Enterprise App)
   - Fill in app name and description
   - Get App ID (cli_xxx) and App Secret

2. **Configure Event Subscription:**
   - In Developer Console (开发者后台)
   - Navigate to: Events and Callbacks (事件与回调)
   - Choose: "使用长连接接收事件/回调" (Receive events through persistent connection)
   - Subscribe to event: `im.message.receive_v1`

3. **Set Permissions:**
   - In app settings, enable these permissions:
     - 获取与发送单聊、群组消息 (Read and send messages)
     - 获取用户信息 (Get user information)  
     - 获取群组信息 (Get group information)

4. **Publish App:**
   - Click "创建版本" (Create Version)
   - Submit for approval or publish directly (depends on org settings)
   - Add the bot to a Feishu group

### 5b. Add to .env

Tell user to add these to `.env`:
```
FEISHU_APP_ID=cli_xxxxx
FEISHU_APP_SECRET=xxxxx
ASSISTANT_NAME=huan
```

The `ASSISTANT_NAME` is the trigger word (without @). Users will trigger with `@huan` in Feishu.

## 6. Mount Allowlist

AskUserQuestion: Should the agent have access to external directories?

**No (Recommended):** `npx tsx setup/index.ts --step mounts -- --empty`

**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...], "blockedPatterns":[], "nonMainReadOnly":true}'`

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

## 8. First Message & Registration

**Important:** Groups are automatically registered when they send a message with the trigger word.

**First Group (Main Group):**
1. Go to the Feishu group where you added the bot (can be private chat or group chat)
2. Send: `@huan 你好` (or whatever ASSISTANT_NAME you configured)
3. The system will automatically register this group as **Main Group**
4. Main Group has full admin privileges and doesn't require trigger word for subsequent messages

**Additional Groups:**
1. Add the bot to another Feishu group
2. In that group, send: `@huan 你好`
3. The system will automatically register this group
4. This group will require `@huan` trigger word for all messages

**Key Differences:**
- **Main Group** (first registered): No trigger required, full admin privileges
- **Regular Groups** (subsequently registered): Trigger required, limited privileges

No manual registration needed - just send a message with the trigger word!

Monitor logs: `tail -f logs/nanoclaw.log`

You should see:
- Feishu long connection established
- NanoClaw running with trigger
- Received Feishu message
- Auto-registering first group as Main Group
- Container starting and agent responding

## 9. Verify

Check service status:
- macOS: `launchctl list | grep nanoclaw`
- Linux: `systemctl --user status nanoclaw`

Check logs: `tail -20 logs/nanoclaw.log`

Expected output:
- Database initialized
- Feishu long connection established
- NanoClaw running with configured trigger

## Troubleshooting

**Service not starting:**
- Check `logs/nanoclaw.error.log`
- Common issues:
  - Wrong Node path (re-run step 7)
  - Missing `.env` (step 4)
  - Missing Feishu credentials (step 5)

**Container agent fails:**
- Ensure container runtime is running:
  - Docker: `docker info` should work
  - Apple Container: `container system start`
- Check container logs: `groups/main/logs/container-*.log`

**No response to messages:**
- Check trigger pattern in logs
- Verify Feishu app has correct permissions
- Check Feishu event subscription is using long connection mode
- Check logs: `tail -f logs/nanoclaw.log`

**Feishu connection issues:**
- Verify App ID and App Secret in `.env`
- Check app is published and added to group
- Restart service: `systemctl --user restart nanoclaw` (Linux) or `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS)

**Unload service:**
- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
- Linux: `systemctl --user stop nanoclaw`
