/**
 * oMLX MCP Server for NanoClaw
 * Exposes local oMLX models as tools for the container agent.
 * Uses host.docker.internal to reach the host's oMLX instance from Docker.
 * oMLX serves an OpenAI-compatible API at /v1/*.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import fs from 'fs';
import path from 'path';

const OMLX_HOST = process.env.OMLX_HOST || 'http://host.docker.internal:8000';
const OMLX_API_KEY = process.env.OMLX_API_KEY || '';
const OMLX_ADMIN_TOOLS = process.env.OMLX_ADMIN_TOOLS === 'true';
const OMLX_STATUS_FILE = '/workspace/ipc/omlx_status.json';

function log(msg: string): void {
  console.error(`[OMLX] ${msg}`);
}

function writeStatus(status: string, detail?: string): void {
  try {
    const data = { status, detail, timestamp: new Date().toISOString() };
    const tmpPath = `${OMLX_STATUS_FILE}.tmp`;
    fs.mkdirSync(path.dirname(OMLX_STATUS_FILE), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, OMLX_STATUS_FILE);
  } catch { /* best-effort */ }
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (OMLX_API_KEY) {
    headers['Authorization'] = `Bearer ${OMLX_API_KEY}`;
  }
  return headers;
}

const OMLX_REQUEST_TIMEOUT_MS = 120_000; // 2 minutes — generous for large model inference

async function omlxFetch(urlPath: string, options?: RequestInit): Promise<Response> {
  const url = `${OMLX_HOST}${urlPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OMLX_REQUEST_TIMEOUT_MS);
  const opts: RequestInit = {
    ...options,
    headers: { ...authHeaders(), ...options?.headers },
    signal: controller.signal,
  };
  try {
    const res = await fetch(url, opts);
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`oMLX request timed out after ${OMLX_REQUEST_TIMEOUT_MS / 1000}s`);
    }
    // Fallback to localhost if host.docker.internal fails
    if (OMLX_HOST.includes('host.docker.internal')) {
      const fallbackUrl = url.replace('host.docker.internal', 'localhost');
      const fallbackTimer = setTimeout(() => controller.abort(), OMLX_REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(fallbackUrl, { ...opts, signal: AbortSignal.timeout(OMLX_REQUEST_TIMEOUT_MS) });
        clearTimeout(fallbackTimer);
        return res;
      } catch (fallbackErr) {
        clearTimeout(fallbackTimer);
        throw fallbackErr;
      }
    }
    throw err;
  }
}

const server = new McpServer({
  name: 'omlx',
  version: '1.0.0',
});

// --- Core tools (always available) ---

interface ModelStatus {
  id: string;
  model_type?: string; // "vlm" for vision models, "llm" for text-only
  loaded?: boolean;
  estimated_size?: number;
  engine_type?: string;
}

server.tool(
  'omlx_list_models',
  'List all locally available oMLX models with their type (vlm = vision+text, llm = text-only). VLM models can accept images via the image_path parameter in omlx_chat.',
  {},
  async () => {
    log('Listing models...');
    writeStatus('listing', 'Listing available models');
    try {
      const res = await omlxFetch('/v1/models/status');
      if (!res.ok) {
        // Fallback to basic /v1/models if /v1/models/status isn't available
        const basicRes = await omlxFetch('/v1/models');
        if (!basicRes.ok) {
          const errorText = await basicRes.text();
          return {
            content: [{ type: 'text' as const, text: `oMLX API error (${basicRes.status}): ${errorText}` }],
            isError: true,
          };
        }
        const basicData = await basicRes.json() as { data?: Array<{ id: string }> };
        const list = (basicData.data || []).map(m => `- ${m.id}`).join('\n');
        return { content: [{ type: 'text' as const, text: `Available models:\n${list}` }] };
      }

      const data = await res.json() as { models?: ModelStatus[] };
      const models = data.models || [];

      if (models.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No models available. Install models via the oMLX admin dashboard.' }] };
      }

      const list = models.map(m => {
        const type = m.model_type === 'vlm' ? 'vlm (vision+text)' : 'llm (text-only)';
        const status = m.loaded ? 'loaded' : 'available';
        const size = m.estimated_size ? ` ${(m.estimated_size / 1e9).toFixed(1)}GB` : '';
        return `- ${m.id} [${type}] (${status}${size})`;
      }).join('\n');

      const vlmCount = models.filter(m => m.model_type === 'vlm').length;
      log(`Found ${models.length} models (${vlmCount} VLM)`);
      return { content: [{ type: 'text' as const, text: `Available models:\n${list}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to connect to oMLX at ${OMLX_HOST}: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

function readImageAsBase64(imagePath: string): { base64: string; mimeType: string } {
  const data = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
  };
  return {
    base64: data.toString('base64'),
    mimeType: mimeMap[ext] || 'image/jpeg',
  };
}

server.tool(
  'omlx_chat',
  'Send a message to a local oMLX model and get a response. Good for cheaper/faster tasks like summarization, translation, general knowledge queries, or draft generation. For VLM models, you can include an image via image_path. Use omlx_list_models first to check which models support vision (vlm).',
  {
    model: z.string().describe('The model ID (e.g., "Qwen3.5-27B-8bit"). Use omlx_list_models to see available models.'),
    message: z.string().describe('The user message to send to the model'),
    system: z.string().optional().describe('Optional system prompt to set model behavior'),
    max_tokens: z.number().optional().describe('Maximum tokens to generate (default: 2048)'),
    image_path: z.string().optional().describe('Absolute path to an image file to send to a VLM model. Only works with models whose type is "vlm". Supported formats: png, jpg, jpeg, gif, webp.'),
  },
  async (args) => {
    const hasImage = !!args.image_path;
    log(`>>> Chatting with ${args.model} (${args.message.length} chars${hasImage ? `, image: ${args.image_path}` : ''})...`);
    writeStatus('generating', `Generating with ${args.model}${hasImage ? ' (vision)' : ''}`);
    try {
      type ChatMessage = { role: string; content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> };
      const messages: ChatMessage[] = [];
      if (args.system) {
        messages.push({ role: 'system', content: args.system });
      }

      if (args.image_path) {
        if (!fs.existsSync(args.image_path)) {
          return {
            content: [{ type: 'text' as const, text: `Image file not found: ${args.image_path}` }],
            isError: true,
          };
        }
        const { base64, mimeType } = readImageAsBase64(args.image_path);
        log(`Image loaded: ${mimeType}, ${(base64.length * 0.75 / 1024).toFixed(0)}KB`);
        messages.push({
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
            { type: 'text', text: args.message },
          ],
        });
      } else {
        messages.push({ role: 'user', content: args.message });
      }

      const body: Record<string, unknown> = {
        model: args.model,
        messages,
        max_tokens: args.max_tokens || 2048,
        stream: false,
      };

      const res = await omlxFetch('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [{ type: 'text' as const, text: `oMLX error (${res.status}): ${errorText}` }],
          isError: true,
        };
      }

      const data = await res.json() as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
        model?: string;
      };

      const responseText = data.choices?.[0]?.message?.content || '';
      const usage = data.usage;

      let meta = '';
      if (usage) {
        meta = `\n\n[${data.model || args.model}${hasImage ? ' (vision)' : ''} | ${usage.prompt_tokens}→${usage.completion_tokens} tokens]`;
        log(`<<< Done: ${data.model || args.model} | ${usage.prompt_tokens}→${usage.completion_tokens} tokens | ${responseText.length} chars`);
        writeStatus('done', `${data.model || args.model} | ${usage.completion_tokens} tokens`);
      } else {
        log(`<<< Done: ${args.model} | ${responseText.length} chars`);
        writeStatus('done', `${args.model} | ${responseText.length} chars`);
      }

      return { content: [{ type: 'text' as const, text: responseText + meta }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to call oMLX: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'omlx_server_status',
  'Check the oMLX server status: uptime, loaded models, memory usage, and performance stats.',
  {},
  async () => {
    log('Checking server status...');
    try {
      const res = await omlxFetch('/api/status');
      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [{ type: 'text' as const, text: `oMLX API error (${res.status}): ${errorText}` }],
          isError: true,
        };
      }

      const data = await res.json() as {
        status?: string;
        version?: string;
        uptime_seconds?: number;
        models_discovered?: number;
        models_loaded?: number;
        default_model?: string;
        loaded_models?: string[];
        model_memory_used_formatted?: string;
        model_memory_max_formatted?: string;
        avg_prefill_tps?: number;
        avg_generation_tps?: number;
        total_requests?: number;
      };

      const lines = [
        `oMLX Server Status`,
        `  Version: ${data.version || 'unknown'}`,
        `  Status: ${data.status || 'unknown'}`,
        `  Uptime: ${data.uptime_seconds ? (data.uptime_seconds / 3600).toFixed(1) + 'h' : 'unknown'}`,
        `  Default model: ${data.default_model || 'none'}`,
        `  Models: ${data.models_discovered || 0} available, ${data.models_loaded || 0} loaded`,
        `  Loaded: ${data.loaded_models?.join(', ') || 'none'}`,
        `  Memory: ${data.model_memory_used_formatted || '?'} / ${data.model_memory_max_formatted || '?'}`,
        `  Avg prefill: ${data.avg_prefill_tps?.toFixed(0) || '?'} tok/s`,
        `  Avg generation: ${data.avg_generation_tps?.toFixed(0) || '?'} tok/s`,
        `  Total requests: ${data.total_requests || 0}`,
      ];

      log(`Status: ${data.models_loaded} loaded, ${data.model_memory_used_formatted} memory`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to reach oMLX: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// --- Admin tools (opt-in via OMLX_ADMIN_TOOLS=true) ---

if (OMLX_ADMIN_TOOLS) {
  server.tool(
    'omlx_unload_model',
    'Unload a model from memory to free up RAM/VRAM.',
    {
      model: z.string().describe('The model ID to unload (use omlx_list_models to see loaded models)'),
    },
    async (args) => {
      log(`Unloading model: ${args.model}...`);
      writeStatus('unloading', `Unloading ${args.model}`);
      try {
        const res = await omlxFetch(`/v1/models/${encodeURIComponent(args.model)}/unload`, {
          method: 'POST',
        });
        if (!res.ok) {
          const errorText = await res.text();
          return {
            content: [{ type: 'text' as const, text: `oMLX error (${res.status}): ${errorText}` }],
            isError: true,
          };
        }
        log(`Unloaded: ${args.model}`);
        writeStatus('done', `Unloaded ${args.model}`);
        return { content: [{ type: 'text' as const, text: `Unloaded model: ${args.model}` }] };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to unload model: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  log('Admin tools enabled (unload)');
}

const transport = new StdioServerTransport();
await server.connect(transport);
