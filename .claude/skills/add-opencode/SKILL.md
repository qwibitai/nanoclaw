---
name: add-opencode
description: Add OpenCode SDK as an alternative agent backend to NanoClaw. Lets you run any LLM provider (OpenRouter, OpenAI, Google, DeepSeek, etc.) instead of the Anthropic SDK. Switch between runners via AGENT_RUNNER in .env or per-group in container config.
---

# Add OpenCode Runner

This skill adds [OpenCode SDK](https://github.com/anomalyco/opencode) as an alternative agent backend. After applying, you can use any LLM provider (OpenRouter, OpenAI, Google Gemini, DeepSeek, etc.) instead of — or alongside — Anthropic's Claude.

## What it does

- Adds an OpenCode runner that dispatches to any supported LLM provider
- Global default via `AGENT_RUNNER=opencode` in `.env`
- Per-group override via `containerConfig.agentRunner` — run different providers in different groups simultaneously
- OpenCode sessions persist per-group on disk so context survives restarts
- All MCP servers added via `claude mcp add` are automatically bridged to OpenCode
- Credentials are managed by OneCLI — containers never see real API keys

## Phase 1: Pre-flight

### Check current state

```bash
ls container/agent-runner/src/runners/opencode.ts 2>/dev/null && echo "Already applied" || echo "Not applied"
```

If already applied, skip to Phase 3 (Configuration).

### Check NanoClaw version compatibility

```bash
grep '"version"' package.json
```

This skill requires NanoClaw ≥ 1.2.0 (container runner architecture). If older, run `/update-nanoclaw` first.

## Phase 2: Build

After merging the skill branch, rebuild the host and container:

```bash
npm run build
./container/build.sh
```

If the build cache is stale, prune first:

```bash
docker buildx prune -f
./container/build.sh
```

## Phase 3: Configuration

### Global switch (all groups)

Edit `.env` to set the provider, model, and API key:

```
AGENT_RUNNER=opencode
OPENCODE_PROVIDER=openrouter
OPENCODE_MODEL=openrouter/qwen/qwen3.5-flash-02-23
OPENCODE_SMALL_MODEL=openrouter/qwen/qwen3.5-flash-02-23
```

`OPENCODE_SMALL_MODEL` controls the model used for title generation. Set it to the same value as `OPENCODE_MODEL` to avoid unexpected API calls to a second model.

### Per-group switch

To run a specific group on OpenCode while others stay on Anthropic, send the `register_group` IPC command (from your main group agent) with `containerConfig.agentRunner` set:

```json
{
  "type": "register_group",
  "jid": "<group-jid>",
  "name": "<group-name>",
  "folder": "<group-folder>",
  "trigger": "<trigger-word>",
  "containerConfig": { "agentRunner": "opencode" }
}
```

The setting is stored in the `container_config` JSON column in the database and survives restarts. When present, it overrides the global `AGENT_RUNNER`.

### Register provider keys in OneCLI

OneCLI injects API keys at request time via host-pattern matching. Register each provider's key before use:

```bash
# OpenRouter
onecli secrets create --name OpenRouter --type api_key \
  --value sk-or-v1-... --host-pattern openrouter.ai

# OpenAI
onecli secrets create --name OpenAI --type api_key \
  --value sk-... --host-pattern api.openai.com

# Google Gemini
onecli secrets create --name Google --type api_key \
  --value your-key --host-pattern generativelanguage.googleapis.com
```

Without this step, the provider returns an auth error.

### Supported providers

| Provider      | `OPENCODE_PROVIDER` | OneCLI host pattern                 |
| ------------- | ------------------- | ----------------------------------- |
| Anthropic     | `anthropic`         | `api.anthropic.com`                 |
| OpenRouter    | `openrouter`        | `openrouter.ai`                     |
| OpenAI        | `openai`            | `api.openai.com`                    |
| Google Gemini | `google`            | `generativelanguage.googleapis.com` |
| DeepSeek      | `deepseek`          | `api.deepseek.com`                  |
| Groq          | `groq`              | `api.groq.com`                      |
| Mistral       | `mistral`           | `api.mistral.ai`                    |
| xAI Grok      | `xai`               | `api.x.ai`                          |
| Together AI   | `together`          | `api.together.xyz`                  |
| Fireworks     | `fireworks`         | `api.fireworks.ai`                  |
| Cohere        | `cohere`            | `api.cohere.ai`                     |
| Moonshot      | `moonshot`          | `api.moonshot.cn`                   |

### Restart NanoClaw

```bash
# Linux (systemd)
systemctl restart nanoclaw

# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

Send a message to your registered group and check for a response.

Check container logs:

```bash
docker logs $(docker ps --format '{{.Names}}' | grep nanoclaw | head -1)
```

Key log lines:

- `[agent-runner] Starting OpenCode query` — runner selected correctly
- `[agent-runner] OpenCode session created: ses_...` — session started
- `[agent-runner] OpenCode session idle` — response received
- `[agent-runner] OpenCode query done. result_len=N` — N > 0 means success

## Switching Back to Anthropic

Set `AGENT_RUNNER=anthropic` in `.env` (or clear `agentRunner` in per-group config) and restart NanoClaw. If the stored session ID format doesn't match the runner (OpenCode IDs start with `ses_`, Anthropic IDs are UUIDs), the runner reports a stale-session error on the first attempt, the session is auto-cleared, and the next message starts a fresh session.

## Architecture Notes

**Credentials**: Injected by OneCLI gateway at request time — containers never see real API keys. The OpenCode runner sends requests through OneCLI's MITM proxy, which replaces the placeholder key with the real one from the vault.

**Sessions**: OpenCode sessions persist on disk at `data/sessions/<group>/opencode/` (mounted into the container). Isolated per group.

**MCPs**: Any MCP added via `claude mcp add` is automatically bridged to OpenCode by reading `settings.json` inside the container.

**CLAUDE.md**: The runner reads `/workspace/group/CLAUDE.md` (and `/workspace/global/CLAUDE.md` for non-main groups) and prepends it to every prompt inside `<system>` tags. OpenCode doesn't read `CLAUDE.md` from the filesystem automatically, so the runner injects it manually on every turn.

**Per-group runner**: `agentRunner` in `ContainerConfig` is persisted in the `container_config` JSON column of `registered_groups`. No schema migration needed.

## Known Gotchas

### 1. SSE stream closes on `for-await break` — use `.next()` instead

`for await (const ev of stream) { break; }` calls `generator.return()`, which closes the underlying SSE HTTP connection. The second `runQuery()` call then iterates a dead generator and exits immediately with no events. **Symptom**: first message works, all follow-ups produce `result_len=0` with no `[ev]` log lines. **Fix**: use `while (true) { const { value, done } = await stream.next(); ... }`.

### 2. `message.part.updated` fires before `message.updated`

Streaming text parts arrive _before_ the message role is set. Filtering part events by role eagerly misses all text. **Fix**: buffer text parts keyed by `messageID`; resolve roles at `session.idle` from `message.updated` events.

### 3. `newSessionId` must NOT be emitted on session errors

If `session.error` emits `onOutput({ ..., newSessionId })`, NanoClaw stores the broken ID and loops on failure indefinitely. Always omit `newSessionId` from error outputs.

### 4. XDG_DATA_HOME must be set explicitly

Without `XDG_DATA_HOME=/home/node/.local/share`, OpenCode writes session state outside the mounted volume and sessions don't persist across container restarts.

### 5. `OPENCODE_SMALL_MODEL` defaults to a different model

If unset, OpenCode picks its own default small model for title generation, triggering an unexpected second API call. Set it to the same value as `OPENCODE_MODEL`.

### 6. Models not in OpenCode's registry need explicit registration

If a model isn't in OpenCode's built-in database, `createOpencode()` will fail to start. Register it under the `provider` config key with `{ id, name, tool_call: true }`.

### 7. NO_PROXY must exclude localhost when using OneCLI

OneCLI is a transparent MITM proxy intercepting all outbound HTTPS. OpenCode runs its own local server at `127.0.0.1:4096` that the SDK must reach directly. Without `NO_PROXY=127.0.0.1,localhost`, OneCLI intercepts these local requests and closes the connection (`ECONNRESET`). The skill sets this env var automatically.

### 8. Inline `.env` comments break values

`.env` files do not support inline comments. `KEY=value  # comment` sets the value to `value  # comment`. Put comments on their own line above the key.
