# Using NanoClaw with Kimi K2.5 (Moonshot AI)

This document explains how to configure NanoClaw to use Moonshot AI's Kimi K2.5 model instead of Anthropic's Claude. It covers why the obvious approaches fail, the root cause, and the working solution.

---

## Background

NanoClaw uses the **Claude Agent SDK** (`@anthropic-ai/claude-code`) inside each container. The SDK supports a custom API endpoint via `ANTHROPIC_BASE_URL`, which Moonshot AI exposes as an Anthropic-compatible endpoint.

However, NanoClaw's credential system (OneCLI Agent Vault) adds complexity that makes the naive approach fail in non-obvious ways.

---

## Why the Obvious Approaches Don't Work

### Attempt 1: Set `ANTHROPIC_BASE_URL` in `.env`

```bash
ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic
ANTHROPIC_API_KEY=sk-your-moonshot-key
```

**Why it fails:** NanoClaw's `setup/index.ts` only extracts `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` from `.env` and writes them to `data/env/env`. `ANTHROPIC_BASE_URL` is deliberately excluded — it never reaches the container.

---

### Attempt 2: Configure OneCLI to proxy Moonshot

```bash
onecli secrets create --name Anthropic --type anthropic \
  --value "sk-your-moonshot-key" \
  --host-pattern "api.moonshot.ai" \
  --path-pattern "/anthropic*"
```

**Why it fails:** OneCLI's `anthropic` secret type injects the key as the `x-api-key` HTTP header (Anthropic's format). But Moonshot requires the key as `Authorization: Bearer <token>`, which is what the Anthropic SDK uses when `ANTHROPIC_AUTH_TOKEN` is set — not `ANTHROPIC_API_KEY`. The result is HTTP 401 on every request.

Evidence from OneCLI proxy logs:
```
MITM method=POST url=https://api.moonshot.ai:443/anthropic/v1/messages status=401 injections_applied=0
```

---

### Attempt 3: Hardcode env vars in `container-runner.ts`

```typescript
args.push('-e', 'ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic');
args.push('-e', 'ANTHROPIC_MODEL=kimi-k2.5');
```

**Why it partially works but auth still fails:** The env vars do reach the container (verified with `docker exec <container> env`). But the SDK still uses `ANTHROPIC_API_KEY` to set `x-api-key`, which Moonshot rejects. The `system/api_retry` messages in container logs indicate auth failures being retried.

---

## Root Cause

There are two distinct problems:

### Problem 1: `ANTHROPIC_BASE_URL` never reaches the container

NanoClaw's setup scripts and `data/env/env` mechanism only pass auth credentials to containers, not endpoint configuration. The container-runner must explicitly pass `ANTHROPIC_BASE_URL` as a `-e` flag.

### Problem 2: Wrong auth header format for Moonshot

The Anthropic SDK uses two different auth mechanisms:
- `ANTHROPIC_API_KEY` → sends `x-api-key: <value>` header
- `ANTHROPIC_AUTH_TOKEN` → sends `Authorization: Bearer <value>` header

Moonshot's Anthropic-compatible API requires `Authorization: Bearer`, meaning you must set `ANTHROPIC_AUTH_TOKEN`, not `ANTHROPIC_API_KEY`.

From Moonshot's official documentation:
```bash
export ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic
export ANTHROPIC_AUTH_TOKEN=${YOUR_MOONSHOT_API_KEY}
```

---

## The Working Solution

### Step 1: Update `src/container-runner.ts`

Import `readEnvFile` and dynamically read Anthropic-related env vars from `.env`, passing them directly to the container as `-e` flags. This bypasses the `data/env/env` mechanism entirely.

```typescript
// In imports:
import { readEnvFile } from './env.js';

// In buildContainerArgs(), after TZ is pushed:
const anthropicEnv = readEnvFile([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
]);
for (const [key, value] of Object.entries(anthropicEnv)) {
  args.push('-e', `${key}=${value}`);
}
```

This reads values fresh from `.env` on every container spawn — no rebuild required when you change credentials.

### Step 2: Set the correct variables in `.env`

```bash
ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic
ANTHROPIC_AUTH_TOKEN=sk-your-moonshot-key   # NOT ANTHROPIC_API_KEY
ANTHROPIC_MODEL=kimi-k2.5
```

**Critical:** Use `ANTHROPIC_AUTH_TOKEN`, not `ANTHROPIC_API_KEY`. This triggers Bearer token auth in the Anthropic SDK, which is what Moonshot expects.

### Step 3: Configure OneCLI to match the new host

OneCLI still intercepts HTTPS traffic via its proxy. Even though `ANTHROPIC_AUTH_TOKEN` is set directly, OneCLI must know about `api.moonshot.ai` to allow the connection through (or it blocks/misroutes it).

```bash
onecli secrets create \
  --name "Kimi" \
  --type anthropic \
  --value "sk-your-moonshot-key" \
  --host-pattern "api.moonshot.ai" \
  --path-pattern "/anthropic*"
```

Remove any old `api.anthropic.com` secret if you want to force all calls through Moonshot:

```bash
onecli secrets delete --id <old-anthropic-secret-id>
```

### Step 4: Rebuild and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# or: systemctl --user restart nanoclaw            # Linux
```

---

## Verification

### 1. Confirm env vars reach the container

```bash
docker ps | grep sales   # get container name
docker exec <container-name> env | grep ANTHROPIC
```

Expected output:
```
ANTHROPIC_API_KEY=placeholder        # set by OneCLI (harmless)
ANTHROPIC_AUTH_TOKEN=sk-your-key     # set by our fix ✓
ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic  ✓
ANTHROPIC_MODEL=kimi-k2.5            ✓
```

### 2. Confirm API calls go to Moonshot

```bash
docker logs onecli 2>&1 | grep "moonshot\|anthropic" | tail -10
```

A successful call looks like:
```
MITM method=POST url=https://api.moonshot.ai:443/anthropic/v1/messages?beta=true status=200
```

`status=200` on `api.moonshot.ai` confirms Kimi K2.5 is handling requests.

---

## How it Works End-to-End

```
.env (ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL)
  ↓
container-runner.ts reads via readEnvFile() on each container spawn
  ↓
Docker container receives -e ANTHROPIC_AUTH_TOKEN=sk-... -e ANTHROPIC_BASE_URL=...
  ↓
Claude Agent SDK inside container reads these env vars
  ↓
SDK sends POST to https://api.moonshot.ai/anthropic/v1/messages
  with header: Authorization: Bearer sk-your-moonshot-key
  ↓
OneCLI proxy intercepts (HTTPS_PROXY), sees api.moonshot.ai, passes through
  ↓
Moonshot API responds with Kimi K2.5 completion ✓
```

---

## Reverting to Claude (Anthropic)

To switch back to Anthropic Claude:

1. In `.env`:
   ```bash
   # Remove or comment out:
   # ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic
   # ANTHROPIC_AUTH_TOKEN=sk-moonshot-key
   # ANTHROPIC_MODEL=kimi-k2.5

   # Add back:
   ANTHROPIC_API_KEY=sk-ant-your-anthropic-key
   ```

2. In OneCLI, restore the Anthropic secret:
   ```bash
   onecli secrets create --name Anthropic --type anthropic \
     --value "sk-ant-your-key" \
     --host-pattern "api.anthropic.com"
   ```

3. Rebuild and restart NanoClaw.

---

## Key Takeaways

| Env Var | Purpose | When to Use |
|---------|---------|-------------|
| `ANTHROPIC_API_KEY` | Sets `x-api-key` header | Standard Anthropic API |
| `ANTHROPIC_AUTH_TOKEN` | Sets `Authorization: Bearer` header | Moonshot and other compatible providers |
| `ANTHROPIC_BASE_URL` | Redirects API endpoint | Any non-Anthropic provider |
| `ANTHROPIC_MODEL` | Sets default model | Override the default claude model name |

The critical insight: **the header format matters**. Moonshot uses Bearer auth, Anthropic uses x-api-key. Using the wrong env var causes silent 401 failures that look like retries in the logs.
