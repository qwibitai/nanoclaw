---
name: add-wallet
description: Add WAIaaS crypto wallet capabilities — self-hosted EVM + Solana wallet daemon with 59+ MCP tools, policy engine, and DeFi support. Private keys never enter the agent container.
---

# Add WAIaaS Wallet

This skill adds crypto wallet capabilities to your NanoClaw agent via WAIaaS, a self-hosted wallet daemon. Private keys stay in the daemon on the host — they never enter the agent container.

Supported: EVM (Ethereum, Base, Arbitrum, Polygon, Optimism) + Solana. 59+ tools including DeFi (swap, lend, stake, bridge, perp, prediction markets).

- Website: https://waiaas.ai
- GitHub: https://github.com/minhoyoo-iotrust/WAIaaS

## Phase 1: Pre-flight

### Check if already applied

Check if the `waiaas` MCP server is already configured in `container/agent-runner/src/index.ts`:

```bash
grep -r "waiaas" container/agent-runner/src/index.ts
```

If found, skip to Phase 4 (Environment Setup).

### Check prerequisites

The user must have WAIaaS daemon running on the host:

```bash
curl -s http://host.docker.internal:3100/v1/status 2>/dev/null || curl -s http://localhost:3100/v1/status 2>/dev/null
```

If the daemon is not running, instruct the user:

```
To set up WAIaaS:
  npm install -g @waiaas/cli
  waiaas init && waiaas start
  waiaas quickset --mode mainnet
Then configure spending policies at http://localhost:3100/admin
```

## Phase 2: Add MCP Server Configuration

Edit `container/agent-runner/src/index.ts`. Find the `mcpServers` object in the `query()` call and add the `waiaas` entry:

```typescript
waiaas: {
  command: 'npx',
  args: ['@waiaas/mcp'],
  env: {
    WAIAAS_SESSION_TOKEN: process.env.WAIAAS_SESSION_TOKEN || '',
    WAIAAS_BASE_URL: process.env.WAIAAS_BASE_URL || 'http://host.docker.internal:3100',
  },
},
```

Use `host.docker.internal` as the default base URL since the agent runs inside a container but the WAIaaS daemon runs on the host.

In the same file, find the `allowedTools` array and add:

```typescript
'mcp__waiaas__*',
```

## Phase 3: Container Setup

Edit `container/Dockerfile`. Add after existing npm installs:

```dockerfile
RUN npm install -g @waiaas/mcp
```

Edit `src/container-runner.ts` (or equivalent container spawning code) to forward the WAIaaS environment variables into the container. Find where environment variables are passed and add:

```typescript
WAIAAS_SESSION_TOKEN: process.env.WAIAAS_SESSION_TOKEN,
WAIAAS_BASE_URL: process.env.WAIAAS_BASE_URL,
```

## Phase 4: Environment Setup

Add to `.env` file (or instruct the user to set):

```bash
WAIAAS_SESSION_TOKEN=<session-token-from-quickset>
# Optional: override if daemon is on a different host
# WAIAAS_BASE_URL=http://host.docker.internal:3100
```

> **Security:** Session tokens are time-limited JWTs, revocable from Admin UI. Never hardcode in source files.

## Phase 5: Agent System Prompt

Add the following to the agent's system prompt or instructions:

```
## Crypto Wallet (WAIaaS)

You have access to a self-hosted crypto wallet via WAIaaS MCP tools.

**First step**: Call `connect_info` to discover your wallets, policies, and capabilities.

**Core tools**:
- `get_balance` / `get_assets` — Check balances
- `send_token` — Send crypto (to, amount, optionally token and network)
- `simulate_transaction` — Preview fees and policy before executing
- `sign_message` — Sign messages (personal_sign or EIP-712)

**DeFi** (action_* prefix): Swap (Jupiter/0x), Lending (Aave/Kamino), Staking (Lido/Jito), Bridge (LI.FI/Across), Perp (Drift/Hyperliquid), Prediction (Polymarket).

**Security**:
- You have a session token, not the master password. Never ask for the master password.
- If a transaction is BLOCKED by policy, explain the reason. Do not retry.
- Always simulate before large transactions.
```

## Phase 6: Verification

Build and test the container:

```bash
# Rebuild the container
./container/build.sh

# Start NanoClaw with the env var
WAIAAS_SESSION_TOKEN=<token> npm start
```

Send a message to the agent: "What wallets do you have access to?"

The agent should call `connect_info` and report wallet details. Then try: "What's my wallet balance?" — should call `get_balance`.
