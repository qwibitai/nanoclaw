---
name: use-avian
description: Use Avian as the LLM provider. Avian provides an OpenAI-compatible API at api.avian.io with models like DeepSeek V3.2, Kimi K2.5, GLM-5, and Minimax M2.5. Use when the user wants to switch from Anthropic to Avian for lower cost or different model access.
---

# Use Avian as LLM Provider

This skill configures NanoClaw to use [Avian](https://avian.io) as the LLM provider instead of Anthropic. Avian provides an OpenAI-compatible API that works with the Claude Code CLI via the `ANTHROPIC_BASE_URL` environment variable.

## Available Models

| Model ID | Context Window | Max Output |
|----------|---------------|------------|
| `deepseek/deepseek-v3.2` | 164K tokens | 65K tokens |
| `moonshotai/kimi-k2.5` | 131K tokens | 8K tokens |
| `z-ai/glm-5` | 131K tokens | 16K tokens |
| `minimax/minimax-m2.5` | 1M tokens | 1M tokens |

All models support chat completions, streaming, and function calling/tools.

## Phase 1: Collect API Key

### Ask the user

AskUserQuestion: Do you have an Avian API key? You can get one at https://avian.io

If they don't have one, tell them:

> 1. Go to [avian.io](https://avian.io) and create an account
> 2. Navigate to the API Keys section in your dashboard
> 3. Create a new API key and copy it

Wait for the user to provide the key.

### Choose model

AskUserQuestion: Which Avian model would you like to use?
- **DeepSeek V3.2** (`deepseek/deepseek-v3.2`) — 164K context, 65K output, strong general-purpose model
- **Kimi K2.5** (`moonshotai/kimi-k2.5`) — 131K context, 8K output
- **GLM-5** (`z-ai/glm-5`) — 131K context, 16K output
- **Minimax M2.5** (`minimax/minimax-m2.5`) — 1M context, 1M output, largest context window

Default to `deepseek/deepseek-v3.2` if the user has no preference.

## Phase 2: Configure Environment

Add to `.env`:

```bash
AVIAN_API_KEY=<their-key>
AVIAN_MODEL=<chosen-model>
```

Remove or comment out `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` if present (they would take priority).

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 3: Apply Code Changes

Two files need modification. Do NOT use the skills engine for this — make the edits directly.

### 3a. Modify `src/container-runner.ts`

In the `readSecrets()` function, add `AVIAN_API_KEY` and `AVIAN_MODEL` to the keys array:

```typescript
function readSecrets(): Record<string, string> {
  return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'AVIAN_API_KEY', 'AVIAN_MODEL']);
}
```

In the `runContainerAgent()` function, after `input.secrets = readSecrets();`, add logic to map Avian credentials to the env vars that the Claude Code CLI expects:

```typescript
// Map Avian provider credentials to Claude Code CLI env vars
if (input.secrets?.AVIAN_API_KEY) {
  input.secrets.ANTHROPIC_AUTH_TOKEN = input.secrets.AVIAN_API_KEY;
  input.secrets.ANTHROPIC_BASE_URL = 'https://api.avian.io/v1';
}
```

### 3b. Modify `container/agent-runner/src/index.ts`

In the `runQuery()` function, add `model` to the `query()` options:

```typescript
for await (const message of query({
  prompt: stream,
  options: {
    model: sdkEnv.AVIAN_MODEL || sdkEnv.CLAUDE_MODEL || undefined,
    // ... rest of existing options
  }
})) {
```

This ensures the selected Avian model is passed to the SDK. Falls back to `CLAUDE_MODEL` for backwards compatibility (see issue #472).

### 3c. Validate

```bash
npm run build
```

Build must succeed before proceeding.

## Phase 4: Rebuild and Restart

### Clear stale agent-runner copies

The agent-runner source is copied per-group on first run and goes stale (see issue #472). Force a refresh:

```bash
rm -rf data/sessions/*/agent-runner-src/
```

### Rebuild container and restart

```bash
./container/build.sh
npm run build
```

Then restart the service:

```bash
# macOS (launchd):
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd):
systemctl --user restart nanoclaw
```

## Phase 5: Verify

Tell the user:

> Send a test message in your registered chat. The agent should respond using the Avian model. Check the logs to confirm:
>
> ```bash
> tail -f logs/nanoclaw.log
> ```
>
> Look for the model name in the `system/init` message to verify the correct model is being used.

## Troubleshooting

### Agent still using Anthropic

1. Check `.env` has `AVIAN_API_KEY` and `AVIAN_MODEL` set
2. Ensure `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are removed or commented out
3. Verify `.env` is synced: `cp .env data/env/env`
4. Delete stale agent-runner copies: `rm -rf data/sessions/*/agent-runner-src/`
5. Rebuild container: `./container/build.sh`
6. Restart service

### Authentication errors

Verify your API key works:

```bash
curl -s https://api.avian.io/v1/models \
  -H "Authorization: Bearer $AVIAN_API_KEY" | head -20
```

### Model not found

Check the model ID is exactly right (case-sensitive). Valid IDs:
- `deepseek/deepseek-v3.2`
- `moonshotai/kimi-k2.5`
- `z-ai/glm-5`
- `minimax/minimax-m2.5`

## Reverting

To switch back to Anthropic:

1. Remove `AVIAN_API_KEY` and `AVIAN_MODEL` from `.env`
2. Add back `ANTHROPIC_API_KEY=<key>` or `CLAUDE_CODE_OAUTH_TOKEN=<token>`
3. Sync: `cp .env data/env/env`
4. Delete stale copies: `rm -rf data/sessions/*/agent-runner-src/`
5. Rebuild: `./container/build.sh && npm run build`
6. Restart service
