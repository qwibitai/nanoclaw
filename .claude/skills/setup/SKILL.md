---
name: setup
description: Run initial SolClaw setup. Use when user wants to install dependencies, authenticate Telegram/WhatsApp, configure Solana wallet (mandatory), register their main channel, or start the background services. Triggers on "setup", "install", "configure solclaw", or first-time setup requests.
---

# SolClaw Setup

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
- If HAS_SOLANA_CONFIG=true → note existing Solana wallet (SOLANA_PUBLIC_KEY, SOLANA_NETWORK, SOLANA_SIGNING_METHOD), offer to skip step 10
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

## 4. Claude Authentication (No Script)

If HAS_ENV=true from step 2, read `.env` and check for `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. If present, confirm with user: keep or reconfigure?

AskUserQuestion: Claude subscription (Pro/Max) vs Anthropic API key?

**Subscription:** Tell user to run `claude setup-token` in another terminal, copy the token, add `CLAUDE_CODE_OAUTH_TOKEN=<token>` to `.env`. Do NOT collect the token in chat.

**API key:** Tell user to add `ANTHROPIC_API_KEY=<key>` to `.env`.

## 5. WhatsApp Authentication

If HAS_AUTH=true, confirm: keep or re-authenticate?

**Choose auth method based on environment (from step 2):**

If IS_HEADLESS=true AND IS_WSL=false → AskUserQuestion: Pairing code (recommended) vs QR code in terminal?
Otherwise (macOS, desktop Linux, or WSL) → AskUserQuestion: QR code in browser (recommended) vs pairing code vs QR code in terminal?

- **QR browser:** `npx tsx setup/index.ts --step whatsapp-auth -- --method qr-browser` (Bash timeout: 150000ms)
- **Pairing code:** Ask for phone number first. `npx tsx setup/index.ts --step whatsapp-auth -- --method pairing-code --phone NUMBER` (Bash timeout: 150000ms). Display PAIRING_CODE.
- **QR terminal:** `npx tsx setup/index.ts --step whatsapp-auth -- --method qr-terminal`. Tell user to run `npm run auth` in another terminal.

**If failed:** qr_timeout → re-run. logged_out → delete `store/auth/` and re-run. 515 → re-run. timeout → ask user, offer retry.

## 6. Configure Trigger and Channel Type

Get bot's WhatsApp number: `node -e "const c=require('./store/auth/creds.json');console.log(c.me.id.split(':')[0].split('@')[0])"`

AskUserQuestion: Shared number or dedicated? → AskUserQuestion: Trigger word? → AskUserQuestion: Main channel type?

**Shared number:** Self-chat (recommended) or Solo group
**Dedicated number:** DM with bot (recommended) or Solo group with bot

## 7. Sync and Select Group (If Group Channel)

**Personal chat:** JID = `NUMBER@s.whatsapp.net`
**DM with bot:** Ask for bot's number, JID = `NUMBER@s.whatsapp.net`

**Group:**
1. `npx tsx setup/index.ts --step groups` (Bash timeout: 60000ms)
2. BUILD=failed → fix TypeScript, re-run. GROUPS_IN_DB=0 → check logs.
3. `npx tsx setup/index.ts --step groups -- --list` for pipe-separated JID|name lines.
4. Present candidates as AskUserQuestion (names only, not JIDs).

## 8. Register Channel

Run `npx tsx setup/index.ts --step register -- --jid "JID" --name "main" --trigger "@TriggerWord" --folder "main"` plus `--no-trigger-required` if personal/DM/solo, `--assistant-name "Name"` if not Andy.

## 9. Mount Allowlist

AskUserQuestion: Agent access to external directories?

**No:** `npx tsx setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

## 10. Solana Wallet Configuration (MANDATORY for SolClaw)

**SolClaw requires Solana wallet configuration to start.** This step is mandatory.

**If HAS_SOLANA_CONFIG=true from step 2:** Solana is already configured. Show the user: public key (SOLANA_PUBLIC_KEY), network (SOLANA_NETWORK), signing method (SOLANA_SIGNING_METHOD). AskUserQuestion: Keep existing Solana config or reconfigure? If keeping, skip to step 11.

### 10a. Signing Method

AskUserQuestion: How should Solana transactions be signed?

- **Standard (local keypair)** — recommended. Private key stored locally, transactions signed on device.
- **Crossmint (custodial API)** — transactions signed via Crossmint API. Requires Crossmint API key.

### 10b. Standard Path (local keypair)

AskUserQuestion: How would you like to configure your wallet?

1. **Generate new wallet (Recommended for testing)** → Run: `npx tsx setup/index.ts --step solana -- --signing standard --key-source generate --network <NETWORK>`. IMPORTANT: The private key is displayed ONCE in the output - tell the user to save it.
2. **Use existing private key** → Collect the private key from the user. Run: `npx tsx setup/index.ts --step solana -- --signing standard --key-source base58 --private-key "<KEY>" --network <NETWORK>`. Do NOT log or display the private key in chat.
3. **Load from keypair file** → Ask for path (default: `~/.config/solana/id.json`). Run: `npx tsx setup/index.ts --step solana -- --signing standard --key-source file --key-path "<PATH>" --network <NETWORK>`.

### 10b-alt. Crossmint Path (custodial)

Collect from user: Crossmint API key, environment (production/staging), optionally wallet public key. Run:
`npx tsx setup/index.ts --step solana -- --signing crossmint --crossmint-key "<KEY>" --crossmint-env <ENV> --network <NETWORK>` (add `--public-key "<KEY>"` if provided)

### 10c. Network Selection

AskUserQuestion: Which Solana network?

- **mainnet** - Production network with real SOL (default)
- **devnet** - Testnet with free airdrops (recommended for testing). After setup, user can get free SOL: `solana airdrop 1 <PUBLIC_KEY> --url devnet`
- **testnet** - Alternative testnet
- **custom URL** - Custom RPC provider. Use `--network custom --rpc-url "<URL>"`

Pass the chosen network as the `--network` flag in the commands above (mainnet/devnet/testnet/custom).

### 10d. Optional Protocol API Keys

AskUserQuestion: Do you have API keys for any of these protocols? (each asked individually)
- DFlow (trading/order flow) — contact hello@dflow.net
- Jupiter (premium swap rates) — get key at portal.jup.ag
- Breeze (yield/lending) — create org and API key at portal.breeze.baby
- Helius (enhanced RPC/webhooks) — get key at helius.dev

For each confirmed, add the corresponding flag to the solana setup command: `--dflow-key "<KEY>"`, `--jupiter-key "<KEY>"`, `--breeze-key "<KEY>"`, `--helius-key "<KEY>"`. These are saved to `.env` and passed to the container automatically.

**All flags can be combined in a single command.** Example:
```
npx tsx setup/index.ts --step solana -- --signing standard --key-source generate --network mainnet --jupiter-key "xxx" --helius-key "yyy"
```

**After configuration:**
- Config is saved to `config/solana-config.json` and `.env.solana`
- Protocol API keys (if any) are saved to `.env`
- Verify config is valid: `node -e "const c=require('./config/solana-config.json'); console.log('Public Key:', c.wallet.publicKey, '| RPC:', c.preferences.rpcUrl, '| Setup:', c.setupComplete)"`
- Record the public key for the user

**If step fails:**
- Check that `@solana/web3.js` and `bs58` are installed: `npm list @solana/web3.js bs58`
- Re-run bootstrap if dependencies are missing: `bash setup.sh`
- Check `logs/setup.log` for detailed errors

**Important security notes:**
- `.env.solana` contains private key - never commit to git (already in `.gitignore`)
- `config/solana-config.json` also contains private key - never commit (already in `.gitignore`)
- For production: Use a dedicated wallet with minimal funds for testing first

## 11. Start Service

If service already running: unload first.
- macOS: `launchctl unload ~/Library/LaunchAgents/com.solclaw.plist` (or `com.nanoclaw.plist` if using original NanoClaw)
- Linux: `systemctl --user stop solclaw` (or `systemctl stop solclaw` if root)

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

## 12. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.solclaw` (macOS) or `systemctl --user restart solclaw` (Linux) or `bash start-solclaw.sh` (WSL nohup)
- SERVICE=not_found → re-run step 11
- CREDENTIALS=missing → re-run step 4
- WHATSAPP_AUTH=not_found → re-run step 5 (or skip if Telegram-only)
- REGISTERED_GROUPS=0 → re-run steps 7-8
- MOUNT_ALLOWLIST=missing → `npx tsx setup/index.ts --step mounts -- --empty`
- SOLANA_CONFIG=missing → re-run step 10 (Solana wallet configuration)
- SOLANA_CONFIG=configured → Solana wallet is set up correctly

**Additional Solana verification:**
- Check Solana config exists: `ls -la config/solana-config.json .env.solana`
- Verify config is valid: `node -e "const c=require('./config/solana-config.json'); console.log('Public Key:', c.wallet.publicKey, '| RPC:', c.preferences.rpcUrl, '| Setup:', c.setupComplete)"`
- If startup fails with "Solana not configured", ensure step 10 completed successfully

Tell user to test: send a message in their registered chat. Show: `tail -f logs/solclaw.log`

**For Solana testing:**
- Try: "What's my balance?"
- Try: "Price of SOL"
- Fund wallet if needed: Show public key from step 10, user can send SOL or use `solana airdrop 1 <PUBLIC_KEY>` on devnet

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 10), missing `.env` (step 4), missing auth (step 5).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure the container runtime is running — `open -a Docker` (macOS Docker), `container system start` (Apple Container), or `sudo systemctl start docker` (Linux). Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Check trigger pattern. Main channel doesn't need prefix. Check DB: `npx tsx setup/index.ts --step verify`. Check `logs/nanoclaw.log`.

**WhatsApp disconnected:** `npm run auth` then rebuild and restart: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux).

**Unload service:** macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` | Linux: `systemctl --user stop nanoclaw`
