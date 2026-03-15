---
name: add-proton
description: "Add Proton suite integration to NanoClaw. Phase 1: Mail via Proton Bridge (IMAP/SMTP). Phases 2-3: Drive and Pass in follow-up PRs. Can be configured as a tool (agent reads/sends emails on demand) or as a full channel (incoming emails trigger agent runs)."
---

*Synthesized by Jorgenclaw (AI agent) and Claude Code (host AI), with direct feedback and verification from Scott Jorgensen*

# Add Proton Suite Integration

This skill adds Proton Mail support to NanoClaw via Proton Bridge. Your agent can read, search, and send emails through your Proton account — all encrypted end-to-end by Bridge.

> **Feeling stuck?** Don't be afraid to ask Claude directly where you are in the process and what to do next.

## What You're Setting Up

| Component | What it does |
|-----------|-------------|
| **Proton Bridge** | Proton's official app that decrypts your email locally and exposes standard IMAP/SMTP on localhost |
| **proton-mcp** (`tools/proton-mcp/`) | An MCP server that connects to Bridge and gives your agent email tools |
| **bridge.json** | A config file with your Bridge-generated IMAP/SMTP credentials (not your Proton password) |

### Why Proton Bridge?

ProtonMail uses a custom authentication protocol (SRP v4) that isn't available as a standard npm package. Instead of reverse-engineering their auth flow, we use **Proton Bridge** — Proton's official, supported way to connect email clients. Bridge handles all the authentication and encryption transparently, and exposes standard IMAP and SMTP interfaces on localhost.

### Suite Architecture

This skill is designed to grow:
- **Phase 1 (this PR):** Mail — read, search, send via Bridge
- **Phase 2 (follow-up):** Drive — file upload, download, share
- **Phase 3 (follow-up):** Pass — credential lookup

The directory structure is pre-scaffolded for all three phases.

## Phase 1: Pre-flight

### Check if already applied

Check if `tools/proton-mcp/index.js` exists. If it does, skip to Phase 3 (Setup). The code is already in place.

### Ask the user

Use `AskUserQuestion`:

AskUserQuestion: Should incoming emails be able to trigger the agent?

- **No (Recommended)** — Tool-only: the agent gets full Proton Mail tools (read, send, search) but won't monitor the inbox. Minimal changes.
- **Yes** — Channel mode: the agent polls the inbox and responds to incoming emails automatically. (Note: Channel mode is coming in a follow-up PR. For now, tool-only mode is available.)

## Phase 2: Apply Code Changes

### Add Proton MCP server files

Copy `tools/proton-mcp/` into the project root. This includes:
- `index.js` — MCP server with 5 mail tools
- `mail/imap-client.js` — IMAP read/search operations
- `mail/smtp-client.js` — SMTP send via nodemailer
- `drive/README.md` — Phase 2 stub
- `pass/README.md` — Phase 3 stub

### Install dependencies

```bash
cd tools/proton-mcp && npm install && cd ../..
```

### Mount Proton credentials in container

Apply the changes described in `modify/src/container-runner.ts.intent.md` to `src/container-runner.ts`: add a conditional read-write mount of `~/.proton-mcp` to `/home/node/.proton-mcp` in `buildVolumeMounts()` after the session mounts. Only mount if the directory exists.

### Add Proton MCP server to agent runner

Apply the changes described in `modify/container/agent-runner/src/index.ts.intent.md` to `container/agent-runner/src/index.ts`: add `proton` MCP server and `'mcp__proton__*'` to `allowedTools`.

### Validate

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Install Proton Bridge

1. Download from https://proton.me/mail/bridge
2. Install the package:
   - **Ubuntu/Pop!_OS:** `sudo dpkg -i protonmail-bridge*.deb`
   - **macOS:** Drag to Applications
3. Launch Bridge and sign in with your Proton account (one time, in the GUI)
4. In Bridge settings, verify IMAP and SMTP are enabled

### Get Bridge credentials

Bridge generates its own IMAP/SMTP password (different from your Proton account password):

1. In Bridge, click your account name
2. Look for "IMAP/SMTP" section
3. Note the **username** (your email) and the **Bridge password** (a generated string)
4. Note the ports — usually IMAP: `1143`, SMTP: `1025`

### Create config file

```bash
mkdir -p ~/.proton-mcp
```

Create `~/.proton-mcp/bridge.json`:
```json
{
  "imap_host": "127.0.0.1",
  "imap_port": 1143,
  "smtp_host": "127.0.0.1",
  "smtp_port": 1025,
  "username": "your-email@proton.me",
  "password": "<bridge-generated-password>"
}
```

### Set up Bridge as a service (Linux)

Create `~/.config/systemd/user/proton-bridge.service`:

```ini
[Unit]
Description=Proton Bridge
After=network.target

[Service]
ExecStart=/usr/bin/proton-bridge --noninteractive
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable proton-bridge
systemctl --user start proton-bridge
```

### Rebuild and restart NanoClaw

```bash
npm run build
./container/build.sh
systemctl --user restart nanoclaw   # Linux
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

### Check Bridge is running

```bash
nc -z 127.0.0.1 1143 && echo "IMAP reachable" || echo "Bridge not running"
```

### Test from chat

Send these messages to the agent:
1. "Check my email" — should use `mcp__proton__mail__get_unread`
2. "Send an email to test@example.com with subject 'Test' and body 'Hello'" — should use `mcp__proton__mail__send_message`

### Available tools

| Tool | What it does |
|------|-------------|
| `mcp__proton__mail__get_unread` | Get unread email count and subjects |
| `mcp__proton__mail__list_messages` | List recent emails with metadata |
| `mcp__proton__mail__get_message` | Read a full email by ID |
| `mcp__proton__mail__search_messages` | Search emails by keyword |
| `mcp__proton__mail__send_message` | Send an email |

## Phase 5: Troubleshooting

| Problem | What it means | What to do |
|---------|--------------|------------|
| "IMAP connection failed" | Bridge isn't running or wrong port | `systemctl --user start proton-bridge` and verify `nc -z 127.0.0.1 1143` |
| "Authentication failed" | Wrong credentials in bridge.json | Get fresh Bridge password from Bridge GUI settings |
| "Proton Bridge credentials not found" | Missing config file | Create `~/.proton-mcp/bridge.json` per setup instructions |
| "ETIMEDOUT" | Bridge is running but IMAP port is wrong | Check Bridge settings for actual port numbers |
| Send fails silently | SMTP port wrong | Verify SMTP port in Bridge (usually 1025) |

## Removal

1. Remove `tools/proton-mcp/`
2. Revert container-runner.ts changes (remove `~/.proton-mcp` mount)
3. Revert agent-runner index.ts changes (remove proton MCP server and `mcp__proton__*` from allowedTools)
4. Remove `~/.proton-mcp/` from host
5. Rebuild: `npm run build && ./container/build.sh`
6. Optionally stop Bridge: `systemctl --user stop proton-bridge && systemctl --user disable proton-bridge`
