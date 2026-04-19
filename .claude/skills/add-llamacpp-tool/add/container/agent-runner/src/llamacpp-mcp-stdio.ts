/**
 * llama.cpp MCP Server for NanoClaw
 * Exposes a local llama-server instance as tools for the container agent.
 * Uses host.docker.internal to reach the host's llama-server from Docker.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import fs from 'fs';
import path from 'path';

const LLAMACPP_HOST = process.env.LLAMACPP_HOST || 'http://host.docker.internal:8080';
const LLAMACPP_STATUS_FILE = '/workspace/ipc/llamacpp_status.json';

function log(msg: string): void {
  console.error(`[LLAMACPP] ${msg}`);
}

function writeStatus(status: string, detail?: string): void {
  try {
    const data = { status, detail, timestamp: new Date().toISOString() };
    const tmpPath = `${LLAMACPP_STATUS_FILE}.tmp`;
    fs.mkdirSync(path.dirname(LLAMACPP_STATUS_FILE), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, LLAMACPP_STATUS_FILE);
  } catch { /* best-effort */ }
}

async function llamacppFetch(urlPath: string, options?: RequestInit): Promise<Response> {
  const url = `${LLAMACPP_HOST}${urlPath}`;
  try {
    return await fetch(url, options);
  } catch (err) {
    // Fallback to localhost if host.docker.internal fails
    if (LLAMACPP_HOST.includes('host.docker.internal')) {
      const fallbackUrl = url.replace('host.docker.internal', 'localhost');
      return await fetch(fallbackUrl, options);
    }
    throw err;
  }
}

const server = new McpServer({
  name: 'llamacpp',
  version: '1.0.0',
});

server.tool(
  'llamacpp_list_models',
  'List the model currently loaded in llama-server. Use this to see what model is available before calling llamacpp_generate.',
  {},
  async () => {
    log('Listing models...');
    writeStatus('listing', 'Listing loaded model');
    try {
      const res = await llamacppFetch('/v1/models');
      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `llama-server API error: ${res.status} ${res.statusText}` }],
          isError: true,
        };
      }

      const data = await res.json() as { data?: Array<{ id: string }> };
      const models = data.data || [];

      if (models.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No model loaded. Start llama-server with a model: llama-server -m model.gguf' }] };
      }

      const list = models
        .map(m => `- ${m.id}`)
        .join('\n');

      log(`Found ${models.length} model(s)`);
      return { content: [{ type: 'text' as const, text: `Loaded model(s):\n${list}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to connect to llama-server at ${LLAMACPP_HOST}: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'llamacpp_generate',
  'Send a prompt to the local llama-server and get a response. Good for cheaper/faster tasks like summarization, translation, or general queries. The model is whatever was loaded when llama-server started.',
  {
    prompt: z.string().describe('The prompt to send to the model'),
    n_predict: z.number().optional().describe('Maximum number of tokens to generate (default: 512)'),
    temperature: z.number().optional().describe('Sampling temperature (default: 0.8)'),
    stop: z.array(z.string()).optional().describe('Stop sequences to end generation'),
  },
  async (args) => {
    log(`>>> Generating (${args.prompt.length} chars)...`);
    writeStatus('generating', 'Generating completion');
    try {
      const body: Record<string, unknown> = {
        prompt: args.prompt,
        n_predict: args.n_predict ?? 512,
        temperature: args.temperature ?? 0.8,
        stream: false,
      };
      if (args.stop) {
        body.stop = args.stop;
      }

      const res = await llamacppFetch('/completion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errorText = await res.text();
        return {
          content: [{ type: 'text' as const, text: `llama-server error (${res.status}): ${errorText}` }],
          isError: true,
        };
      }

      const data = await res.json() as {
        content: string;
        timings?: { predicted_per_second?: number };
        tokens_predicted?: number;
        model?: string;
      };

      let meta = '';
      const model = data.model || 'unknown';
      if (data.timings?.predicted_per_second) {
        const tps = data.timings.predicted_per_second.toFixed(1);
        const tokens = data.tokens_predicted || '?';
        meta = `\n\n[${model} | ${tps} t/s | ${tokens} tokens]`;
        log(`<<< Done: ${model} | ${tps} t/s | ${tokens} tokens | ${data.content.length} chars`);
        writeStatus('done', `${model} | ${tps} t/s | ${tokens} tokens`);
      } else {
        log(`<<< Done: ${model} | ${data.content.length} chars`);
        writeStatus('done', `${model} | ${data.content.length} chars`);
      }

      return { content: [{ type: 'text' as const, text: data.content + meta }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to call llama-server: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
