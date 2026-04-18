---
name: add-agentcash
description: Add AgentCash so agents can make pay-per-call API requests via x402/SIWX micropayments (USDC). Provides search, discovery, and fetch tools for paid endpoints.
---

# Add AgentCash Integration

This skill adds AgentCash to NanoClaw agent containers. AgentCash gives agents pay-per-call access to premium APIs via x402 micropayments (USDC) and SIWX identity-gated endpoints.

Tools available to agents after installation:
- `fetch` — HTTP requests with automatic payment and auth handling
- `get_balance` — check USDC wallet balance
- `list_accounts` — per-network balances, addresses, deposit links
- `search` — find paid API services by natural language query
- `discover_api_endpoints` — discover endpoints from an origin's OpenAPI spec
- `check_endpoint_schema` — probe an endpoint for pricing and input schema
- `update_settings` / `get_settings` — configure spending limits
- `redeem_invite` — redeem an invite code for free credits
- `bridge` — bridge USDC between networks
- `report_error` — report MCP tool bugs

Pre-registered API origins:
- `stableenrich.dev` — people/org search, Google Maps, LinkedIn, web search
- `stablesocial.dev` — social media data (Twitter, Instagram, TikTok, YouTube)
- `stablestudio.dev` — image and video generation
- `stableupload.dev` — file uploads with permanent download URLs
- `stableemail.dev` — send emails
- `stablemerch.dev` — custom merchandise creation and shipping

## Phase 1: Pre-flight

### Check if already applied

Check if `agentcash` is registered in `container/agent-runner/src/index.ts`:

```bash
grep -q 'agentcash' container/agent-runner/src/index.ts
```

If it's already there, skip to Phase 3 (Configure).

### Check prerequisites

Verify Node.js >= 20 is available:

```bash
node --version
```

Verify the container runtime is available:

```bash
docker --version || container --version
```

## Phase 2: Apply Code Changes

### Ensure upstream remote

```bash
git remote -v
```

If `upstream` is missing, add it:

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

### Merge the skill branch

```bash
git fetch upstream skill/agentcash
git merge upstream/skill/agentcash
```

This merges in:
- `agentcash` global install in `container/Dockerfile`
- AgentCash MCP config in `container/agent-runner/src/index.ts` (allowedTools + mcpServers)
- Wallet mount in `src/container-runner.ts` (`data/agentcash/` -> `/home/node/.agentcash/`)

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Copy to per-group agent-runner

Existing groups have a cached copy of the agent-runner source. Copy the updated files:

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/index.ts "$dir/"
done
```

### Validate code changes

```bash
npm run build
./container/build.sh
```

Build must be clean before proceeding.

## Phase 3: Configure

### Set up the wallet

Ask the user:

> Do you have an AgentCash invite code for free credits? (optional)

Run the onboard command:

```bash
# With invite code:
npx agentcash@latest onboard <code>

# Without invite code:
npx agentcash@latest onboard
```

After onboarding, move the wallet into NanoClaw's data directory:

```bash
mkdir -p data/agentcash
cp -n ~/.agentcash/wallet.json data/agentcash/
cp -n ~/.agentcash/settings.json data/agentcash/ 2>/dev/null || true
```

The `-n` flag prevents overwriting an existing wallet.

### Check balance

```bash
npx agentcash@latest wallet info
```

If balance is 0 and the user wants to fund the wallet, show them the deposit links from the output, or direct them to `npx agentcash fund`.

### Spending limit

The default spending limit is **$5 per request**. Agents can adjust this at any time via chat:
- "set agentcash max spend to $10"
- "remove the agentcash spending limit"
- "what's my agentcash spending limit?"

These use the `update_settings` and `get_settings` MCP tools.

To set it manually now:

```bash
# In data/agentcash/settings.json
echo '{"maxAmount": 5}' > data/agentcash/settings.json
```

### Enable debug logging (optional)

For verbose AgentCash output in container logs, add to `.env`:

```bash
X402_DEBUG=true
```

### Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test balance check

Tell the user:

> Send a message like: "check my agentcash balance"
>
> The agent should use `get_balance` and report your USDC balance.

### Test API discovery

Tell the user:

> Send a message like: "search agentcash for social media APIs"
>
> The agent should use `search` to find relevant paid endpoints.

### Test a paid request (requires balance)

If the wallet has funds, tell the user:

> Send a message like: "use agentcash to look up information about anthropic.com"
>
> The agent should use `discover_api_endpoints` and `fetch` to make a paid API call.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i agentcash
```

## Future Enhancement

Per-group AgentCash gating (enabling/disabling AgentCash per group) is not yet supported. Currently all groups share the same wallet and have access to AgentCash tools. This requires a per-group feature flag system in NanoClaw core, tracked separately.

## Troubleshooting

### Agent says "agentcash not found"

1. The container wasn't rebuilt — run `./container/build.sh`
2. The per-group agent-runner source wasn't updated — re-copy files (see Phase 2)
3. Check that `agentcash` is in the Dockerfile: `grep agentcash container/Dockerfile`

### "Wallet not found" or balance errors

1. Check wallet exists: `ls data/agentcash/wallet.json`
2. Check the mount is in container-runner.ts: `grep agentcash src/container-runner.ts`
3. Re-run onboard if needed: `npx agentcash@latest onboard`
4. Copy wallet again: `cp ~/.agentcash/wallet.json data/agentcash/`

### Payment failures

1. Check balance: `npx agentcash@latest wallet info`
2. If zero, fund the wallet via deposit links or `npx agentcash fund`
3. Check if the endpoint price exceeds `maxAmount` — increase the limit via chat or settings.json

### Agent doesn't use AgentCash tools

The agent may not know about the tools. Try being explicit: "use the agentcash fetch tool to call https://stableenrich.dev/..."
