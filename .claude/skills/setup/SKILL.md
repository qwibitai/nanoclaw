---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate messaging channels, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run setup steps automatically. Only pause when user action is required (channel authentication, configuration choices). Setup uses `bash setup.sh` for bootstrap, then `npx tsx setup/index.ts --step <name>` for all other steps. Steps emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. authenticating a channel, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

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

- If HAS_AUTH=true → WhatsApp is already configured, note for step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure

## 3. Agent Backend

AskUserQuestion (singleSelect): Which agent backend would you like to use?
- **Claude** (default) — Uses Claude Agent SDK. Requires `ANTHROPIC_API_KEY` or claude CLI login.
- **Cursor** — Uses Cursor CLI headless mode (`agent` command). Requires Cursor to be installed and logged in.

**If Claude selected:** continue to Step 4.

**If Cursor selected:**

1. Check if `agent` CLI is available: `which agent`
   - If missing: `AskUserQuestion: agent CLI not found. Install Cursor now via curl https://cursor.com/install -fsS | bash?`
     - If confirmed: run `curl https://cursor.com/install -fsS | bash`, then verify `which agent` succeeds
     - If declined: inform user to install manually from https://cursor.com, then halt
2. Check login status: `agent --version`
   - If not logged in: prompt user to run `agent login` in another terminal, then confirm when done
3. Write `AGENT_BACKEND=cursor` to `.env`
4. If `.env` already has `ANTHROPIC_API_KEY`, inform user it is not needed for Cursor mode but leave it in place
5. Skip Step 4 (Claude Authentication) — continue directly to Step 5

## 4. Claude Authentication (Optional)

Check if claude CLI is already logged in by running `claude auth status`. Parse the JSON output.

If `loggedIn: true` → Inform user they can skip API key configuration. NanoClaw will automatically use their claude CLI session.

If `loggedIn: false` or command fails → Offer two options:

AskUserQuestion: How would you like to authenticate?
1. **Use claude CLI** (recommended for personal use): Run `claude login` now
2. **Use API key** (recommended for production/team): Configure `ANTHROPIC_API_KEY` in `.env`

**Option 1 (claude CLI):**
- Tell user to run `claude login` in another terminal
- After login completes, verify with `claude auth status`
- No `.env` configuration needed

**Option 2 (API key):**
- Tell user to add `ANTHROPIC_API_KEY=<key>` to `.env`

**Note:** If `.env` already has `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`, confirm with user: keep or reconfigure?

## 5. Set Up Channels

AskUserQuestion (multiSelect): Which messaging channels do you want to enable?
- WhatsApp (authenticates via QR code or pairing code)
- Telegram (authenticates via bot token from @BotFather)
- Slack (authenticates via Slack app with Socket Mode)
- Discord (authenticates via Discord bot token)
- Feishu (authenticates via self-built app with App ID and App Secret)

**Delegate to each selected channel's own skill.** Each channel skill handles its own code installation, authentication, registration, and JID resolution. This avoids duplicating channel-specific logic and ensures JIDs are always correct.

For each selected channel, invoke its skill:

- **WhatsApp:** Invoke `/add-whatsapp`
- **Telegram:** Invoke `/add-telegram`
- **Slack:** Invoke `/add-slack`
- **Discord:** Invoke `/add-discord`
- **Feishu:** Invoke `/add-feishu`

Each skill will:
1. Install the channel code (via `apply-skill`)
2. Collect credentials/tokens and write to `.env`
3. Authenticate (WhatsApp QR/pairing, or verify token-based connection)
4. Register the chat with the correct JID format
5. Build and verify

**After all channel skills complete**, continue to step 6.

## 6. Identity Setup

Check if `groups/main/IDENTITY.md` exists and has a non-empty, non-placeholder `Name` field. If it already has a name, skip this step.

Otherwise, open with:

> "Hey. I just came online. Who am I? Who are you?"

Then guide through these four fields **one at a time**, offering suggestions if the user is stuck:

1. **Name** — What should they call you? (suggestions: "Nova", "Pip", "Orion", "Echo", "Sage")
2. **Creature** — What kind of entity are you? (suggestions: "AI familiar", "daemon", "oracle", "ghost in the machine")
3. **Vibe** — How do you come across? (suggestions: "sharp and warm", "calm and precise", "casual and a bit chaotic")
4. **Emoji** — Your signature. (offer a few based on their vibe if they're stuck)

After collecting answers, write `IDENTITY.md` to `groups/main/IDENTITY.md`. Skip any field the user doesn't answer — do not write placeholder text.

## 7. Mount Allowlist

AskUserQuestion: Agent access to external directories?

**No:** `npx tsx setup/index.ts --step mounts -- --empty`
**Yes:** Collect paths/permissions. `npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'`

## 8. Start Service

If service already running: unload first.
- macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`
- Linux: `systemctl --user stop nanoclaw` (or `systemctl stop nanoclaw` if root)

Run `npx tsx setup/index.ts --step service` and parse the status block.

**If FALLBACK=wsl_no_systemd:** WSL without systemd detected. Tell user they can either enable systemd in WSL (`echo -e "[boot]\nsystemd=true" | sudo tee /etc/wsl.conf` then restart WSL) or use the generated `start-nanoclaw.sh` wrapper.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- macOS: check `launchctl list | grep nanoclaw`. If PID=`-` and status non-zero, read `logs/nanoclaw.error.log`.
- Linux: check `systemctl --user status nanoclaw`.
- Re-run the service step after fixing.

## 9. Verify

Run `npx tsx setup/index.ts --step verify` and parse the status block.

**If STATUS=failed, fix each:**
- SERVICE=stopped → `npm run build`, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux) or `bash start-nanoclaw.sh` (WSL nohup)
- SERVICE=not_found → re-run step 8
- CREDENTIALS=missing → re-run step 4
- CHANNEL_AUTH shows `not_found` for any channel → re-invoke that channel's skill (e.g. `/add-telegram`)
- REGISTERED_GROUPS=0 → re-invoke the channel skills from step 5
- MOUNT_ALLOWLIST=missing → `npx tsx setup/index.ts --step mounts -- --empty`

Tell user to test: send a message in their registered chat. Show: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common: wrong Node path (re-run step 7), missing `.env` (step 4), missing channel credentials (re-invoke channel skill).

**No response to messages:** Check trigger pattern. Main channel doesn't need prefix. Check DB: `npx tsx setup/index.ts --step verify`. Check `logs/nanoclaw.log`.

**Channel not connecting:** Verify the channel's credentials are set in `.env`. Channels auto-enable when their credentials are present. For WhatsApp: check `store/auth/creds.json` exists. For token-based channels: check token values in `.env`. Restart the service after any `.env` change.

**Wrong agent backend:** Check `AGENT_BACKEND` in `.env`. Valid values: `claude` (default) or `cursor`. Restart the service after changing.

**Unload service:** macOS: `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` | Linux: `systemctl --user stop nanoclaw`
