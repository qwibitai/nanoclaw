---
name: icloud-tools
description: Use when a NanoClaw group needs access to iCloud Calendar, Contacts, Mail, or Notes. Gives agents CalDAV/CardDAV/IMAP/SMTP tools via an app-specific password. Works on any platform — no macOS required.
---

# iCloud Tools

Gives NanoClaw agents access to Apple's productivity apps via iCloud's standard protocols using an app-specific password. Works on any platform (no macOS requirement).

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `icloud-tools` is in `applied_skills`, skip to Phase 3 (Verify).

### Prepare app-specific password

Generate one at [appleid.apple.com](https://appleid.apple.com) → Sign-In & Security → App-Specific Passwords. The password is 16 characters in `xxxx-xxxx-xxxx-xxxx` format.

Add credentials to `.env`:
```
ICLOUD_EMAIL=user@icloud.com
ICLOUD_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
ICLOUD_SENDER_EMAIL=alias@icloud.com  # Optional: use iCloud alias as sender
```

No OS-specific dependencies — the MCP server runs inside the existing container.

## Phase 2: Apply

```bash
npx tsx scripts/apply-skill.ts .claude/skills/icloud-tools
```

This adds the icloud-tools MCP server to the container and wires up the credentials.

### Validate

```bash
npm test && npm run build
```

## Phase 3: Verify

### Choose modules

Available modules (set via `ICLOUD_MODULES` in `.mcp.json`):

| Module | Protocol | Tools | Description |
|--------|----------|-------|-------------|
| `calendar` | CalDAV | 6 | Calendars, events, upcoming, CRUD |
| `contacts` | CardDAV | 4 | Search, groups, create, update |
| `mail` | IMAP/SMTP | 12 | Folders, read, send, reply, forward, drafts, flag, move |
| `notes` | IMAP | 2 | List and read notes (read-only) |

Examples:
- Family group: `calendar,notes`
- Work group: `mail,contacts,calendar`
- All modules: `calendar,contacts,mail,notes`

### Configure per-group `.mcp.json`

Add to the target group's `.mcp.json` (merge with existing entries):

```json
{
  "mcpServers": {
    "icloud-tools": {
      "command": "node",
      "args": ["/opt/icloud-tools/dist/server.js"],
      "env": {
        "ICLOUD_EMAIL": "${ICLOUD_EMAIL}",
        "ICLOUD_APP_PASSWORD": "${ICLOUD_APP_PASSWORD}",
        "ICLOUD_SENDER_EMAIL": "${ICLOUD_SENDER_EMAIL}",
        "ICLOUD_MODULES": "calendar,contacts,mail,notes"
      }
    }
  }
}
```

Customize `ICLOUD_MODULES` per group as needed.

### Rebuild container

```bash
cd container && ./build.sh
```

### Restart service

**macOS (launchd):**
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**Linux (systemd):**
```bash
systemctl --user restart nanoclaw
```

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i -E "icloud|caldav|imap|smtp"
```

Look for:
- `icloud-tools server` started — MCP server loaded successfully
- Module registration messages — calendar/contacts/mail/notes registered
- Connection errors on first use — check credentials

### Send a test message

Ask the group: "What's on my calendar this week?" or "Send an email to..."

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `ICLOUD_EMAIL` | Yes | iCloud account email |
| `ICLOUD_APP_PASSWORD` | Yes | App-specific password (16-char, `xxxx-xxxx-xxxx-xxxx`) |
| `ICLOUD_SENDER_EMAIL` | No | SMTP sender alias (defaults to ICLOUD_EMAIL) |
| `ICLOUD_MODULES` | Yes (in `.mcp.json`) | Comma-separated modules: `calendar,contacts,mail,notes` |

## Troubleshooting

**"Connection refused" or auth error**: Check that `ICLOUD_EMAIL` and `ICLOUD_APP_PASSWORD` are set in `.env`. App-specific passwords expire if revoked — regenerate at appleid.apple.com.

**"Module not loading"**: `ICLOUD_MODULES` must be set in the group's `.mcp.json` env block — it is not read from `.env`. An empty or missing value means no tools are registered.

**"Auth failed" on IMAP/SMTP**: Verify the app-specific password is correct and hasn't been revoked. Regular iCloud passwords are not accepted — only app-specific passwords work.

**"Notes read-only"**: Expected. iCloud Notes access via IMAP is read-only. There are no write tools for notes — this is by design.

**Container not finding `/opt/icloud-tools`**: Rebuild the container after applying the skill: `cd container && ./build.sh`. The build step compiles the MCP server into `/opt/icloud-tools/dist/`.

**Tools not appearing in agent**: Confirm `mcp__icloud-tools__*` is in the `allowedTools` list in `container/agent-runner/src/index.ts` and that the container was rebuilt.
