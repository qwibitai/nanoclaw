# Add Google Workspace Integration

Sets up Google accounts (Gmail, Calendar, Drive, Sheets, Docs) for NanoClaw agents.

## Architecture

- **Credentials**: stored in `~/.nanoclaw/data/accounts/accounts.json` on the host
- **Container access**: directory mounted read-only at `/workspace/accounts/` in all containers
- **API calls**: agents use `node /home/node/.claude/skills/google-workspace/google-workspace.js`
- **No email stored**: accounts identified by user-defined aliases (e.g. "workspace", "personal")
- **No Dockerfile changes**: the tool uses Node.js native `fetch` (already in Node 22)

`accounts.json` is the global account registry for NanoClaw. This skill only adds Google
accounts. Future skills will add other providers to the same file.

## Step 1: Ask which accounts to configure

Ask the user which Google accounts they want to add and what alias to use for each.
Default for this installation:
- `workspace` → Google Workspace account (Gmail + Calendar + Drive + Sheets + Docs)
- `personal` → Personal Gmail account (Gmail only)

Confirm aliases and services before proceeding.

## Step 2: Create Google Cloud Project

Guide the user:

1. Go to https://console.cloud.google.com
2. Create a new project named **NanoClaw**
3. Enable these APIs (APIs & Services → Enable APIs):
   - Gmail API
   - Google Calendar API
   - Google Drive API
   - Google Sheets API
   - Google Docs API
4. Go to **APIs & Services → OAuth consent screen**:
   - User type: **External**
   - App name: NanoClaw
   - Add scopes based on which services each account needs:
     - `https://www.googleapis.com/auth/gmail.modify`
     - `https://www.googleapis.com/auth/calendar`
     - `https://www.googleapis.com/auth/drive`
     - `https://www.googleapis.com/auth/spreadsheets`
     - `https://www.googleapis.com/auth/documents`
   - Add test users: add every Google account the user wants to authorize
5. Go to **Credentials → Create Credentials → OAuth 2.0 Client ID**:
   - Application type: **Desktop app**
   - Name: NanoClaw
   - Copy `client_id` and `client_secret` — same values for all Google accounts

One GCP project, one OAuth app, multiple accounts.

## Step 3: Run OAuth setup for each account

For each Google account, run:

```bash
node ~/.nanoclaw/.claude/skills/add-google-workspace/oauth-setup.js
```

The script will:
1. Ask for the alias (e.g. "workspace")
2. Ask for `client_id` and `client_secret`
3. Ask which services to enable
4. Open the browser for Google OAuth consent
5. Capture the auth code via localhost:3000
6. Exchange code for refresh token
7. Write the account entry to `~/.nanoclaw/data/accounts/accounts.json`

Run once per account. Re-running with the same alias overwrites that entry.

## Step 4: Verify the mount

`container-runner.ts` automatically mounts `~/.nanoclaw/data/accounts/` read-only
at `/workspace/accounts/` when the directory exists. No manual config needed.

Verify:
```bash
cat ~/.nanoclaw/data/accounts/accounts.json
```

## Step 5: Test

Restart NanoClaw:
```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

Send a test message to the main channel:
```
@Andy list my last 5 emails from my workspace account
@Andy what's on my calendar this week?
```

## accounts.json format (Google accounts)

```json
{
  "workspace": {
    "provider": "google",
    "services": ["gmail", "calendar", "drive", "sheets", "docs"],
    "client_id": "...",
    "client_secret": "...",
    "refresh_token": "..."
  },
  "personal": {
    "provider": "google",
    "services": ["gmail"],
    "client_id": "...",
    "client_secret": "...",
    "refresh_token": "..."
  }
}
```

## Security

- `accounts.json` is never written inside the container — mounted read-only
- No email addresses stored — only user-defined aliases
- Protect the file: `chmod 600 ~/.nanoclaw/data/accounts/accounts.json`
- `client_secret` and `refresh_token` are sensitive, treat like API keys
