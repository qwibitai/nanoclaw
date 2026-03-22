---
name: add-proton
description: "Add Proton suite integration to NanoClaw. 36 MCP tools across Mail (via Bridge), Pass (via pass-cli), Drive (via rclone), Calendar (via Radicale CalDAV), and VPN status. Full credential management with TOTP, encrypted backup, and calendar scheduling."
---

*Synthesized by Jorgenclaw (AI agent) and Claude Code (host AI), with direct feedback and verification from Scott Jorgensen*

# Add Proton Suite Integration

This skill adds the full Proton suite to NanoClaw — 36 MCP tools across five products. Your agent can read/send email, manage passwords with 2FA, back up files to encrypted cloud storage, schedule calendar events, and check VPN status.

> **Feeling stuck?** Don't be afraid to ask Claude directly where you are in the process and what to do next.

## What You're Setting Up

| Component | What it does |
|-----------|-------------|
| **Proton Bridge** | Proton's official app that decrypts email locally, exposes IMAP/SMTP on localhost |
| **pass-cli** | Proton's official CLI for Pass — credential vault, TOTP generation, password creation |
| **rclone** | Open-source tool with official Proton Drive backend — upload, download, sync files |
| **Radicale** | Lightweight CalDAV server — calendar events that sync to your phone |
| **proton-mcp** (`tools/proton-mcp/`) | MCP server that wraps all of the above into agent tools |

### Requirements

- **Paid Proton plan** (Mail Plus, Pass Plus, or Proton Unlimited) — required for Bridge and pass-cli
- **Docker** — agents run in containers
- **Node.js 18+**

## Pre-flight

### Check if already applied

Check if `tools/proton-mcp/index.js` exists. If it does, skip to Setup. The code is already in place.

### Ask the user

Use `AskUserQuestion`:

Which Proton products do you want to set up? (You can add more later)

- **Mail** — Read, send, search, forward, manage emails
- **Pass** — Credential vault with TOTP for autonomous 2FA
- **Drive** — Encrypted cloud backup for agent memory and files
- **Calendar** — Schedule events, reminders, follow-ups (syncs to phone)
- **VPN** — Check connection status
- **All of the above** (recommended)

## Apply Code Changes

### Add Proton MCP server files

Copy `tools/proton-mcp/` into the project root. This includes:
- `index.js` — MCP server with 36 tools
- `mail/imap-client.js` — IMAP operations (read, search, folders, attachments, star, delete, move)
- `mail/smtp-client.js` — SMTP operations (send, reply, reply-all, forward, HTML)
- `pass/pass-client.js` — Pass CLI wrapper (vault CRUD, TOTP, password generation)
- `drive/drive-client.js` — rclone wrapper (upload, download, list, delete)
- `calendar/calendar-client.js` — CalDAV client (create, list, update, delete events)
- `vpn/vpn-client.js` — VPN status via external IP lookup

### Install dependencies

```bash
cd tools/proton-mcp && npm install && cd ../..
```

### Mount credentials in container

Apply the changes described in `modify/src/container-runner.ts.intent.md` to `src/container-runner.ts`:
- Mount `~/.proton-mcp` (Bridge credentials) for all groups
- Mount `pass-cli` binary and `~/.local/share/proton-pass-cli/` session data — **main group only**
- Mount `rclone` binary and `~/.config/rclone/` config — **main group only**
- Set `PROTON_PASS_KEY_PROVIDER=fs` env var in containers

### Add Proton MCP server to agent runner

Apply the changes described in `modify/container/agent-runner/src/index.ts.intent.md` to `container/agent-runner/src/index.ts`: add `proton` MCP server and `'mcp__proton__*'` to `allowedTools`.

### Add config exports

Apply the changes described in `modify/src/config.ts.intent.md` to `src/config.ts`:
- `PROTON_PASS_BIN` — path to pass-cli binary
- `PROTON_PASS_VAULT` — default vault name (NanoClaw)

### Validate

```bash
npm run build
```

Build must be clean before proceeding.

## Setup: Mail (Proton Bridge)

### Install Proton Bridge

1. Download from https://proton.me/mail/bridge
2. Install: `sudo dpkg -i protonmail-bridge*.deb` (Ubuntu/Pop!_OS) or drag to Applications (macOS)
3. Launch Bridge and sign in with your Proton account
4. Verify IMAP and SMTP are enabled in Bridge settings

### Get Bridge credentials

1. In Bridge, click your account name
2. Note the **username** (your email) and the **Bridge password** (a generated string)
3. Note the ports — usually IMAP: `1143`, SMTP: `1025`

### Docker network relay (Linux only)

Proton Bridge only listens on localhost. Containers can't reach it directly. Set up a relay:

```bash
sudo apt install -y socat
```

Create `~/.config/systemd/user/proton-bridge-relay.service`:

```ini
[Unit]
Description=Relay Proton Bridge IMAP/SMTP to Docker network
After=proton-bridge.service

[Service]
Type=simple
ExecStart=/bin/bash -c '\
  socat TCP-LISTEN:1143,bind=172.17.0.1,fork,reuseaddr TCP:127.0.0.1:1143 & \
  socat TCP-LISTEN:1025,bind=172.17.0.1,fork,reuseaddr TCP:127.0.0.1:1025 & \
  wait'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now proton-bridge-relay
```

> **macOS:** Docker Desktop handles this automatically via `host.docker.internal`. Skip this step.

### Create config file

```bash
mkdir -p ~/.proton-mcp
cat > ~/.proton-mcp/bridge.json << 'EOF'
{
  "imap_host": "host.docker.internal",
  "imap_port": 1143,
  "smtp_host": "host.docker.internal",
  "smtp_port": 1025,
  "username": "your-email@proton.me",
  "password": "<bridge-generated-password>"
}
EOF
```

## Setup: Pass (pass-cli)

### Install pass-cli

```bash
curl -fsSL https://proton.me/download/pass-cli/install.sh | bash
```

### Login and configure

```bash
PROTON_PASS_KEY_PROVIDER=fs pass-cli login
pass-cli settings set default-vault --vault-name NanoClaw
```

Use the **filesystem key provider** (`fs`) so the session survives reboots and works inside Docker containers.

### Create a vault

```bash
PROTON_PASS_KEY_PROVIDER=fs pass-cli vault create --name NanoClaw
```

## Setup: Drive (rclone)

### Install rclone

```bash
curl -fsSL https://rclone.org/install.sh | sudo bash
```

The apt version is too old — use the install script to get rclone 1.62+ which includes the `protondrive` backend.

### Configure

```bash
rclone config
```

Create a new remote named `protondrive`, select the `protondrive` type, enter your Proton credentials.

### Test

```bash
rclone lsd protondrive:
```

## Setup: Calendar (Radicale)

### Install Radicale

```bash
sudo apt install -y radicale
```

### Configure

Create `~/.config/radicale/config`:

```ini
[server]
hosts = 127.0.0.1:5232

[auth]
type = htpasswd
htpasswd_filename = ~/.config/radicale/users
htpasswd_encryption = plain

[storage]
filesystem_folder = ~/.var/lib/radicale/collections

[rights]
type = from_file
file = ~/.config/radicale/rights
```

Create `~/.config/radicale/users`:
```
jorgenclaw:nanoclaw-cal
yourusername:your-cal-password
```

Create `~/.config/radicale/rights`:
```ini
[owner]
user = .+
collection = {user}/.*
permissions = RrWw

[user-reads-agent]
user = yourusername
collection = jorgenclaw/.*
permissions = RrWw

[agent-reads-user]
user = jorgenclaw
collection = yourusername/.*
permissions = Rr

[root-access]
user = .+
collection = {user}
permissions = RrWw
```

### Create systemd service

Create `~/.config/systemd/user/radicale.service`:

```ini
[Unit]
Description=Radicale CalDAV Server
After=network.target

[Service]
ExecStart=/usr/bin/radicale --config ~/.config/radicale/config
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now radicale
```

### Create calendars

```bash
curl -u jorgenclaw:nanoclaw-cal -X MKCALENDAR http://127.0.0.1:5232/jorgenclaw/calendar/
curl -u yourusername:your-cal-password -X MKCALENDAR http://127.0.0.1:5232/yourusername/calendar/
```

### Subscribe from phone (optional)

Expose Radicale via Tailscale, then:
- **iOS:** Settings > Calendar > Accounts > Add CalDAV Account
- **Android:** Install DAVx5, add CalDAV account
- Server: `http://<tailscale-ip>:5232`

## Rebuild and restart

```bash
npm run build
./container/build.sh
systemctl --user restart nanoclaw
```

## Verify

### Test from chat

| What to say | Expected tool |
|---|---|
| "Check my email" | `mail__get_unread` |
| "Send an email to test@example.com" | `mail__send_message` |
| "What's my GitHub password?" | `pass__get_item` |
| "Generate a TOTP code for GitHub" | `pass__get_totp` |
| "List my Drive files" | `drive__list` |
| "What's on my calendar this week?" | `calendar__list_events` |
| "Am I on VPN?" | `vpn__status` |

### All 36 tools

| Category | Tools |
|---|---|
| **Mail** (15) | get_unread, list_messages, get_message, search_messages, send_message, reply_message, forward_message, get_thread, mark_message, star_message, delete_message, move_message, list_folders, list_folder_messages, get_attachments |
| **Pass** (9) | list_vaults, list_items, search_items, get_item, create_item, update_item, trash_item, generate_password, get_totp |
| **Drive** (6) | list, upload, upload_folder, download, delete, mkdir |
| **Calendar** (5) | list_events, get_event, create_event, update_event, delete_event |
| **VPN** (1) | status |

## Troubleshooting

| Problem | What it means | What to do |
|---------|--------------|------------|
| "IMAP connection failed" | Bridge isn't running or wrong port | `systemctl --user start proton-bridge` and verify `nc -z 127.0.0.1 1143` |
| "Authentication failed" | Wrong credentials in bridge.json | Get fresh Bridge password from Bridge GUI settings |
| "Proton Bridge credentials not found" | Missing config file | Create `~/.proton-mcp/bridge.json` per setup instructions |
| "Connection refused" from container | Bridge only listens on localhost | Set up the socat relay service (Linux) or use `host.docker.internal` (macOS) |
| pass-cli "Passphrases file not found" | Key provider issue after reboot | Run `PROTON_PASS_KEY_PROVIDER=fs pass-cli login` |
| rclone "unusual activity" | Proton flagged the login | Wait 15-30 min, or contact https://proton.me/support/appeal-abuse |
| Calendar "400 Bad Request" | ICS formatting issue | Check Radicale logs: `journalctl --user -u radicale` |

## Security Notes

- **Pass and Drive tools are main-group only** — non-main groups cannot access credentials or cloud files (enforced by container mount isolation, not just policy)
- `pass-cli` uses the **filesystem key provider** — the encryption key is stored on disk, not in the kernel keyring. This is necessary for Docker container access and reboot survival
- `list_items` and `search_items` **never expose passwords** — only `get_item` returns credentials
- TOTP seeds are as sensitive as passwords — never logged in error messages

## Removal

1. Remove `tools/proton-mcp/`
2. Revert container-runner.ts changes (remove proton-mcp, pass-cli, rclone mounts)
3. Revert agent-runner index.ts changes (remove proton MCP server)
4. Remove config files: `~/.proton-mcp/`, `~/.config/radicale/`, `~/.config/rclone/`
5. Rebuild: `npm run build && ./container/build.sh`
6. Optionally stop services: `systemctl --user stop proton-bridge radicale`
