# add-acurast-staking

Adds an MCP skill that monitors Gary's Acurast ACU staking position via mainnet WSS RPC. Phase 1: read-only. Reports epoch, commitment state, accrued rewards, balances, delegations, and manager metric rewards. Raises health alerts on epoch lag or cooldown.

## Prerequisites

- `@polkadot/api` must be available. If not already in the agent image, add to `container/package.json` (see Install step 3).
- Env vars must be forwarded to the agent container (via `NANOCLAW_EXTRA_MOUNTS` or the `feat/mcp-env-forwarding` credential proxy).

## Required env vars

| Variable | Description |
|----------|-------------|
| `ACURAST_ADDR` | Gary's manager wallet SS58 address |
| `ACURAST_COMMITMENT_ID` | Commitment ID integer string (e.g. `"139"`) |
| `ACURAST_WSS_URL` | *(optional)* Override RPC endpoint (default: `wss://public-rpc.mainnet.acurast.com`) |
| `ACURAST_EPOCH_LAG_ALERT` | *(optional)* Epochs behind before health alert (default: `2`) |

## Install

### Step 1 — Copy skill file

Copy `acurast-staking.ts` into the target group's agent-runner-src skills directory:

```
/mnt/cache/appdata/nanoclaw/data/sessions/<GROUP_ID>/agent-runner-src/.claude/skills/add-acurast-staking/acurast-staking.ts
```

### Step 2 — Register in container.json

Add the MCP server entry to the group's `container.json` (at `/mnt/cache/appdata/nanoclaw/data/sessions/<GROUP_ID>/container.json`):

```json
{
  "mcpServers": {
    "acurast-staking": {
      "command": "npx",
      "args": ["ts-node", "--esm", ".claude/skills/add-acurast-staking/acurast-staking.ts"]
    }
  }
}
```

Or if using the compiled dist pattern:

```json
{
  "mcpServers": {
    "acurast-staking": {
      "command": "node",
      "args": ["--loader", "ts-node/esm", ".claude/skills/add-acurast-staking/acurast-staking.ts"]
    }
  }
}
```

> **Note:** Use whichever ts execution method matches your existing skills (check Vikunja skill entry as reference).

### Step 3 — Add @polkadot/api dependency

In `container/package.json`, add:

```json
"@polkadot/api": "^12.0.0"
```

Then rebuild the agent image on `unraid-syd`:

```bash
docker rmi nanoclaw-agent:latest
# Restart NanoClaw from Unraid UI — it auto-rebuilds the agent image
```

### Step 4 — Set env vars

Add to the NanoClaw Unraid template (Extra Parameters or template env fields):

```
ACURAST_ADDR=5F1e653pVJkb3kpeUXsRttHSdUxbnhuYAg2MAm6SKX29L2rK
ACURAST_COMMITMENT_ID=139
```

Verify they reach the agent container via `syncEnvFromProcess()` (already wired in `feat/sync-env-from-process`).

## Verify

See VERIFY.md.

## Remove

See REMOVE.md.
