# Add Composio

Gives the agent access to 100+ pre-built tool integrations via
[Composio](https://composio.io) — GitHub, Gmail, Slack, Notion, Linear,
Jira, HubSpot, and many more — all through a single MCP server.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `composio` is in `applied_skills`,
skip to Phase 3 (Configure). The code changes are already in place.

## Phase 2: Apply Code Changes

### Initialize skills system (if needed)

If `.nanoclaw/` does not exist:

```bash
npx tsx -e "import { initNanoclawDir } from './skills-engine/init.ts'; initNanoclawDir(); console.log('initialized');"
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-composio
```

This deterministically:
- Reads `~/.composio/api.key` in `buildContainerArgs()` and passes it as
  `COMPOSIO_API_KEY` Docker env var
- Adds `'mcp__composio__*'` to `allowedTools` in `container/agent-runner/src/index.ts`
- Registers the `composio` MCP server using `process.env.COMPOSIO_API_KEY`

If the apply reports merge conflicts, read the intent files:
- `modify/src/container-runner.ts.intent.md`
- `modify/container/agent-runner/src/index.ts.intent.md`

### Validate

```bash
npm run build
```

Build must be clean before proceeding.

## Phase 3: Configure

### Get your Composio API key

1. Go to https://app.composio.io and sign in (or create an account)
2. Navigate to **Settings** → **API Keys**
3. Copy your API key

### Store the API key

```bash
mkdir -p ~/.composio
echo "YOUR_API_KEY_HERE" > ~/.composio/api.key
chmod 600 ~/.composio/api.key
```

### Connect integrations

Use the Composio CLI or dashboard to connect the services you want:

```bash
# Install CLI (optional, for connecting integrations from terminal)
npm install -g composio-core

# Connect an integration (opens browser for OAuth)
composio add github
composio add gmail
composio add slack
# etc.
```

Or connect them via the Composio dashboard at https://app.composio.io/apps

### Restart NanoClaw

```bash
# Linux
systemctl --user restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

Tell the user:

> Ask the agent: "What Composio tools do you have available?"

The agent should list the tools from your connected integrations. If it
reports Composio tools are unavailable, check the troubleshooting section.

## Troubleshooting

### "Composio tools unavailable" or MCP server fails to start

1. Verify the API key file exists and is non-empty:
   ```bash
   cat ~/.composio/api.key
   ```
2. Verify the key is valid:
   ```bash
   COMPOSIO_API_KEY=$(cat ~/.composio/api.key) npx @composio/mcp@latest start
   ```
   If it starts without error, the key is valid. Press Ctrl+C.

3. Check NanoClaw logs for MCP startup errors:
   ```bash
   journalctl --user -u nanoclaw -n 50 | grep -i composio
   ```

### Agent has tools but can't authenticate to a service

The integration needs to be connected via Composio. Run:
```bash
composio add <service-name>
```
Or connect it via the Composio dashboard.

### Adding new integrations after initial setup

Simply connect them via Composio (CLI or dashboard) — no NanoClaw restart
needed. The MCP server picks up connected integrations dynamically from
your Composio account.
