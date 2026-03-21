---
name: add-llamacpp-tool
description: Add llama.cpp MCP server so the container agent can call a local llama-server for cheaper/faster tasks like summarization, translation, or general queries.
---

# Add llama.cpp Integration

This skill adds a stdio-based MCP server that exposes a local llama-server instance as tools for the container agent. Claude remains the orchestrator but can offload work to the local model.

Tools added:
- `llamacpp_list_models` — lists the loaded model via `/v1/models`
- `llamacpp_generate` — sends a prompt to the model via `/completion` and returns the response

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `llamacpp` is in `applied_skills`, skip to Phase 3 (Configure). The code changes are already in place.

### Check prerequisites

Verify llama-server is running on the host:

```bash
curl http://localhost:8080/health
```

If llama-server is not running or not installed, direct the user:

> You need llama.cpp's `llama-server` running with a model loaded. Install and start it:
>
> ```bash
> # Build from source (or install via package manager)
> git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
> cmake -B build && cmake --build build --config Release
>
> # Start the server with a model
> ./build/bin/llama-server -m path/to/model.gguf
> ```
>
> The server loads one model at startup and serves it on port 8080.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-llamacpp-tool
```

This deterministically:
- Adds `container/agent-runner/src/llamacpp-mcp-stdio.ts` (llama.cpp MCP server)
- Adds `scripts/llamacpp-watch.sh` (macOS notification watcher)
- Three-way merges llama.cpp MCP config into `container/agent-runner/src/index.ts` (allowedTools + mcpServers)
- Three-way merges `[LLAMACPP]` log surfacing into `src/container-runner.ts`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/container/agent-runner/src/index.ts.intent.md` — what changed and invariants
- `modify/src/container-runner.ts.intent.md` — what changed and invariants

### Copy to per-group agent-runner

Existing groups have a cached copy of the agent-runner source. Copy the new files:

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/llamacpp-mcp-stdio.ts "$dir/"
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

### Ensure llama-server binds to all interfaces (Linux)

On Linux, Docker containers reach the host via `host.docker.internal` (mapped to the Docker bridge gateway, typically `172.17.0.1`). If llama-server is bound to `127.0.0.1` (the default), containers can't connect. Start it with `--host 0.0.0.0`:

```bash
llama-server -m model.gguf --host 0.0.0.0
```

On macOS with Docker Desktop this is not needed — `host.docker.internal` routes to `localhost` natively.

### Set llama.cpp host (optional)

By default, the MCP server connects to `http://host.docker.internal:8080` (Docker Desktop) with a fallback to `localhost`. To use a custom host, add to `.env`:

```bash
LLAMACPP_HOST=http://your-llamacpp-host:8080
```

### Restart the service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Verify

### Test via WhatsApp

Tell the user:

> Send a message like: "use llama.cpp to tell me the capital of France"
>
> The agent should use `llamacpp_list_models` to find the loaded model, then `llamacpp_generate` to get a response.

### Monitor activity (optional)

Run the watcher script for macOS notifications when llama.cpp is used:

```bash
./scripts/llamacpp-watch.sh
```

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i llamacpp
```

Look for:
- `Agent output: ... llama.cpp ...` — agent used llama.cpp successfully
- `[LLAMACPP] >>> Generating` — generation started (if log surfacing works)
- `[LLAMACPP] <<< Done` — generation completed

## Troubleshooting

### Agent says "llama.cpp is not installed"

The agent is trying to run `llama-server` inside the container instead of using the MCP tools. This means:
1. The MCP server wasn't registered — check `container/agent-runner/src/index.ts` has the `llamacpp` entry in `mcpServers`
2. The per-group source wasn't updated — re-copy files (see Phase 2)
3. The container wasn't rebuilt — run `./container/build.sh`

### "Failed to connect to llama-server"

1. Verify llama-server is running: `curl http://localhost:8080/health`
2. **Linux**: ensure llama-server was started with `--host 0.0.0.0` (default `127.0.0.1` is not reachable from Docker)
3. Check Docker can reach the host: `docker run --rm --add-host=host.docker.internal:host-gateway curlimages/curl curl -s http://host.docker.internal:8080/health`
4. If using a custom host, check `LLAMACPP_HOST` in `.env`

### Agent doesn't use llama.cpp tools

The agent may not know about the tools. Try being explicit: "use the llamacpp_generate tool to answer: ..."
