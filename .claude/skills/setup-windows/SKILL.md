---
name: setup-windows
description: Set up NanoClaw on Windows via WSL2 + Docker. Use when user is on Windows and wants to install NanoClaw. Checks WSL2, Docker Desktop, and guides through the complete setup process.
---

# NanoClaw Windows Setup (WSL2 + Docker)

This skill helps users set up NanoClaw on Windows using WSL2 and Docker Desktop. This is the officially supported way to run NanoClaw on Windows, providing true Linux container isolation.

**Pre-requisite Check:** First verify the user is on Windows. Run `uname -a` and check for "microsoft" or "WSL" in output. If not WSL2, guide them to install WSL2 first.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 0. Verify WSL2 Environment

Run `cat /proc/version` and check for "microsoft" in output.

- If not in WSL2: Guide user to install WSL2:
  ```bash
  # In Windows PowerShell (Administrator):
  wsl --install
  # Or update to WSL2:
  wsl --update
  ```
  Then have them open WSL2 (Ubuntu recommended) and re-run `/setup-windows`.

- If in WSL1: Guide user to upgrade:
  ```powershell
  # In Windows PowerShell (Administrator):
  wsl --set-default-version 2
  wsl --set-version Ubuntu 2
  ```

- If WSL2 confirmed: Continue to step 1.

## 1. Bootstrap (Node.js + Dependencies)

Run `bash setup.sh` and parse the status block.

- If NODE_OK=false → Node.js is missing or too old. Use `AskUserQuestion: Would you like me to install Node.js 22?` If confirmed:
  ```bash
  # Install Node.js 22 via NodeSource
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs

  # Or via nvm (alternative)
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
  source ~/.bashrc
  nvm install 22
  ```
  After installing, re-run `bash setup.sh`

- If DEPS_OK=false → Read `logs/setup.log`. Try: delete `node_modules` and `package-lock.json`, re-run `bash setup.sh`.
- If NATIVE_OK=false → better-sqlite3 failed to load. Install build tools:
  ```bash
  sudo apt-get update
  sudo apt-get install -y build-essential python3
  ```
  Then retry.

Record PLATFORM and IS_WSL for later steps (both should indicate WSL2).

## 2. Check Environment

Run `npx tsx setup/index.ts --step environment` and parse the status block.

- If HAS_AUTH=true → note that WhatsApp auth exists, offer to skip step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record DOCKER value for step 3

## 3. Docker Desktop Setup

### 3a. Check Docker Status

From environment check, if DOCKER=running → continue to 3c.

### 3b. Install/Start Docker Desktop

**Important:** On WSL2, Docker MUST be installed on Windows (Docker Desktop), not inside WSL2.

- If DOCKER=not_found → Use `AskUserQuestion: Docker Desktop is required. Would you like me to guide you through installation?` If confirmed:
  1. Download from https://docker.com/products/docker-desktop
  2. Install with WSL2 integration enabled (default in newer versions)
  3. Start Docker Desktop from Windows
  4. Wait for Docker to start, then verify: `docker info`

- If DOCKER=installed_not_running → Docker Desktop is installed but not running:
  ```bash
  # This command opens Docker Desktop from WSL2
  powershell.exe /c start docker-desktop
  ```
  Wait 15-30 seconds for Docker to start, then re-check with `docker info`.

### 3c. Build and Test

Run `npx tsx setup/index.ts --step container -- --runtime docker` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- Cache issue: `docker builder prune -f` and retry
- Other errors: diagnose from log and fix

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check if Docker is properly started.

## 4. Claude Authentication (No Script)

If HAS_ENV=true from step 2, read `.env` and check for `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. If present, confirm with user: keep or reconfigure?

AskUserQuestion: Claude subscription (Pro/Max) vs Anthropic API key?

**Subscription:** Tell user to run `claude setup-token` in another terminal, copy the token, add `CLAUDE_CODE_OAUTH_TOKEN=<token>` to `.env`. Do NOT collect the token in chat.

**API key:** Tell user to add `ANTHROPIC_API_KEY=<key>` to `.env`.

## 5. WhatsApp Authentication

If HAS_AUTH=true, confirm: keep or re-authenticate?

**Choose auth method based on environment (from step 2):**

WSL2 environment can open browser on Windows → AskUserQuestion: QR code in browser (recommended) vs pairing code vs QR code in terminal?

- **QR browser:** `npx tsx setup/index.ts --step whatsapp-auth -- --method qr-browser` (Bash timeout: 150000ms)
  - This will open the browser in Windows via `wslview` or `cmd.exe`

- **Pairing code:** Ask for phone number first. `npx tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone NUMBER` (Bash timeout: 150000ms). Display PAIRING_CODE.

- **QR terminal:** `npx tsx setup/index.ts --step whatsapp-auth -- --method qr-terminal`. Tell user to run `npm run auth` in another terminal.

**If failed:**
- qr_timeout → re-run
- logged_out → delete `store/auth/` and re-run
- 515 → re-run
- timeout → ask user, offer retry

## 6. Register Main Channel

Run `npx tsx setup/index.ts --step groups` and parse the status block.

- SYNC_OK=true + GROUPS_IN_DB > 0 → Groups found. Ask: "Found X groups. Continue with existing main channel?"
- First-time setup: The script will wait for user to message NanoClaw on WhatsApp (self-chat)

**Important:** On WSL2, the main channel is your WhatsApp self-chat. Send a message like "hello" to yourself on WhatsApp, and NanoClaw will detect it.

## 7. Start Services

Run `npx tsx setup/index.ts --step service` and parse the status block.

On WSL2, this will set up the service to run via:
- **systemd** (if available in WSL2): Creates a user-level systemd service
- **nohup fallback** (no systemd): Creates a background script with auto-restart

**If SERVICE_OK=true:**
- The service is now running in background
- Logs are in `logs/nanoclaw.log`
- To stop: `pkill -f "node.*dist/index.js"`
- To restart: re-run this step

**If SERVICE_OK=false:**
- Read `logs/setup.log` for errors
- Common issues:
  - Port already in use
  - Docker not running
  - Missing authentication

## 8. Setup Complete!

Provide summary:

```bash
✅ NanoClaw is now running on your Windows machine via WSL2!

Your NanoClaw assistant is active on WhatsApp. Message yourself on WhatsApp
to interact with it.

Try: @Andy hello

Logs: logs/nanoclaw.log
Service: Running in background (via systemd or nohup)
```

**Important notes for Windows users:**
- Keep Docker Desktop running for NanoClaw to work
- If you restart WSL2, NanoClaw will auto-start (if systemd) or needs manual restart
- WSL2 paths like `/mnt/c/Users/...` can be mounted for file access

## Troubleshooting

### Docker issues
```bash
# Check Docker status
docker info

# Restart Docker from WSL2
powershell.exe /c "Restart-Service docker"
```

### Service not starting
```bash
# Check logs
tail -f logs/nanoclaw.log

# Manual restart
pkill -f "node.*dist/index.js"
npm run dev
```

### WhatsApp auth issues
```bash
# Clear and re-authenticate
rm -rf store/auth/
npm run auth
```

### Browser won't open (QR code)
```bash
# Manually open QR HTML
# WSL2 will generate: file:///mnt/c/.../store/qr-auth.html
# Copy this path and open in Windows browser
```

## WSL2-Specific Tips

1. **File Access**: Use Windows paths via `/mnt/c/Users/...`
2. **Performance**: Place project in WSL2 filesystem (`~/`) for better performance
3. **Docker Desktop**: Ensure WSL2 integration is enabled in Docker Desktop settings
4. **Memory**: WSL2 can use up to 50% of host memory; adjust if needed in Windows `.wslconfig`
