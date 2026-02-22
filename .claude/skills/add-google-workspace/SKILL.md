---
name: add-google-workspace
description: Add Google Workspace access to NanoClaw via gog CLI (Gmail, Calendar, Drive, Contacts, Sheets, Docs)
---

# Add Google Workspace Integration

This skill enables NanoClaw agents to access Google Workspace services using the **gog** CLI.

With this, your agents can:
- **Gmail** - Search, read, send emails
- **Calendar** - List events, check availability
- **Drive** - Search files, manage documents
- **Contacts** - List and search contacts
- **Sheets** - Read, update, append rows
- **Docs** - Export and read documents

---

## Phase 1: Install gog

Install the gog CLI on your Mac:

```bash
brew install steipete/tap/gogcli
gog --version
```

Verify it works:

```bash
gog auth list
```

---

## Phase 2: Set up OAuth Credentials in NanoClaw

Credentials will be stored inside the NanoClaw project (not in your home directory).

### Step 1: Create Credentials Directory

```bash
mkdir -p data/gog
```

### Step 2: Download OAuth Credentials from GCP

Tell the user:

> I need you to set up Google OAuth credentials for gog:
>
> 1. Go to https://console.cloud.google.com
> 2. Create a new project (or use an existing one)
> 3. Go to **APIs & Services → OAuth consent screen**
> 4. Select "External" user type, fill in app name (e.g., "NanoClaw"), add your email
> 5. Go to **APIs & Services → Credentials**
> 6. Click **+ CREATE CREDENTIALS → OAuth client ID**
> 7. Choose **Desktop app** as application type
> 8. Click **DOWNLOAD JSON**
>
> What's your Google email address? And send me the JSON file content or paste it here.

Save the email:

```bash
echo "user@gmail.com" > data/gog/account.txt
```

If user provides a file path:

```bash
cp "/path/user/provided/client_secret.json" data/gog/client_secret.json
```

If user pastes JSON content:

```bash
cat > data/gog/client_secret.json << 'EOF'
{paste the JSON here}
EOF
```

Verify it's valid JSON:

```bash
cat data/gog/client_secret.json | jq . >/dev/null && echo "✓ JSON valid" || echo "✗ Invalid JSON"
```

### Step 3: Authorize gog with Your Google Account

Run the authorization:

```bash
GOOGLE_EMAIL=$(cat data/gog/account.txt)
gog auth credentials data/gog/client_secret.json
gog auth add "$GOOGLE_EMAIL" --services gmail,calendar,drive,contacts,sheets,docs
```

This opens a browser for you to authorize. After you click "Allow", gog stores the token locally.

Verify:

```bash
gog auth list
```

You should see your account listed.

---

## Phase 3: Mount Credentials in Container

Edit `src/container-runner.ts` and add this block after the `.claude` mount:

```typescript
// Google Workspace credentials (gog CLI)
const gogDir = path.join(projectRoot, 'data/gog');
if (fs.existsSync(gogDir)) {
  mounts.push({
    hostPath: gogDir,
    containerPath: '/workspace/gog',
    readonly: true,  // Read-only for security
  });
}

// Also mount gog's local auth cache (needed for token refresh)
const gogAuthDir = path.join(homeDir, '.config/gog');
if (fs.existsSync(gogAuthDir)) {
  mounts.push({
    hostPath: gogAuthDir,
    containerPath: '/home/node/.config/gog',
    readonly: false,  // Writable for token refresh
  });
}
```

---

## Phase 4: Update Container Dockerfile

Edit `container/Dockerfile` and add gog to the agent container:

```dockerfile
# Install gog CLI for Google Workspace
RUN brew install steipete/tap/gogcli
```

---

## Phase 5: Update Group Documentation

Append to `groups/global/CLAUDE.md`:

```markdown

## Google Workspace (gog)

You have access to Google Workspace services via the **gog** CLI. Use bash to run gog commands.

Set your account before each command:

```bash
GOOGLE_EMAIL=$(cat /workspace/gog/account.txt)
export GOG_ACCOUNT=$GOOGLE_EMAIL
```

Or add it inline to each command:

```bash
gog --account user@gmail.com <command>
```

### Gmail

```bash
# Search recent emails
gog gmail search 'newer_than:7d' --max 10 --json

# Search from specific sender
gog gmail search 'from:john@example.com' --max 5 --json

# Send email
gog gmail send --to recipient@example.com --subject "Subject" --body "Message"
```

### Calendar

```bash
# List upcoming events
gog calendar events primary --from 2026-02-22 --to 2026-03-22 --json

# List events for specific calendar
gog calendar events calendar-id --json
```

### Drive

```bash
# Search files
gog drive search 'name contains "Report"' --max 10 --json

# Search in folder
gog drive search 'parents contains "FOLDER_ID"' --json
```

### Contacts

```bash
# List contacts
gog contacts list --max 20 --json

# Search contacts
gog contacts search 'displayName:John' --json
```

### Sheets

```bash
# Read range
gog sheets get SHEET_ID "Sheet1!A1:D10" --json

# Update cells
gog sheets update SHEET_ID "Sheet1!A1:B2" --values-json '[["Name","Age"],["John","30"]]' --input USER_ENTERED

# Append rows
gog sheets append SHEET_ID "Sheet1!A:C" --values-json '[["x","y","z"]]' --insert INSERT_ROWS

# Get metadata
gog sheets metadata SHEET_ID --json
```

### Docs

```bash
# Export doc to text
gog docs export DOC_ID --format txt --out /tmp/doc.txt

# Read doc content
gog docs cat DOC_ID
```

### Tips

- Use `--json` flag for structured output (recommended for scripting)
- Use `--no-input` for non-interactive scripts
- Set `GOG_ACCOUNT=user@gmail.com` environment variable to avoid repeating `--account`
```

Also append the same section to `groups/main/CLAUDE.md`.

---

## Phase 6: Rebuild and Restart

Rebuild the container:

```bash
cd container && ./build.sh
cd ..
npm run build
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Wait for startup:

```bash
sleep 2 && launchctl list | grep nanoclaw
```

---

## Phase 7: Test

Send a message to your NanoClaw group:

> @Andy check my recent emails

Or:

> @Andy list my calendar events for this week

Or:

> @Andy search Drive for the latest report

Watch the logs:

```bash
tail -f logs/nanoclaw.log | grep -i gog
```

---

## Troubleshooting

### gog command not found in container

Ensure the Dockerfile has gog installed and rebuild:

```bash
cd container && ./build.sh
```

### OAuth token expired or invalid

Refresh the authorization:

```bash
GOOGLE_EMAIL=$(cat data/gog/account.txt)
gog auth remove "$GOOGLE_EMAIL"
gog auth add "$GOOGLE_EMAIL" --services gmail,calendar,drive,contacts,sheets,docs
```

### Credentials not mounted

Verify the mount exists:

```bash
ls -la data/gog/
docker exec -it <container-name> ls -la /workspace/gog/
```

Check logs for mount errors:

```bash
tail -50 groups/main/logs/container-*.log | grep -i gog
```

### Permission errors with Sheets/Docs

Make sure your Google account has access to those files. Test manually:

```bash
gog drive search 'name contains "test"' --json
gog sheets get SHEET_ID "Sheet1!A1:B1" --json
```

---

## File Structure

After setup, your NanoClaw directory contains:

```
data/gog/
├── account.txt           # Email address (used by agents)
└── client_secret.json    # OAuth credentials from GCP
```

Plus system auth (outside project, managed by gog):

```
~/.config/gog/
└── tokens/               # OAuth tokens (managed by gog)
```

---

## Removing Google Workspace Integration

To remove gog:

1. Remove gog from `container/Dockerfile`
2. Remove the `.config/gog` and `/workspace/gog` mounts from `src/container-runner.ts`
3. Remove Google Workspace sections from group CLAUDE.md files
4. Delete `data/gog/` directory (optional)
5. Rebuild:

```bash
cd container && ./build.sh
cd .. && npm run build
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```
