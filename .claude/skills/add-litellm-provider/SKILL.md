---
name: add-litellm-provider
description: Route a NanoClaw agent group through a LiteLLM proxy instead of the Anthropic API. LiteLLM translates Anthropic-format requests to 100+ LLM providers (OpenAI, Google, AWS Bedrock, Azure, Groq, Mistral, Cohere, etc.), so no provider code changes are needed — just env var overrides, a model setting, and a running LiteLLM instance. Same ANTHROPIC_BASE_URL redirect mechanism as /add-ollama-provider. Use when the user wants non-Anthropic models, cheaper providers, or a centralized AI gateway with cost tracking and load balancing.
---

# Add LiteLLM Provider

Routes an agent group through a [LiteLLM](https://github.com/BerriAI/litellm) proxy server instead of the Anthropic API. LiteLLM translates Anthropic-format requests to 100+ LLM providers, letting agents use OpenAI, Google, Bedrock, Azure, Groq, Mistral, and more.

Same mechanism as `/add-ollama-provider` — redirects `ANTHROPIC_BASE_URL` to the LiteLLM proxy, which speaks the Anthropic Messages API natively.

```
┌─────────────────────────────┐
│  Agent container            │
│                             │
│  Claude Code CLI            │
│    ↓ ANTHROPIC_BASE_URL     │
│    http://host.docker.      │      ┌──────────────────┐      ┌─────────────┐
│    internal:4000     ───────┼─────>│  LiteLLM :4000   │─────>│  OpenAI     │
│                             │      │  proxy server    │      │  Anthropic  │
└─────────────────────────────┘      │                  │      │  Bedrock    │
                                     │  cost tracking,  │      │  Vertex AI  │
                                     │  load balancing  │      │  Groq, ...  │
                                     └──────────────────┘      └─────────────┘
```

## Prerequisites

1. **LiteLLM proxy is running** on the host (or a reachable address). Verify:

   ```bash
   curl -s http://localhost:4000/health | head -5
   ```

   If not running, start it:

   ```bash
   # Quick start (pip)
   pip install 'litellm[proxy]'
   litellm --model openai/gpt-4o --port 4000

   # Or via Docker
   docker run -d --name litellm-proxy \
     -p 4000:4000 \
     -e OPENAI_API_KEY \
     -e ANTHROPIC_API_KEY \
     ghcr.io/berriai/litellm:main-latest \
     --port 4000
   ```

   See [LiteLLM Proxy docs](https://docs.litellm.ai/docs/proxy/quick_start) for full config (YAML-based model routing, virtual keys, spend tracking).

2. **At least one model is configured** in LiteLLM. Verify:

   ```bash
   curl -s http://localhost:4000/v1/models | head -20
   ```

3. **The agent group already exists** — run `/init-first-agent` first if needed.

## 1. Check source support

The feature requires two fields in `ContainerConfig` (`env` and `blockedHosts`) and their corresponding wiring in `container-runner.ts`. Check if already present:

```bash
grep -c 'blockedHosts' src/container-config.ts src/container-runner.ts
```

If either count is 0, apply the changes in steps 1a and 1b. Otherwise skip to step 2.

### 1a. Extend ContainerConfig

In `src/container-config.ts`, add to the `ContainerConfig` interface:

```typescript
env?: Record<string, string>;
blockedHosts?: string[];
```

And in `configFromDb`, add inside the returned object (after the existing fields):

```typescript
env: row.env ? JSON.parse(row.env) : undefined,
blockedHosts: row.blocked_hosts ? JSON.parse(row.blocked_hosts) : undefined,
```

### 1b. Wire into container-runner

In `src/container-runner.ts`, in the `buildRunArgs` function, after the provider-contributed env vars block (`providerContribution.env`), add:

```typescript
// Per-agent-group env overrides — applied last to win over OneCLI values.
if (containerConfig.env) {
  for (const [key, value] of Object.entries(containerConfig.env)) {
    args.push('-e', `${key}=${value}`);
  }
}

// Blocked hosts: resolve to 0.0.0.0 so they are unreachable inside the container.
if (containerConfig.blockedHosts) {
  for (const host of containerConfig.blockedHosts) {
    args.push('--add-host', `${host}:0.0.0.0`);
  }
}
```

### 1c. Fix home directory permissions (if not already done)

The container may run as your host uid (not uid 1000). Check the Dockerfile:

```bash
grep 'chmod.*home/node' container/Dockerfile
```

If it shows `chmod 755`, change it to `chmod 777` so any uid can write there. Then rebuild the container image: `./container/build.sh`

## 2. Identify the setup

Ask the user (plain text, not AskUserQuestion):

1. **Which agent group?** List available groups:
   ```bash
   pnpm exec tsx scripts/q.ts data/v2.db "SELECT folder, name FROM agent_groups;"
   ```
2. **LiteLLM proxy address?** Default: `http://host.docker.internal:4000` (host machine, Docker-reachable).
3. **LiteLLM proxy key?** If the proxy requires authentication. Default: none (use `"litellm"` as placeholder).
4. **Which model?** E.g. `openai/gpt-4o`, `anthropic/claude-sonnet-4-6`, `groq/llama-4-scout-17b-16e-instruct`. List available:
   ```bash
   curl -s http://localhost:4000/v1/models | grep '"id"'
   ```
5. **Block Anthropic API?** Recommended yes if the user wants to prevent accidental direct Anthropic spend.

Record as `FOLDER`, `LITELLM_URL`, `LITELLM_KEY`, `MODEL`, and `BLOCK_ANTHROPIC`.

## 3. Configure container.json

Read `groups/<FOLDER>/container.json`. Add (or merge into) an `env` block and optionally `blockedHosts`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "<LITELLM_URL>",
    "ANTHROPIC_API_KEY": "<LITELLM_KEY>",
    "NO_PROXY": "host.docker.internal",
    "no_proxy": "host.docker.internal"
  },
  "blockedHosts": ["api.anthropic.com"]
}
```

Omit `blockedHosts` if the user declined blocking. If `LITELLM_KEY` is empty, use `"litellm"` as the placeholder (LiteLLM proxy accepts any key when auth is disabled; the Anthropic SDK requires the field to be non-empty).

**Why these vars:** Same mechanism as Ollama — `ANTHROPIC_BASE_URL` redirects the Anthropic SDK to LiteLLM. `ANTHROPIC_API_KEY` satisfies the SDK's key requirement (LiteLLM either validates it against its virtual key store or ignores it when auth is off). `NO_PROXY` bypasses the OneCLI HTTPS proxy so requests reach LiteLLM directly.

## 4. Set the model

Read the agent group's shared Claude settings:

```bash
AG_ID=$(pnpm exec tsx scripts/q.ts data/v2.db "SELECT id FROM agent_groups WHERE folder='<FOLDER>';")
SETTINGS=data/v2-sessions/$AG_ID/.claude-shared/settings.json
```

Add `"model": "<MODEL>"` to that settings file. Create the file if it doesn't exist:

```json
{
  "model": "openai/gpt-4o"
}
```

If the file already has content, merge the `model` key in — don't overwrite existing keys.

**Why here and not container.json:** Claude Code reads its model from its own settings file, not from env vars. This file is bind-mounted into the container.

## 5. Build and restart

```bash
export PATH="/opt/homebrew/bin:$PATH"
pnpm run build
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
# Linux: systemctl --user restart nanoclaw
```

## 6. Verify

Send a message to the agent. Then confirm:

```bash
# Container has the right env vars
CTR=$(docker ps --filter "name=nanoclaw-v2-<FOLDER>" --format "{{.Names}}" | head -1)
docker inspect "$CTR" --format '{{json .HostConfig.ExtraHosts}}'
docker exec "$CTR" env | grep ANTHROPIC
```

Expected: `ANTHROPIC_BASE_URL=<LITELLM_URL>`, and if blocking was enabled, `api.anthropic.com:0.0.0.0` in ExtraHosts.

## Reverting to Claude

To switch back to the Anthropic API:

1. Remove the `env` and `blockedHosts` keys from `groups/<FOLDER>/container.json`
2. Remove `"model"` from the shared settings file
3. Restart the service

No rebuild needed — both files are read at container spawn time.

## Example LiteLLM config

For multi-model routing with cost tracking, create a `litellm_config.yaml`:

```yaml
model_list:
  - model_name: gpt-4o
    litellm_params:
      model: openai/gpt-4o
      api_key: os.environ/OPENAI_API_KEY
  - model_name: claude-sonnet
    litellm_params:
      model: anthropic/claude-sonnet-4-6
      api_key: os.environ/ANTHROPIC_API_KEY
  - model_name: gemini-flash
    litellm_params:
      model: vertex_ai/gemini-2.5-flash

general_settings:
  drop_params: true
```

Start with: `litellm --config litellm_config.yaml --port 4000`

## Troubleshooting

**Agent hangs, no response:** LiteLLM proxy may be unreachable from inside the container. Verify Docker networking: `docker exec "$CTR" curl -s http://host.docker.internal:4000/health`

**401 from LiteLLM:** The proxy requires a virtual key. Generate one at `http://localhost:4000/ui` or via the `/key/generate` endpoint, then update `ANTHROPIC_API_KEY` in `container.json`.

**"model not found" error:** The model name in `settings.json` must match what LiteLLM has configured. Run `curl -s http://localhost:4000/v1/models` to see available models.

**Responses claim to be Claude:** The backing model may identify differently. Add a line to `groups/<FOLDER>/CLAUDE.md` telling the agent what model it runs on.

**Slow first response:** Some providers (Bedrock, Vertex AI) have cold-start latency. Subsequent responses are faster.
