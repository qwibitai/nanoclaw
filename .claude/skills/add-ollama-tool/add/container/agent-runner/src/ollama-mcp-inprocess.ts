/**
 * In-process Ollama MCP server for NanoClaw.
 * Exposes local Ollama models as tools and sends status notifications via JSON-RPC.
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { JsonRpcTransport } from './jsonrpc-transport.js';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';

async function ollamaFetch(path: string, options?: RequestInit): Promise<Response> {
  const url = `${OLLAMA_HOST}${path}`;
  try {
    return await fetch(url, options);
  } catch (err) {
    // Fallback to localhost if host.docker.internal fails
    if (OLLAMA_HOST.includes('host.docker.internal')) {
      const fallbackUrl = url.replace('host.docker.internal', 'localhost');
      return await fetch(fallbackUrl, options);
    }
    throw err;
  }
}

export function createOllamaMcpServer(transport: JsonRpcTransport) {
  return createSdkMcpServer({
    name: 'ollama',
    version: '1.0.0',
    tools: [
      tool(
        'ollama_list_models',
        'List all locally installed Ollama models. Use this to see which models are available before calling ollama_generate.',
        {},
        async () => {
          transport.sendNotification('ollama_status', {
            status: 'listing',
            detail: 'Listing models...',
          });
          try {
            const res = await ollamaFetch('/api/tags');
            if (!res.ok) {
              return {
                content: [{ type: 'text' as const, text: `Ollama API error: ${res.status} ${res.statusText}` }],
                isError: true,
              };
            }

            const data = await res.json() as { models?: Array<{ name: string; size: number; modified_at: string }> };
            const models = data.models || [];

            if (models.length === 0) {
              return { content: [{ type: 'text' as const, text: 'No models installed. Run `ollama pull <model>` on the host to install one.' }] };
            }

            const list = models
              .map(m => `- ${m.name} (${(m.size / 1e9).toFixed(1)}GB)`)
              .join('\n');

            return { content: [{ type: 'text' as const, text: `Installed models:\n${list}` }] };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Failed to connect to Ollama at ${OLLAMA_HOST}: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        },
      ),

      tool(
        'ollama_generate',
        'Send a prompt to a local Ollama model and get a response. Good for cheaper/faster tasks like summarization, translation, or general queries. Use ollama_list_models first to see available models.',
        {
          model: z.string().describe('The model name (e.g., "llama3.2", "mistral", "gemma2")'),
          prompt: z.string().describe('The prompt to send to the model'),
          system: z.string().optional().describe('Optional system prompt to set model behavior'),
        },
        async (args) => {
          transport.sendNotification('ollama_status', {
            status: 'generating',
            detail: `Generating with ${args.model} (${args.prompt.length} chars)...`,
            model: args.model,
          });
          try {
            const body: Record<string, unknown> = {
              model: args.model,
              prompt: args.prompt,
              stream: false,
            };
            if (args.system) {
              body.system = args.system;
            }

            const res = await ollamaFetch('/api/generate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });

            if (!res.ok) {
              const errorText = await res.text();
              return {
                content: [{ type: 'text' as const, text: `Ollama error (${res.status}): ${errorText}` }],
                isError: true,
              };
            }

            const data = await res.json() as { response: string; total_duration?: number; eval_count?: number };

            let meta = '';
            if (data.total_duration) {
              const secs = (data.total_duration / 1e9).toFixed(1);
              meta = `\n\n[${args.model} | ${secs}s${data.eval_count ? ` | ${data.eval_count} tokens` : ''}]`;
              transport.sendNotification('ollama_status', {
                status: 'done',
                detail: `${args.model} | ${secs}s | ${data.eval_count || '?'} tokens | ${data.response.length} chars`,
                model: args.model,
                duration: data.total_duration,
                tokens: data.eval_count,
              });
            } else {
              transport.sendNotification('ollama_status', {
                status: 'done',
                detail: `${args.model} | ${data.response.length} chars`,
                model: args.model,
              });
            }

            return { content: [{ type: 'text' as const, text: data.response + meta }] };
          } catch (err) {
            return {
              content: [{ type: 'text' as const, text: `Failed to call Ollama: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
