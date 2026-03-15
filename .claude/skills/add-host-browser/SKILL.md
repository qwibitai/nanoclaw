---
name: add-host-browser
description: Set up a dedicated host Chrome browser with CDP for container agents. Use when the user wants agents to control a real Chrome browser for captcha solving or sites requiring login sessions.
---

# Add Host Browser (agent-browser CDP)

This skill sets up a headed Chrome instance on the host via `agent-browser` so container agents can:
- **Access logged-in sites** — the host browser keeps persistent login sessions
- **Solve captchas** — the browser window is visible for user interaction

**Principle:** Do the work — don't tell the user to run commands themselves. Only pause for actions that genuinely require their input.

## Phase 1: Pre-flight

### Check if already configured

```bash
test -f "$HOME/.nanoclaw/cdp-url" && echo "CDP_URL_EXISTS=true" || echo "CDP_URL_EXISTS=false"
test -d "$HOME/.nanoclaw/host-browser-profile" && echo "PROFILE_EXISTS=true" || echo "PROFILE_EXISTS=false"
grep -q 'HOST_BROWSER_CDP_ENABLED=true' .env 2>/dev/null && echo "ENV_CONFIGURED=true" || echo "ENV_CONFIGURED=false"
```

If all are true, skip to Phase 4 (Test).

### Check agent-browser is installed

```bash
command -v agent-browser && agent-browser --version || echo "NOT_INSTALLED"
```

If not installed, tell the user:
> `agent-browser` is required. Install with one of:
> ```
> brew install agent-browser && agent-browser install
> npm install -g agent-browser && agent-browser install
> ```
> Then re-run this setup.

Stop here if not installed.

## Phase 2: Start Host Browser

```bash
./scripts/start-host-browser.sh
```

This kills any existing agent-browser daemon, starts a fresh headed browser with a persistent profile at `~/.nanoclaw/host-browser-profile`, and writes the CDP URL to `~/.nanoclaw/cdp-url`.

## Phase 3: Configure .env

Add host browser setting to `.env` (if not already present):

```bash
grep -q 'HOST_BROWSER_CDP_ENABLED' .env 2>/dev/null || cat >> .env << 'EOF'

# Host browser for container agents (captcha solving, login sessions)
HOST_BROWSER_CDP_ENABLED=true
EOF
```

### Login Sessions

Use `AskUserQuestion`: Would you like to log into websites in the host browser now? (You can do this anytime by running `./scripts/start-host-browser.sh`)

If yes, tell the user:
> The host browser is open with a dedicated profile. Log into any sites your agents need (GitHub, etc.). When done, come back here and tell me.

Wait for confirmation.

## Phase 4: End-to-end Test

### Ensure container image is built

```bash
docker images nanoclaw-agent:latest --format '{{.Repository}}' | grep -q nanoclaw-agent || ./container/build.sh
```

### Run the connectivity test

```bash
./scripts/test-host-browser.sh
```

**If the test fails**, check:
1. Host browser is running: `cat ~/.nanoclaw/cdp-url`
2. Container image is rebuilt with the agent-browser wrapper: `./container/build.sh`
3. Docker Desktop is running

**Do not proceed if the test fails.** Debug the connectivity issue first.

## Phase 5: Launchd Auto-start & Done

### Install launchd plist (macOS only)

If on macOS, offer to install the launchd plist for auto-start:

```bash
if [[ "$OSTYPE" == darwin* ]]; then
  PROJECT_ROOT=$(pwd)
  HOME_DIR=$HOME

  sed -e "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" \
      -e "s|{{HOME}}|$HOME_DIR|g" \
      launchd/com.nanoclaw-chrome.plist > ~/Library/LaunchAgents/com.nanoclaw-chrome.plist

  launchctl load ~/Library/LaunchAgents/com.nanoclaw-chrome.plist
  echo "Host browser will now start automatically on login."
fi
```

### Summary

Tell the user:

> Host browser integration is ready!
>
> All container agents now route `agent-browser` commands through the host Chrome automatically.
> The browser window is visible — you can log into sites and solve captchas when needed.
>
> To use: just start NanoClaw normally (`npm run dev`). The host browser starts automatically.
>
> To restart the browser manually: `./scripts/start-host-browser.sh`
