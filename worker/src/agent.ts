/**
 * ThagomizerClaw — Agent Execution Layer
 *
 * Runs Claude (via Anthropic API) or Workers AI (Llama/Mistral) to process messages.
 *
 * Architecture:
 *   1. Primary: Anthropic Claude API (claude-3-5-sonnet-latest or configured model)
 *   2. Fallback: Cloudflare Workers AI (@cf/meta/llama-3.1-8b-instruct)
 *
 * Unlike the self-hosted version's Docker containers, Workers run Claude directly
 * via the Anthropic SDK — no container isolation needed since Workers are already
 * sandboxed by the Cloudflare runtime.
 *
 * Group memory (CLAUDE.md) is loaded from R2 and injected as system context.
 */

import type { Env, AgentInput, AgentOutput } from './types.js';
import { formatMessages } from './router.js';

// Max tokens for Claude responses in Workers (cost control)
const DEFAULT_MAX_TOKENS = 4096;
const WORKER_AI_MAX_TOKENS = 2048;

// ─── Anthropic Claude API ─────────────────────────────────────────────────────

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: AnthropicMessage[];
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{ type: string; text: string }>;
  model: string;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

async function callClaudeAPI(
  apiKey: string,
  request: AnthropicRequest,
): Promise<AnthropicResponse> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${error}`);
  }

  return response.json() as Promise<AnthropicResponse>;
}

// ─── Workers AI Fallback ──────────────────────────────────────────────────────

async function callWorkersAI(
  ai: Ai,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const result = await ai.run(model as Parameters<Ai['run']>[0], {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: WORKER_AI_MAX_TOKENS,
  } as never);

  const r = result as { response?: string };
  return r.response ?? 'No response from Workers AI';
}

// ─── System Prompt Builder ────────────────────────────────────────────────────

function buildSystemPrompt(input: AgentInput): string {
  const parts: string[] = [
    `You are ${input.assistantName ?? 'Andy'}, a helpful AI assistant.`,
    `You are responding in a group chat. Be concise and helpful.`,
    `Current time: ${new Date().toISOString()}`,
  ];

  if (input.isMain) {
    parts.push(
      `You have elevated admin privileges as the main control group assistant.`,
      `You can manage groups, schedule tasks, and control the assistant system.`,
    );
  }

  if (input.claudeMd) {
    parts.push(`\n## Group Context (CLAUDE.md)\n${input.claudeMd}`);
  }

  return parts.join('\n');
}

// ─── Main Agent Runner ────────────────────────────────────────────────────────

export async function runAgent(
  input: AgentInput,
  env: Env,
): Promise<AgentOutput> {
  const startTime = Date.now();
  const systemPrompt = buildSystemPrompt(input);
  const maxTokens = input.agentConfig?.maxTokens ?? DEFAULT_MAX_TOKENS;
  const useWorkersAI = input.agentConfig?.useWorkersAI ?? false;

  // Workers AI path (cheaper/faster for simple queries)
  if (useWorkersAI) {
    try {
      const model = env.WORKER_AI_MODEL ?? '@cf/meta/llama-3.1-8b-instruct';
      const result = await callWorkersAI(env.AI, model, systemPrompt, input.prompt);
      return {
        status: 'success',
        result,
        model,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return { status: 'error', result: null, error: `Workers AI error: ${errMsg}` };
    }
  }

  // Claude API path (primary)
  try {
    const model = input.agentConfig?.model ?? 'claude-opus-4-6';

    const request: AnthropicRequest = {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: input.prompt }],
    };

    const response = await callClaudeAPI(env.ANTHROPIC_API_KEY, request);

    const text = response.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');

    return {
      status: 'success',
      result: text,
      model: response.model,
      usage: response.usage,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);

    // Fallback to Workers AI on Claude API failure
    if (env.AI) {
      try {
        const model = env.WORKER_AI_MODEL ?? '@cf/meta/llama-3.1-8b-instruct';
        const result = await callWorkersAI(env.AI, model, systemPrompt, input.prompt);
        return {
          status: 'success',
          result: `[Fallback via Workers AI]\n${result}`,
          model,
        };
      } catch {
        // Both failed
      }
    }

    return { status: 'error', result: null, error: errMsg };
  }
}

// Expose agentConfig on AgentInput (augment type)
declare module './types.js' {
  interface AgentInput {
    agentConfig?: import('./types.js').AgentConfig;
  }
}
