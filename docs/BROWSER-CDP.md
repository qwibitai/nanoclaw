# Host Browser Integration

Container agents can use a Chrome instance running on the host machine for sites that need login sessions or captcha solving. The browser window is visible so you can interact with it.

## Quick Setup

Run the setup skill:

```
/add-host-browser
```

Or manually:

### 1. Install agent-browser

```bash
brew install agent-browser && agent-browser install
# OR
npm install -g agent-browser && agent-browser install
```

### 2. Start the host browser

```bash
./scripts/start-host-browser.sh
# Browser opens with a visible window — log into sites your agents need
```

The browser uses a dedicated profile at `~/.nanoclaw/host-browser-profile`, completely isolated from your personal Chrome.

### 3. Enable in NanoClaw

```bash
echo 'HOST_BROWSER_CDP_ENABLED=true' >> .env
```

### 4. Test

```bash
./scripts/test-host-browser.sh
```

## How It Works

```
Host: agent-browser --headed --profile ~/.nanoclaw/host-browser-profile
  │
  │  get cdp-url → ws://127.0.0.1:PORT/devtools/browser/UUID
  │  (written to ~/.nanoclaw/cdp-url)
  │
NanoClaw daemon (reads cdp-url, rewrites host → host.docker.internal)
  │
  │  passes HOST_BROWSER_CDP_URL env var to container
  │
Container wrapper (/usr/local/bin/agent-browser):
  agent-browser --cdp ws://host.docker.internal:PORT/... <command>
```

The `agent-browser` wrapper inside the container transparently routes all commands to the host Chrome when `HOST_BROWSER_CDP_URL` is set. Agents use `agent-browser` exactly the same way — no code changes needed.

When `HOST_BROWSER_CDP_ENABLED` is not set, the sandboxed Chromium inside the container is used as before.

## Running

Start the host browser in a terminal (or via launchd auto-start):

```bash
./scripts/start-host-browser.sh
```

Then start NanoClaw normally:

```bash
npm run dev
```

### Auto-start with launchd (macOS)

The setup skill installs `com.nanoclaw-chrome.plist` into `~/Library/LaunchAgents/` for auto-start on login.

```bash
# Manual management
launchctl load ~/Library/LaunchAgents/com.nanoclaw-chrome.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw-chrome.plist
```

## Security

- **Dedicated profile**: The browser uses its own profile at `~/.nanoclaw/host-browser-profile`, completely isolated from your personal Chrome. Your browsing history, passwords, and cookies are never exposed.
- **No network exposure**: The CDP port is only accessible on localhost. Docker Desktop routes `host.docker.internal` to the host's loopback interface.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `HOST_BROWSER_CDP_ENABLED` | (unset) | Set to `true` to enable host browser mode |
| `NANOCLAW_BROWSER_PROFILE` | `~/.nanoclaw/host-browser-profile` | Custom profile directory path |

## Troubleshooting

Run the connectivity test:

```bash
./scripts/test-host-browser.sh
```

If it fails:
1. Is the host browser running? `./scripts/start-host-browser.sh`
2. Is the CDP URL file present? `cat ~/.nanoclaw/cdp-url`
3. Is the container image built? `./container/build.sh`
4. Can the container reach the host? Check Docker Desktop is running
