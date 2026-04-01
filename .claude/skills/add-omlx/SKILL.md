---
name: add-omlx
description: Add oMLX MCP server so the container agent can call local MLX models and check server status.
---

# Add oMLX Integration

This skill adds a stdio-based MCP server that exposes local oMLX models as tools for the container agent. Claude remains the orchestrator but can offload work to local models running on Apple Silicon via oMLX.

Core tools (always available):
- `omlx_list_models` -- list available oMLX models
- `omlx_chat` -- send a message to a local model and get a response
- `omlx_server_status` -- check server health, loaded models, memory usage

Admin tools (opt-in via `OMLX_ADMIN_TOOLS=true`):
- `omlx_unload_model` -- unload a model from memory to free RAM

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/omlx-mcp-stdio.ts` exists. If it does, skip to Phase 3.

### Check prerequisites

Verify oMLX is installed and running:

```bash
curl -s http://localhost:8000/health
```

If not running, direct user to install oMLX from their admin dashboard or CLI.

## Phase 2: Code Changes

The following files are modified:

- `container/agent-runner/src/omlx-mcp-stdio.ts` -- oMLX MCP server (OpenAI-compatible API)
- `container/agent-runner/src/index.ts` -- registers omlx MCP server (conditionally, when OMLX_HOST or OMLX_API_KEY is set)
- `src/config.ts` -- exports OMLX_HOST, OMLX_API_KEY, OMLX_ADMIN_TOOLS
- `src/container-runner.ts` -- passes oMLX env vars to container, surfaces `[OMLX]` logs at info level

### Rebuild

```bash
npm run build
./container/build.sh
```

### Copy to per-group agent-runner

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/omlx-mcp-stdio.ts "$dir/"
  cp container/agent-runner/src/index.ts "$dir/"
done
```

## Phase 3: Configure

### Set oMLX connection details in `.env`

```bash
OMLX_HOST=http://host.docker.internal:8000
OMLX_API_KEY=your-omlx-api-key
OMLX_ADMIN_TOOLS=true
```

- `OMLX_HOST`: The oMLX server URL as seen from inside the container. Use `host.docker.internal` for Docker.
- `OMLX_API_KEY`: Your oMLX API key (if auth is enabled). If "Skip API key verification" is on for localhost, this can be omitted.
- `OMLX_ADMIN_TOOLS`: Set to `true` to enable model unload tool.

### Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

## Phase 4: Verify

### Test inference

Send a message like: "use omlx to tell me the capital of France"

The agent should call `omlx_list_models` then `omlx_chat` with one of the available models.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -i omlx
```

Look for:
- `[OMLX] >>> Chatting with` -- generation started
- `[OMLX] <<< Done` -- generation completed

## Troubleshooting

### "Failed to connect to oMLX"

1. Verify oMLX is running: `curl http://localhost:8000/health`
2. Check Docker can reach host: `docker run --rm curlimages/curl curl -s -H "Authorization: Bearer YOUR_KEY" http://host.docker.internal:8000/v1/models`
3. Check `OMLX_HOST` in `.env`

### "API key required"

oMLX has API key auth enabled. Either:
1. Set `OMLX_API_KEY` in `.env`
2. Or enable "Skip API key verification" for localhost in oMLX admin settings

### Agent doesn't use oMLX tools

The agent may not know about the tools. Try being explicit: "use the omlx_chat tool with Qwen3.5-27B-8bit to answer: ..."
