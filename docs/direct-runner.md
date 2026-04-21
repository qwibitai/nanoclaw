# Direct Runner Mode

Run the Claude Agent SDK in-process instead of spawning Docker containers. No Docker required.

## Why

Docker containers add overhead that may not be needed for personal deployments:

| | Container Mode | Direct Mode |
|---|---|---|
| RAM per agent | ~400 MB | ~50 MB |
| Startup time | ~5 seconds | < 1 second |
| Max concurrent (32 GB) | 3–4 before OOM | 8–10 comfortably |
| Dependencies | Docker + credential proxy | Node.js only |

## Setup

### 1. Install the SDK dependency

```bash
npm install @anthropic-ai/claude-agent-sdk @modelcontextprotocol/sdk
```

### 2. Build

```bash
npm run build
```

### 3. Set the environment variable

```bash
# In your .env or systemd unit
NANOCLAW_DIRECT_RUNNER=1
```

### 4. Start with the module loader

```bash
node --import ./dist/direct-runner-loader.js dist/index.js
```

Or in a systemd unit:

```ini
[Service]
Environment=NANOCLAW_DIRECT_RUNNER=1
ExecStart=/usr/bin/node --import ./dist/direct-runner-loader.js dist/index.js
```

## How It Works

The direct runner uses [Node.js module resolution hooks](https://nodejs.org/api/module.html#customization-hooks) to swap modules at runtime:

| Original Module | Replaced With | Effect |
|---|---|---|
| `container-runner.js` | `agent-runner.js` | SDK runs in-process |
| `container-runtime.js` | `noop-container.js` | Skips Docker checks |
| `credential-proxy.js` | `noop-container.js` | SDK authenticates directly |

**No existing source files are modified.** The loader only activates when `NANOCLAW_DIRECT_RUNNER=1` is set. Without it, NanoClaw runs in container mode as usual.

## Authentication

The direct runner reads credentials from your `.env` file:

- **API key mode**: Set `ANTHROPIC_API_KEY` in `.env`
- **OAuth mode**: Set `CLAUDE_CODE_OAUTH_TOKEN` in `.env`

No credential proxy is needed — the SDK authenticates directly with the Anthropic API.

## MCP Tools

The direct runner includes host-side MCP servers that provide the same tools available inside containers:

- **Memory** — `memory_search`, `memory_store`, `memory_graph_search` (requires Engram)
- **Knowledge Base** — `kb_search`, `kb_list`, `kb_get_document` (requires KB server)
- **Web** — `crawl_page`
- **Crypto** — `crypto_price`, `crypto_market_chart`, `crypto_search`
- **OCR** — `ocr_extract` (requires Mathpix credentials)
- **Skills** — `get_skill`, `list_skills`
- **IPC** — `send_message`, `schedule_task`, `host_exec`, etc.

## Compatibility

The direct runner exports the same function signature as `runContainerAgent()`, and polls the same IPC files that containers would. This means:

- `group-queue.ts` works unchanged (message piping, idle timeouts)
- `ipc.ts` works unchanged (task scheduling, host commands)
- `task-scheduler.ts` works unchanged (scheduled tasks)
- Session management works unchanged

## Trade-offs

| What you gain | What you lose |
|---|---|
| No Docker dependency | No container isolation between agents |
| Lower memory usage | No filesystem sandboxing |
| Faster startup | No cgroup resource limits |
| Simpler deployment | Agents share the host filesystem |

For personal or trusted deployments, the direct runner is recommended. For multi-tenant or untrusted deployments, use container mode.

## Switching Back

Remove the environment variable and loader flag:

```bash
# Just run the original way
node dist/index.js
```

No code changes needed — the loader does nothing without `NANOCLAW_DIRECT_RUNNER=1`.
