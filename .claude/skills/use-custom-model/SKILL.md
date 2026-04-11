---
name: use-custom-model
description: Configure NanoClaw to use a non-Anthropic LLM provider (e.g. Moonshot Kimi K2.5, Ollama, Together AI) via an Anthropic-compatible API endpoint. Guides through .env setup, OneCLI credential configuration, and verification.
---

# Use Custom Model

Configure NanoClaw agents to call a non-Anthropic LLM through any Anthropic-compatible API endpoint.

**Important:** NanoClaw runs on the Claude Agent SDK, which is optimised for Claude. Non-Anthropic providers must expose an Anthropic-compatible API (messages endpoint, SSE streaming, tool use). Kimi K2.5 via Moonshot AI is confirmed working. Others may work but are untested.

For full background on why the naive approaches fail, see [docs/kimi-k2-integration.md](../../../docs/kimi-k2-integration.md).

## Step 1 — Collect provider details

Ask the user for:
1. **API base URL** — the Anthropic-compatible endpoint (e.g. `https://api.moonshot.ai/anthropic`)
2. **API key** — their key for that provider
3. **Model name** — the model identifier (e.g. `kimi-k2.5`)
4. **Auth header format** — ask: "Does your provider's documentation show `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`?"
   - `ANTHROPIC_API_KEY` → sends `x-api-key: <value>` header (Anthropic default)
   - `ANTHROPIC_AUTH_TOKEN` → sends `Authorization: Bearer <value>` header (Moonshot, most others)
   - If unsure, default to `ANTHROPIC_AUTH_TOKEN`

## Step 2 — Update `.env`

Add or update these lines in `.env`. Use `ANTHROPIC_AUTH_TOKEN` unless the user confirmed `ANTHROPIC_API_KEY`:

```bash
ANTHROPIC_BASE_URL=<their-api-base-url>
ANTHROPIC_AUTH_TOKEN=<their-api-key>        # or ANTHROPIC_API_KEY if confirmed
ANTHROPIC_MODEL=<their-model-name>
```

Leave any existing `ANTHROPIC_API_KEY` commented out if switching away from Anthropic:

```bash
# ANTHROPIC_API_KEY=sk-ant-...   # disabled while using custom model
```

## Step 3 — Configure OneCLI

OneCLI intercepts all container HTTPS traffic. It must know about the provider's hostname to allow connections through.

Check existing secrets:
```bash
onecli secrets list
```

Remove any old Anthropic secret pointing to `api.anthropic.com` (it will conflict):
```bash
onecli secrets delete --id <old-secret-id>
```

Create a new secret for the custom provider:
```bash
onecli secrets create \
  --name "<ProviderName>" \
  --type anthropic \
  --value "<their-api-key>" \
  --host-pattern "<hostname-only, e.g. api.moonshot.ai>" \
  --path-pattern "/anthropic*"
```

> **Note:** `--host-pattern` takes a hostname only (no path, no protocol). Use `--path-pattern` for the path prefix.

## Step 4 — Rebuild and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# or: systemctl --user restart nanoclaw             # Linux
```

## Step 5 — Verify

### Confirm env vars reach the container

Send a test message to any registered group, then while the container is running:

```bash
docker ps | grep nanoclaw   # get container name
docker exec <container-name> env | grep ANTHROPIC
```

Expected:
```
ANTHROPIC_BASE_URL=https://your-provider.com/anthropic
ANTHROPIC_AUTH_TOKEN=your-key
ANTHROPIC_MODEL=your-model
```

### Confirm API calls go to the right host

```bash
docker logs onecli 2>&1 | grep -E "moonshot|anthropic|your-hostname" | tail -10
```

A successful call shows `status=200` on your provider's hostname:
```
MITM method=POST url=https://your-hostname:443/anthropic/v1/messages status=200
```

If you still see `status=401`, the auth header format is wrong — try switching between `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`.

## Reverting to Anthropic Claude

1. In `.env` — restore `ANTHROPIC_API_KEY`, remove or comment out `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`
2. In OneCLI — delete the custom provider secret, create a new one with `--host-pattern api.anthropic.com`
3. Rebuild and restart

## Troubleshooting

**`system/api_retry` in container logs, then failure:**
The API is reachable but rejecting auth. Switch between `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`.

**`status=401` in OneCLI logs:**
Wrong auth header. See above.

**No traffic to provider in OneCLI logs at all:**
`ANTHROPIC_BASE_URL` is not reaching the container. Confirm `npm run build` completed after editing `src/container-runner.ts`, and that the service was restarted.

**Provider responds but output is garbled:**
The provider may not fully support all Claude API features (tool use, streaming). Check provider documentation for known limitations.
