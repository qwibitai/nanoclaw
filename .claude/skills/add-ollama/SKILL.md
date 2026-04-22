---
name: add-ollama
description: Add Ollama MCP server so the container agent can call local models for cheaper/faster tasks like summarization, translation, or general queries.
---

# Add Ollama Integration

This skill adds a stdio-based MCP server that exposes the Ollama REST API as tools for the container agent.

Tools added:
- `ollama_list_models` — list installed models with name, size, family, and modified date
- `ollama_pull_model` — pull a model from the Ollama registry by name
- `ollama_delete_model` — remove a locally installed model to free disk space
- `ollama_show_model` — show model details: modelfile, parameters, template, and architecture info
- `ollama_list_running` — list models currently loaded in memory with memory usage and processor type

All tool calls from the agent use the MCP prefix: `mcp__ollama__<tool>`

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/ollama-mcp-stdio.ts` already exists. If it does, skip to Phase 3 (Configure).

### Collect connection details

Use `AskUserQuestion` to ask:

> What is the URL of your Ollama server? The default is `http://ollama:11434` if Ollama is running as a Docker container on the same network. Use `http://host.docker.internal:11434` if it is running directly on the Docker host.

### Test API connectivity

```bash
curl -s <OLLAMA_URL>/api/tags | head -c 500
```

The response must be valid JSON with a `models` array. If the request fails with connection refused, stop and tell the user to verify:
1. Ollama is running (`ollama serve` or via Docker)
2. The URL is reachable from the NanoClaw container (check Docker network)
3. Ollama is listening on the correct interface (not just 127.0.0.1 if remote access is needed)

Do not proceed until the test passes.

## Phase 2: Apply Code Changes

### Write the MCP server

Create `container/agent-runner/src/ollama-mcp-stdio.ts` with exactly the following content:

```typescript
/**
 * Stdio MCP Server for Ollama
 * Exposes the Ollama REST API as tools for the container agent.
 *
 * Auth:
 *   No authentication required.
 *
 * Config:
 *   OLLAMA_URL=http://ollama:11434   (no trailing slash)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.OLLAMA_URL ?? 'http://ollama:11434').replace(/\/$/, '');

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function apiDelete(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(e: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true as const,
  };
}

// --- MCP Server ---

const mcpServer = new McpServer({ name: 'ollama', version: '1.0.0' });

mcpServer.tool(
  'ollama_list_models',
  'List all locally installed Ollama models. Returns model name, size on disk, parameter count, format, family, and last modified date.',
  {},
  async () => {
    try { return ok(await apiGet('/api/tags')); } catch (e) { return err(e); }
  },
);

mcpServer.tool(
  'ollama_pull_model',
  'Pull (download) a model from the Ollama registry. Returns the final status once the pull is complete. Use model names like "llama3.2", "mistral", "gemma2:9b", etc.',
  {
    model: z.string().describe('Model name to pull, e.g. "llama3.2", "mistral", "gemma2:9b"'),
  },
  async (args) => {
    try {
      return ok(await apiPost('/api/pull', { model: args.model, stream: false }));
    } catch (e) { return err(e); }
  },
);

mcpServer.tool(
  'ollama_delete_model',
  'Delete a locally installed Ollama model to free up disk space.',
  {
    model: z.string().describe('Model name to delete, e.g. "llama3.2", "mistral:latest"'),
  },
  async (args) => {
    try {
      await apiDelete('/api/delete', { model: args.model });
      return ok({ status: 'deleted', model: args.model });
    } catch (e) { return err(e); }
  },
);

mcpServer.tool(
  'ollama_show_model',
  'Show details for a locally installed Ollama model: modelfile, parameters, template, system prompt, and model info (architecture, context length, etc.).',
  {
    model: z.string().describe('Model name to inspect, e.g. "llama3.2", "mistral:latest"'),
  },
  async (args) => {
    try {
      return ok(await apiPost('/api/show', { model: args.model }));
    } catch (e) { return err(e); }
  },
);

mcpServer.tool(
  'ollama_list_running',
  'List Ollama models currently loaded in memory with their memory usage, processor (CPU/GPU), and time until they are unloaded.',
  {},
  async () => {
    try { return ok(await apiGet('/api/ps')); } catch (e) { return err(e); }
  },
);

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
```

### Wire into agent-runner index.ts

Open `container/agent-runner/src/index.ts` and make five edits:

**1. Add path variable** — immediately after the `homeassistantMcpServerPath` line, add:

```typescript
const ollamaMcpServerPath = path.join(__dirname, 'ollama-mcp-stdio.js');
```

**2. Add to `runQuery` function signature** — in the `runQuery` function parameters, after `homeassistantMcpServerPath: string`, add:

```typescript
ollamaMcpServerPath: string,
```

**3. Add to `allowedTools`** — in the `allowedTools` array, after `'mcp__homeassistant__*'`, add:

```typescript
'mcp__ollama__*',
```

**4. Add to `mcpServers`** — inside the `mcpServers` object, after the closing brace of the `homeassistant` entry, add:

```typescript
ollama: {
  command: 'node',
  args: [ollamaMcpServerPath],
  env: {
    OLLAMA_URL: sdkEnv.OLLAMA_URL ?? '',
  },
},
```

**5. Update the `runQuery` call site** — find the call to `runQuery(...)` in `main()` and add `ollamaMcpServerPath` after `homeassistantMcpServerPath`:

```typescript
// Before:
const queryResult = await runQuery(prompt, sessionId, mcpServerPath, unraidclawMcpServerPath, tailscaleMcpServerPath, homeassistantMcpServerPath, containerInput, sdkEnv, resumeAt);
// After:
const queryResult = await runQuery(prompt, sessionId, mcpServerPath, unraidclawMcpServerPath, tailscaleMcpServerPath, homeassistantMcpServerPath, ollamaMcpServerPath, containerInput, sdkEnv, resumeAt);
```

### Copy to per-group agent-runner

Existing groups have a cached copy of the agent-runner source. Update them:

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/ollama-mcp-stdio.ts "$dir/"
  cp container/agent-runner/src/index.ts "$dir/"
done
```

### Build

```bash
npm run build
./container/build.sh
```

Build must be clean before proceeding. If there are TypeScript errors, read and fix them before continuing.

## Phase 2b: Update container-runner.ts

### Update container-runner.ts

The main NanoClaw process passes environment variables to agent containers explicitly. Open `src/container-runner.ts` and add the following block immediately after the `HA_TOKEN` block:

```typescript
  if (process.env.OLLAMA_URL) {
    args.push('-e', `OLLAMA_URL=${process.env.OLLAMA_URL}`);
  }
```

Without this step the Ollama MCP server will start but will use the default URL (`http://ollama:11434`) regardless of what is configured — which may not match the user's actual Ollama deployment.

## Phase 3: Configure

### Configure environment variables

On Unraid/Docker deployments: add the variable directly to the NanoClaw container template via the Unraid Docker UI (edit container → add variable). The credential proxy passes it to child containers automatically.

On standard Linux/macOS deployments: append to `.env` and sync:

```bash
OLLAMA_URL=http://ollama:11434
```

Then sync:
```bash
cp .env data/env/env
```

Also add a placeholder entry to `.env.example` if not already present:

```bash
OLLAMA_URL=
```

### Restart the service

On Unraid/Docker deployments, restart via SSH:
```bash
docker restart NanoClaw
```
On standard Linux: `systemctl --user restart nanoclaw`
On macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

## Phase 4: Verify

### Test the tools

Tell the user:

> Send a message like: "list my ollama models"
>
> The agent should call `mcp__ollama__ollama_list_models` and return the installed model list.
>
> To check what's running: "what ollama models are currently loaded in memory?"
> The agent will call `mcp__ollama__ollama_list_running`.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i ollama
```

Look for tool calls like `mcp__ollama__ollama_list_models` appearing in agent output.

## Troubleshooting

### Connection refused or "fetch failed"

Ollama is not reachable at the configured URL. Check:
1. Ollama is running (`ollama serve` or `docker ps | grep ollama`)
2. The URL is reachable from inside the agent container
3. If Ollama runs on the Docker host, use `http://host.docker.internal:11434` (macOS/Windows) or the host's bridge IP (Linux)
4. If Ollama runs in a sibling container, they must be on the same Docker network

### Agent doesn't use Ollama tools

1. Check `container/agent-runner/src/index.ts` has `'mcp__ollama__*'` in `allowedTools`
2. Check the `ollama` entry is in `mcpServers` with `OLLAMA_URL`
3. Verify the per-group source was updated (see Phase 2)
4. Confirm the container image was rebuilt with `./container/build.sh`
5. Try being explicit: "use the ollama_list_models tool to show my installed models"

### OLLAMA_URL not reaching the container

The `OLLAMA_URL` is set in the NanoClaw container but not being forwarded to agent containers. Verify `src/container-runner.ts` has the `OLLAMA_URL` passthrough block from Phase 2b. If missing, add it and rebuild: `npm run build` then restart NanoClaw.

### ollama_pull_model times out

Large model pulls take several minutes. The agent container has a generous timeout, but very large models (70B+) may exceed it. Pull the model manually on the Ollama host first:

```bash
ollama pull <model-name>
```

Then use `ollama_list_models` to confirm it is available.

### Agent runner won't start after changes

Check for TypeScript errors:

```bash
cd container/agent-runner && npx tsc --noEmit
```

Common cause: `ollamaMcpServerPath` parameter added to signature but not to the call site (or vice versa).

## Removal

To remove the Ollama integration:

1. Delete `container/agent-runner/src/ollama-mcp-stdio.ts`
2. Remove the `ollamaMcpServerPath` variable, `ollamaMcpServerPath` parameter, `'mcp__ollama__*'` from `allowedTools`, and the `ollama` entry from `mcpServers` in `container/agent-runner/src/index.ts`
3. Remove `OLLAMA_URL` from `.env` and sync: `cp .env data/env/env`
4. Remove the placeholder line from `.env.example`
5. Rebuild: `npm run build && ./container/build.sh`
6. Restart:
```bash
docker restart NanoClaw  # Unraid/Docker
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux: systemctl --user restart nanoclaw
```
