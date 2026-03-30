/**
 * OpenAI-compatible API client
 * Supports LM Studio, Ollama, and any OpenAI-compatible endpoint
 */

import type { LLMProviderConfig } from './llm-router.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
  stream?: boolean;
}

export interface StreamChunk {
  type: 'text' | 'done';
  text?: string;
  finishReason?: string;
}

/**
 * Creates an OpenAI-compatible API client
 */
export class OpenAIClient {
  private baseUrl: string;
  private model: string;
  private apiKey?: string;

  constructor(config: LLMProviderConfig) {
    if (!config.baseUrl) {
      throw new Error('baseUrl is required for OpenAI-compatible client');
    }
    if (!config.model) {
      throw new Error('model is required for OpenAI-compatible client');
    }

    this.baseUrl = config.baseUrl.replace(/\/$/, ''); // Remove trailing slash
    this.model = config.model;
    this.apiKey = config.apiKey;
  }

  /**
   * Stream completion from OpenAI-compatible API
   */
  async *streamCompletion(
    messages: ChatMessage[],
    options: CompletionOptions = {},
  ): AsyncGenerator<StreamChunk> {
    const url = `${this.baseUrl}/chat/completions`;

    const requestBody = {
      model: this.model,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens,
      stop: options.stopSequences,
      stream: true,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      throw new Error(`Failed to connect to ${url}: ${error}`);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(`API error ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error('No response body from API');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;

          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            try {
              const parsed = JSON.parse(jsonStr);
              const delta = parsed.choices?.[0]?.delta;
              const finishReason = parsed.choices?.[0]?.finish_reason;

              if (delta?.content) {
                yield { type: 'text', text: delta.content };
              }

              if (finishReason) {
                yield { type: 'done', finishReason };
                return;
              }
            } catch (e) {
              // Skip malformed JSON chunks
              console.error('Failed to parse SSE chunk:', jsonStr);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'done', finishReason: 'stop' };
  }

  /**
   * Non-streaming completion (for simple use cases)
   */
  async complete(
    messages: ChatMessage[],
    options: CompletionOptions = {},
  ): Promise<string> {
    let result = '';
    for await (const chunk of this.streamCompletion(messages, options)) {
      if (chunk.type === 'text' && chunk.text) {
        result += chunk.text;
      }
    }
    return result;
  }
}

/**
 * Format a message for OpenAI API
 */
export function formatMessage(role: 'system' | 'user' | 'assistant', content: string): ChatMessage {
  return { role, content };
}
