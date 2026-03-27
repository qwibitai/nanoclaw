---
name: add-host-browser
description: Add host Chrome browser support via CDP for bot-detection bypass and persistent login sessions.
---

# Add Host Browser

Adds a real headed Chrome browser on the host that container agents can control via CDP using cdp-cli. Bypasses bot detection and maintains persistent login sessions.

## Prerequisites

- Google Chrome installed on the host
- Docker Desktop running

## Step 1: Merge the skill branch

```bash
git fetch upstream skill/host-browser
git merge upstream/skill/host-browser
```

Resolve any conflicts if prompted.

## Step 2: Rebuild

```bash
npm run build
./container/build.sh
```

## Step 3: Configure (optional)

Add to `.env` if you need a non-default CDP port:

```
HOST_BROWSER_PORT=9222
```

## Step 4: Verify

Restart NanoClaw and send a message to the main group. Chrome should launch when the container spawns and stop when it exits. Inside the container, `browser-cdp tabs` should return a page list.

## How it works

- Chrome starts when a main group container spawns, stops when it exits
- Disk profile at `data/browser-profile/` persists auth cookies across restarts
- Container socat bridges localhost to host.docker.internal for CDP
- `browser-cdp` wrapper auto-injects `--port` from `$HOST_BROWSER`
- `agent-browser` (headless) remains the default for simple browsing

## Uninstalling

```bash
git log --merges --oneline | grep host-browser
git revert -m 1 <merge-commit>
npm run build && ./container/build.sh
```
