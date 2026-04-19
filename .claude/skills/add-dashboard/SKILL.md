---
name: add-dashboard
description: Add web dashboard for monitoring NanoClaw — status, costs, messages, groups, tasks, and real-time logs.
---

# Add Dashboard

This skill adds a web dashboard to NanoClaw. Separate Express + React app on its own port — reads from the existing SQLite DB, no changes to core `src/` files.

## Phase 1: Pre-flight

### Check if already applied

Check if `dashboard/package.json` exists. If it does, skip to Phase 3 (Configure). The code is already in place.

## Phase 2: Apply Code Changes

### Ensure remote

```bash
git remote -v
```

Determine which remote points to `qwibitai/nanoclaw.git`. It's usually `origin` for fresh clones or `upstream` for forks. Use that remote name in the commands below (shown as `$REMOTE`).

If no remote points to `qwibitai/nanoclaw.git`, add one:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch $REMOTE skill/dashboard
git merge $REMOTE/skill/dashboard
```

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides. The `package-lock.json` conflict is common — resolve with:

```bash
git checkout --theirs package-lock.json
git add package-lock.json
git merge --continue
```

### Install and build

```bash
cd dashboard && npm install && npm run build
```

Verify the build succeeds (both `dist/` for frontend and `dist-api/` for API should be created).

## Phase 3: Configure

### Generate secret

Generate a random `DASHBOARD_SECRET` for authentication:

```bash
DASHBOARD_SECRET=$(openssl rand -hex 32)
```

### Update .env

Add to `.env` (if not already present):

```bash
DASHBOARD_SECRET=<generated-secret>
DASHBOARD_PORT=4000
```

Read back `DASHBOARD_PORT` from `.env` so the verify step uses the correct port.

Use `AskUserQuestion` to confirm the port (default 4000) in case they want a different one.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 4: Service Setup

### Detect platform

```bash
uname -s
```

### macOS (launchd)

The template is at `launchd/com.nanoclaw-dashboard.plist`. Replace placeholders and install:

```bash
NODE_PATH=$(which node)
PROJECT_ROOT=$(pwd)
HOME_DIR=$HOME

sed -e "s|{{NODE_PATH}}|$NODE_PATH|g" \
    -e "s|{{PROJECT_ROOT}}|$PROJECT_ROOT|g" \
    -e "s|{{HOME}}|$HOME_DIR|g" \
    launchd/com.nanoclaw-dashboard.plist > ~/Library/LaunchAgents/com.nanoclaw-dashboard.plist

mkdir -p logs
launchctl load ~/Library/LaunchAgents/com.nanoclaw-dashboard.plist
```

### Linux (systemd)

Create `~/.config/systemd/user/nanoclaw-dashboard.service`:

```ini
[Unit]
Description=NanoClaw Dashboard
After=nanoclaw.service

[Service]
Type=simple
WorkingDirectory=%h/<path-to-nanoclaw>
ExecStart=$(which node) dashboard/dist-api/server.js
Restart=on-failure
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

Then enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now nanoclaw-dashboard
```

## Phase 5: Verify

### Test the status endpoint

```bash
curl -s -H "Authorization: Bearer $DASHBOARD_SECRET" http://127.0.0.1:${DASHBOARD_PORT:-4000}/api/status
```

Should return JSON with `running`, `pid`, `uptime`, etc.

### Tell the user

> Dashboard is running at **http://127.0.0.1:4000**
>
> Open it in your browser and enter your `DASHBOARD_SECRET` to log in.
>
> Features: Status, Groups, Messages, Search, Costs, Tasks, Logs (real-time SSE stream).

## Troubleshooting

### Dashboard not starting

Check logs:
- macOS: `cat logs/dashboard.log logs/dashboard.error.log`
- Linux: `journalctl --user -u nanoclaw-dashboard -f`

Common issues:
1. `DASHBOARD_SECRET` not set in `.env` — the API will refuse all requests
2. Port conflict — change `DASHBOARD_PORT` in `.env`
3. Missing build — run `cd dashboard && npm run build`

### Service management

```bash
# macOS
launchctl unload ~/Library/LaunchAgents/com.nanoclaw-dashboard.plist  # stop
launchctl load ~/Library/LaunchAgents/com.nanoclaw-dashboard.plist    # start
launchctl kickstart -k gui/$(id -u)/com.nanoclaw-dashboard            # restart

# Linux
systemctl --user stop nanoclaw-dashboard
systemctl --user start nanoclaw-dashboard
systemctl --user restart nanoclaw-dashboard
```

## Removal

1. Stop the service (see above)
2. Remove the launchd/systemd unit
3. Delete `dashboard/` directory
4. Remove `DASHBOARD_SECRET` and `DASHBOARD_PORT` from `.env`
