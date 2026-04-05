---
name: add-msteams
description: Add Microsoft Teams as a channel. Uses Bot Framework webhook — requires a bot registered in Teams Developer Portal. No Azure subscription needed.
---

# Add Microsoft Teams Channel

This skill adds Microsoft Teams support to NanoClaw, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/msteams.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

**Do they already have a Teams bot configured?** If yes, collect the Bot App ID and Client Secret now. If no, we'll create one in Phase 3.

## Phase 2: Apply Code Changes

### Ensure channel remote

```bash
git remote -v
```

If `msteams` is missing, add it:

```bash
git remote add msteams https://github.com/Aswinmcw/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch msteams skill/add-msteams
git merge msteams/skill/add-msteams || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/channels/msteams.ts` (TeamsChannel class with self-registration via `registerChannel`)
- `import './msteams.js'` appended to the channel barrel file `src/channels/index.ts`
- `botbuilder` npm dependency in `package.json`
- `TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`, `TEAMS_TENANT_ID`, `TEAMS_PORT` in `.env.example`

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Create a Teams Bot (if needed)

1. Go to [Teams Developer Portal](https://dev.teams.microsoft.com) → **Tools** → **Bot management**
2. Click **New bot** → give it a name
3. Click the bot → **Client secret** → **Add a client secret for your bot**
4. Copy the secret value immediately (shown only once)
5. Note the **Bot App ID** shown on the bot page

### Create a Teams App (if needed)

The bot must be wrapped in a Teams app to be installable:

1. Developer Portal → **Apps** → **New app**
2. Fill in basic info (name, description, version `1.0.0`)
3. **App features** → **Bot** → select your bot → enable scopes: **Personal**, **Team**, **Group chat**
4. **Publish** → **Publish to your org** (or Download app package to sideload)
5. In Teams → **Apps** → **Upload a custom app** → select the `.zip`

### Find your Tenant ID

The tenant ID is required for the bot to send replies. It's embedded in the first message your bot receives.

Start NanoClaw (after configuring credentials below), send a message to the bot in Teams, then check:

```bash
grep "TEAMS_TENANT" logs/nanoclaw.log
```

Or check the service URL logged at startup — it looks like `https://smba.trafficmanager.net/{region}/{tenantId}/`. The UUID in that URL is your tenant ID.

### Configure environment

Add to `.env`:

```bash
TEAMS_APP_ID=<your-bot-app-id>
TEAMS_APP_PASSWORD=<your-client-secret>
TEAMS_TENANT_ID=<your-m365-tenant-id>
TEAMS_PORT=3978
```

**Why `TEAMS_TENANT_ID`?** The Bot Framework defaults to the `botframework.com` OAuth tenant, but Teams bots registered through Developer Portal require a token issued for your specific M365 tenant. Without this, the bot receives messages but all replies fail with 401.

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Expose the webhook

Teams needs a public HTTPS URL to deliver messages. Options:

- **Cloudflare Tunnel**: `cloudflare tunnel --url http://localhost:3978`
- **ngrok**: `ngrok http 3978`
- Public server with a domain

Set the **Messaging endpoint** in Developer Portal → your app → Bot feature:

```
https://<your-public-url>/api/messages
```

### Build and restart

```bash
npm run build
systemctl --user restart nanoclaw  # Linux
```

Check that Teams is listening:

```bash
grep "teams" logs/nanoclaw.log
```

Expected: `[teams] Webhook listening on port 3978`

### Register the Teams chat as a group

Send a message to your bot in Teams. NanoClaw will receive it and log the conversation JID:

```bash
grep "teams:" logs/nanoclaw.log | head -5
```

Register it as a group — send this from your main NanoClaw channel (or use the setup skill).

## Troubleshooting

**Bot receives messages but never replies (401 in logs):**
The `TEAMS_TENANT_ID` is missing or wrong. Check the `serviceUrl` in the incoming activity — the UUID in the path is your tenant ID. Set it in `.env` and restart.

**"Webhook listening" but no messages arrive:**
- Verify the messaging endpoint in Developer Portal matches your tunnel URL exactly (must end with `/api/messages`)
- Test connectivity: `curl -X POST https://<your-url>/api/messages` — should return `400`, not `404` or timeout

**Bot not visible in Teams:**
Install the app first — Developer Portal → your app → Publish → Download app package, then upload in Teams → Apps → Upload a custom app.

**Linux / TrueNAS sysctl error (exit code 126):**
Docker 29+ sets `net.ipv4.ip_unprivileged_port_start` when `--user` is specified, which restricted kernels block. NanoClaw automatically uses `--network=host` on Linux to avoid this. No action needed.

**Messages not processed (trigger required):**
By default, group chats require the trigger word (e.g. `@Andy`). For 1:1 DMs, register the group with `requiresTrigger: false`.
