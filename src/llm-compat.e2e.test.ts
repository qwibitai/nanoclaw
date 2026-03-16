import { describe, it, expect, beforeAll } from 'vitest';

/**
 * LM Studio Compatibility Smoke Test
 *
 * Validates that the configured LLM endpoint (LM Studio or compatible)
 * supports the API behaviors NanoClaw/OpenCode relies on.
 *
 * Environment Variables:
 * - NANOCLAW_LLM_BASE_URL: Base URL for the LLM API (e.g., http://192.168.0.60:1234/v1)
 * - NANOCLAW_LLM_MODEL_ID: Optional model ID to use (defaults to first available model)
 * - NANOCLAW_LLM_API_KEY: Optional API key for authentication
 *
 * These tests are skipped if NANOCLAW_LLM_BASE_URL is not set.
 */

const BASE_URL = process.env.NANOCLAW_LLM_BASE_URL;
const MODEL_ID = process.env.NANOCLAW_LLM_MODEL_ID;
const API_KEY = process.env.NANOCLAW_LLM_API_KEY;

const runTests = !!BASE_URL;

interface ModelResponse {
  data: Array<{ id: string; object: string }>;
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: string;
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
  }>;
}

describe('LM Studio Compatibility', () => {
  let modelId: string;
  let headers: Record<string, string>;

  beforeAll(async () => {
    if (!runTests) {
      return;
    }

    headers = {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    };

    if (!MODEL_ID) {
      const modelsResponse = await fetch(`${BASE_URL}/models`, { headers });
      if (modelsResponse.ok) {
        const models = (await modelsResponse.json()) as ModelResponse;
        if (models.data?.length > 0) {
          modelId = models.data[0].id;
        } else {
          throw new Error('No models available on the LLM server');
        }
      } else {
        throw new Error(
          `Failed to fetch models: ${modelsResponse.status} ${modelsResponse.statusText}`,
        );
      }
    } else {
      modelId = MODEL_ID;
    }
  }, 30000);

  describe('GET /v1/models', () => {
    it.skipIf(!runTests)(
      'returns list of available models',
      async () => {
        const response = await fetch(`${BASE_URL}/models`, { headers });

        expect(response.status).toBe(200);

        const data = (await response.json()) as ModelResponse;
        expect(data).toHaveProperty('data');
        expect(Array.isArray(data.data)).toBe(true);
        expect(data.data.length).toBeGreaterThan(0);

        const model = data.data[0];
        expect(model).toHaveProperty('id');
        expect(model).toHaveProperty('object');
        expect(typeof model.id).toBe('string');
      },
      30000,
    );
  });

  describe('POST /v1/chat/completions (non-streaming)', () => {
    it.skipIf(!runTests)(
      'returns assistant content',
      async () => {
        const response = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: modelId,
            messages: [{ role: 'user', content: 'Say hello in one word' }],
            temperature: 0.1,
            max_tokens: 50,
          }),
        });

        expect(response.status).toBe(200);

        const data = (await response.json()) as ChatCompletionResponse;
        expect(data).toHaveProperty('choices');
        expect(Array.isArray(data.choices)).toBe(true);
        expect(data.choices.length).toBeGreaterThan(0);
        expect(data.choices[0]).toHaveProperty('message');
        expect(data.choices[0].message).toHaveProperty('content');
        expect(typeof data.choices[0].message.content).toBe('string');
        expect(data.choices[0].message.content!.length).toBeGreaterThan(0);
      },
      60000,
    );
  });

  describe('POST /v1/chat/completions with tools', () => {
    it.skipIf(!runTests)(
      'receives tool_calls when model supports tools',
      async () => {
        const tools = [
          {
            type: 'function',
            function: {
              name: 'get_current_time',
              description: 'Get the current time',
              parameters: {
                type: 'object',
                properties: {},
                required: [],
              },
            },
          },
        ];

        const response = await fetch(`${BASE_URL}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: modelId,
            messages: [
              {
                role: 'user',
                content: 'What time is it? Use the get_current_time function.',
              },
            ],
            tools,
            temperature: 0.1,
            max_tokens: 100,
          }),
        });

        expect(response.status).toBe(200);

        const data = (await response.json()) as ChatCompletionResponse;
        expect(data).toHaveProperty('choices');
        expect(Array.isArray(data.choices)).toBe(true);
        expect(data.choices.length).toBeGreaterThan(0);
        expect(data.choices[0]).toHaveProperty('message');

        const message = data.choices[0].message;
        if (message.tool_calls) {
          expect(Array.isArray(message.tool_calls)).toBe(true);
          expect(message.tool_calls.length).toBeGreaterThan(0);
          expect(message.tool_calls[0]).toHaveProperty('id');
          expect(message.tool_calls[0]).toHaveProperty('type');
          expect(message.tool_calls[0]).toHaveProperty('function');
          expect(message.tool_calls[0].function).toHaveProperty('name');
          expect(message.tool_calls[0].function).toHaveProperty('arguments');
        } else {
          expect(message).toHaveProperty('content');
        }
      },
      60000,
    );
  });

  describe('Streaming compatibility', () => {
    it.skipIf(!runTests)(
      'supports at least one streaming method',
      async () => {
        const responsesWorked = await tryResponsesStreaming();

        if (responsesWorked) {
          console.log('✓ Streaming via /v1/responses works');
          return;
        }

        console.log(
          '⚠ /v1/responses streaming failed, trying /v1/chat/completions...',
        );

        const chatCompletionsWorked = await tryChatCompletionsStreaming();

        if (chatCompletionsWorked) {
          console.log('✓ Streaming via /v1/chat/completions works');
          return;
        }

        throw new Error(
          'Neither /v1/responses nor /v1/chat/completions streaming works. ' +
            'At least one streaming method must be supported.',
        );
      },
      120000,
    );
  });

  async function tryResponsesStreaming(): Promise<boolean> {
    try {
      const response = await fetch(`${BASE_URL}/responses`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelId,
          input: 'Say hello',
          stream: true,
        }),
      });

      if (!response.ok) {
        return false;
      }

      if (!response.body) {
        return false;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let foundCompletedEvent = false;
      let foundOutputDelta = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;

            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') continue;

            try {
              const event = JSON.parse(data) as { type: string };

              if (event.type === 'response.completed') {
                foundCompletedEvent = true;
              }

              if (event.type === 'response.output_text.delta') {
                foundOutputDelta = true;
              }
            } catch {
              // Invalid JSON, skip
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      return foundCompletedEvent || foundOutputDelta;
    } catch (error) {
      console.log('Responses streaming error:', error);
      return false;
    }
  }

  async function tryChatCompletionsStreaming(): Promise<boolean> {
    try {
      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: 'Say hello' }],
          stream: true,
          temperature: 0.1,
          max_tokens: 50,
        }),
      });

      if (!response.ok) {
        return false;
      }

      if (!response.body) {
        return false;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let foundDelta = false;
      let foundFinishReason = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;

            const data = trimmed.slice(5).trim();
            if (data === '[DONE]') {
              foundFinishReason = true;
              continue;
            }

            try {
              const event = JSON.parse(data) as {
                choices?: Array<{
                  delta?: { content?: string };
                  finish_reason?: string;
                }>;
              };

              if (event.choices?.[0]?.delta?.content) {
                foundDelta = true;
              }

              if (event.choices?.[0]?.finish_reason) {
                foundFinishReason = true;
              }
            } catch {
              // Invalid JSON, skip
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      return foundDelta || foundFinishReason;
    } catch (error) {
      console.log('Chat completions streaming error:', error);
      return false;
    }
  }
});

if (!runTests) {
  console.log(
    'ℹ LM Studio compatibility tests skipped: NANOCLAW_LLM_BASE_URL not set',
  );
}
