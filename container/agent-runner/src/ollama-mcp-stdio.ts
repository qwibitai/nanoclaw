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

server.tool(
  'ollama_pull_model',
  'Pull (download) a model from the Ollama registry by name. Returns the final status once the pull is complete. Use model names like "llama3.2", "mistral", "gemma2:9b".',
  {
    model: z.string().describe('Model name to pull, e.g. "llama3.2", "mistral", "gemma2:9b"'),
  },
  async (args) => {
    log(`Pulling model: ${args.model}...`);
    writeStatus('pulling', `Pulling ${args.model}`);
    try {
      const res = await ollamaFetch('/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: args.model, stream: false }),
      });
      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [{ type: 'text' as const, text: `Ollama error (${res.status}): ${errorText}` }],
          isError: true,
        };
      }
      const data = await res.json() as { status: string };
      log(`Pull complete: ${args.model} — ${data.status}`);
      writeStatus('done', `Pulled ${args.model}`);
      return { content: [{ type: 'text' as const, text: `Pull complete: ${args.model} — ${data.status}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to pull model: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'ollama_delete_model',
  'Delete a locally installed Ollama model to free up disk space.',
  {
    model: z.string().describe('Model name to delete, e.g. "llama3.2", "mistral:latest"'),
  },
  async (args) => {
    log(`Deleting model: ${args.model}...`);
    writeStatus('deleting', `Deleting ${args.model}`);
    try {
      const res = await ollamaFetch('/api/delete', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: args.model }),
      });
      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [{ type: 'text' as const, text: `Ollama error (${res.status}): ${errorText}` }],
          isError: true,
        };
      }
      log(`Deleted: ${args.model}`);
      writeStatus('done', `Deleted ${args.model}`);
      return { content: [{ type: 'text' as const, text: `Deleted model: ${args.model}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to delete model: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'ollama_show_model',
  'Show details for a locally installed Ollama model: modelfile, parameters, template, system prompt, and architecture info (context length, parameter count, etc.).',
  {
    model: z.string().describe('Model name to inspect, e.g. "llama3.2", "mistral:latest"'),
  },
  async (args) => {
    log(`Showing model info: ${args.model}...`);
    try {
      const res = await ollamaFetch('/api/show', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: args.model }),
      });
      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [{ type: 'text' as const, text: `Ollama error (${res.status}): ${errorText}` }],
          isError: true,
        };
      }
      const data = await res.json();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to show model info: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'ollama_list_running',
  'List Ollama models currently loaded in memory with their memory usage, processor type (CPU/GPU), and time until they are unloaded.',
  {},
  async () => {
    log('Listing running models...');
    try {
      const res = await ollamaFetch('/api/ps');
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `Ollama API error: ${res.status} ${res.statusText}` }],
          isError: true,
        };
      }
      const data = await res.json() as { models?: Array<{ name: string; size_vram: number; processor: string; expires_at: string }> };
      const models = data.models || [];
      if (models.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No models currently loaded in memory.' }] };
      }
      const list = models
        .map(m => `- ${m.name} (${(m.size_vram / 1e9).toFixed(1)}GB ${m.processor}, unloads at ${m.expires_at})`)
        .join('\n');
      log(`${models.length} model(s) running`);
      return { content: [{ type: 'text' as const, text: `Models loaded in memory:\n${list}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to list running models: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
