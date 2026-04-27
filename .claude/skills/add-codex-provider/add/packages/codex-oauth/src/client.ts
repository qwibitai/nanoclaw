/**
 * CodexClient - API client for the Codex Responses API
 *
 * Supports simple chat, raw responses API, and streaming.
 * Uses SSE parsing for streamed responses.
 */

import { CodexAuth } from './auth.js';
import { getBaseModelId, getReasoningEffort } from './models.js';
import type {
  CodexChatOptions,
  CodexInputItem,
  CodexOutputItem,
  CodexRequest,
  CodexResponse,
  CodexSSEEvent,
  ReasoningEffort,
} from './types.js';

const CODEX_API_URL = 'https://chatgpt.com/backend-api/codex/responses';
const DEFAULT_MODEL = 'gpt-5.3-codex';

export class CodexClient {
  private readonly auth: CodexAuth;
  private readonly defaultModel: string;

  constructor(auth: CodexAuth, options?: { model?: string }) {
    this.auth = auth;
    this.defaultModel = options?.model ?? DEFAULT_MODEL;
  }

  /**
   * Simple chat - send a message, get text back.
   */
  async chat(message: string, options?: CodexChatOptions): Promise<string> {
    const modelId = options?.model ?? this.defaultModel;
    const baseModel = getBaseModelId(modelId);
    const reasoning = options?.reasoning ?? getReasoningEffort(modelId);

    const input: CodexInputItem[] = [];
    if (options?.instructions) {
      input.push({ role: 'developer', content: options.instructions });
    }
    input.push({ role: 'user', content: message });

    const request: CodexRequest = {
      model: baseModel,
      input,
      store: false,
      stream: true,
      tools: options?.tools,
      include: options?.include,
      ...(reasoning !== 'none' && { reasoning: { effort: reasoning, summary: 'auto' } }),
    };

    const response = await this.responsesInternal(request);
    return extractText(response.output);
  }

  /**
   * Raw Responses API call. Returns the full parsed response.
   */
  async responses(request: CodexRequest): Promise<CodexResponse> {
    return this.responsesInternal({
      ...request,
      stream: request.stream ?? true,
      store: request.store ?? false,
    });
  }

  /**
   * Streaming chat - yields text deltas as an async iterable.
   */
  async *chatStream(message: string, options?: CodexChatOptions): AsyncIterable<string> {
    const modelId = options?.model ?? this.defaultModel;
    const baseModel = getBaseModelId(modelId);
    const reasoning: ReasoningEffort = options?.reasoning ?? getReasoningEffort(modelId);

    const input: CodexInputItem[] = [];
    if (options?.instructions) {
      input.push({ role: 'developer', content: options.instructions });
    }
    input.push({ role: 'user', content: message });

    const tokens = await this.auth.getTokens();

    const response = await fetch(CODEX_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.access_token}`,
        'chatgpt-account-id': tokens.account_id,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
      },
      body: JSON.stringify({
        model: baseModel,
        store: false,
        stream: true,
        input,
        tools: options?.tools,
        include: options?.include,
        ...(reasoning !== 'none' && { reasoning: { effort: reasoning, summary: 'auto' } }),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Codex API error ${response.status}: ${errorText.slice(0, 500)}`);
    }

    yield* parseSSETextDeltas(response);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async responsesInternal(request: CodexRequest): Promise<CodexResponse> {
    const tokens = await this.auth.getTokens();

    const response = await fetch(CODEX_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.access_token}`,
        'chatgpt-account-id': tokens.account_id,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Codex API error ${response.status}: ${errorText.slice(0, 500)}`);
    }

    if (request.stream !== false) {
      return parseSSEResponse(response);
    }

    return (await response.json()) as CodexResponse;
  }
}

// ---------------------------------------------------------------------------
// SSE Parsing
// ---------------------------------------------------------------------------

async function parseSSEResponse(response: Response): Promise<CodexResponse> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResponse: CodexResponse | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;

      try {
        const event = JSON.parse(data) as CodexSSEEvent;
        if (event.type === 'error') {
          throw new Error(event.error?.message || 'Codex API error');
        }
        if (event.type === 'response.done' || event.type === 'response.completed') {
          finalResponse = event.response!;
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('Codex API error')) throw err;
        // Skip malformed JSON
      }
    }
  }

  if (!finalResponse) {
    throw new Error('No response.done event received from Codex API');
  }
  return finalResponse;
}

async function* parseSSETextDeltas(response: Response): AsyncIterable<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let cumulativeText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;

      try {
        const event = JSON.parse(data) as CodexSSEEvent;
        if (event.type === 'error') {
          throw new Error(event.error?.message || 'Codex API error');
        }
        // Extract text from ongoing/done events and yield deltas
        if (event.response?.output) {
          const currentText = extractText(event.response.output);
          if (currentText.length > cumulativeText.length) {
            yield currentText.slice(cumulativeText.length);
            cumulativeText = currentText;
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('Codex API error')) throw err;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(items: CodexOutputItem[]): string {
  let text = '';
  for (const item of items) {
    if (item.type === 'message' && item.content) {
      for (const part of item.content) {
        if (part.type === 'output_text' && part.text) {
          text += part.text;
        }
      }
    }
  }
  return text;
}
