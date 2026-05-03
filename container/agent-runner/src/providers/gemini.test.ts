import { describe, expect, it } from 'bun:test';

import { GeminiProvider } from './gemini.js';

interface FakeHistoryEntry {
  role: 'user' | 'model';
  parts: Array<{ text?: string; functionCall?: { name: string; args: Record<string, unknown> }; functionResponse?: { name: string; response: Record<string, unknown> } }>;
}

interface FakeChunk {
  text?: string;
  functionCalls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }>;
}

interface FakeChatConfig {
  systemInstruction?: string;
  tools?: Array<{ functionDeclarations?: Array<{ name?: string; description?: string }> }>;
}

function parseContinuation(serialized: string): FakeHistoryEntry[] {
  const parsed = JSON.parse(serialized) as { version: number; history: FakeHistoryEntry[] };
  return parsed.history;
}

/**
 * Default text-only fake: every sendMessageStream call streams back
 * `Gemini says: <message>` and records both turns in history. Used by
 * the bookkeeping tests that don't care about tool calls.
 */
function makeFakeClient(
  onCreate?: (args: { model: string; history: FakeHistoryEntry[]; config?: FakeChatConfig }) => void,
) {
  return {
    chats: {
      create(args: { model: string; history?: FakeHistoryEntry[]; config?: FakeChatConfig }) {
        const history = [...(args.history ?? [])];
        onCreate?.({
          model: args.model,
          history: history.map((entry) => ({
            role: entry.role,
            parts: entry.parts.map((part) => ({ ...part })),
          })),
          config: args.config,
        });

        return {
          async sendMessageStream({ message }: { message: unknown }) {
            const text = typeof message === 'string' ? message : JSON.stringify(message);
            history.push({ role: 'user', parts: [{ text }] });
            const reply = `Gemini says: ${text}`;
            history.push({ role: 'model', parts: [{ text: reply }] });

            return {
              async *[Symbol.asyncIterator]() {
                yield { text: 'Gemini says: ' } as FakeChunk;
                yield { text } as FakeChunk;
              },
            };
          },
          getHistory() {
            return history;
          },
        };
      },
    },
  };
}

/**
 * Scriptable fake for tool-call tests: caller hands an array of
 * "rounds", each describing what `sendMessageStream` should yield on
 * the Nth invocation. Each round is `{ chunks: FakeChunk[] }`. When
 * the script runs out, subsequent rounds yield an empty stream.
 */
function makeScriptedClient(
  rounds: Array<{ chunks: FakeChunk[] }>,
  onCreate?: (args: { config?: FakeChatConfig }) => void,
  onSend?: (args: { message: unknown; roundIndex: number }) => void,
) {
  return {
    chats: {
      create(args: { config?: FakeChatConfig }) {
        onCreate?.({ config: args.config });
        let roundIndex = 0;
        return {
          async sendMessageStream({ message }: { message: unknown }) {
            const idx = roundIndex;
            roundIndex += 1;
            onSend?.({ message, roundIndex: idx });
            const round = rounds[idx] ?? { chunks: [] };
            return {
              async *[Symbol.asyncIterator]() {
                for (const chunk of round.chunks) {
                  yield chunk;
                }
              },
            };
          },
          getHistory() {
            return [];
          },
        };
      },
    },
  };
}

async function readTurn(
  iterator: AsyncIterator<unknown>,
): Promise<Array<{ type: string; [key: string]: unknown }>> {
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return events;
    const event = next.value as { type: string; [key: string]: unknown };
    events.push(event);
    if (event.type === 'result') {
      return events;
    }
  }
}

describe('GeminiProvider', () => {
  it('requires a Google API key', () => {
    expect(() => new GeminiProvider()).toThrow(/GOOGLE_GENERATIVE_AI_API_KEY|GOOGLE_AI_API_KEY/);
  });

  it('uses the configured model, system instruction, and persists history across turns', async () => {
    const createCalls: Array<{ model: string; history: FakeHistoryEntry[]; config?: FakeChatConfig }> = [];
    const provider = new GeminiProvider(
      {
        env: {
          GOOGLE_GENERATIVE_AI_API_KEY: 'test-key',
          BAGET_GEMINI_MODEL: 'gemini-2.5-flash',
        },
      },
      {
        client: makeFakeClient((args) => createCalls.push(args)),
        // Empty catalog so this turn's `config` doesn't include a `tools`
        // field — the assertion below is exact-match. Tool-call behaviour
        // has dedicated tests further down.
        toolCatalog: () => [],
      },
    );

    const query = provider.query({
      prompt: '<message from="founder">hello</message>',
      cwd: '/tmp/workspace',
      systemContext: { instructions: 'Reply as Louis.' },
    });

    const iterator = query.events[Symbol.asyncIterator]();
    const firstTurn = await readTurn(iterator);

    const firstInit = firstTurn.find((event) => event.type === 'init') as { continuation: string } | undefined;
    const firstResult = firstTurn.find((event) => event.type === 'result') as { text: string } | undefined;

    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.model).toBe('gemini-2.5-flash');
    expect(createCalls[0]?.config).toEqual({ systemInstruction: 'Reply as Louis.' });
    expect(firstResult?.text).toBe('Gemini says: <message from="founder">hello</message>');
    expect(firstInit).toBeDefined();
    expect(parseContinuation(firstInit!.continuation)).toEqual([
      { role: 'user', parts: [{ text: '<message from="founder">hello</message>' }] },
      { role: 'model', parts: [{ text: 'Gemini says: <message from="founder">hello</message>' }] },
    ]);

    query.push('<message from="founder">follow up</message>');
    const secondTurn = await readTurn(iterator);
    const secondInit = secondTurn.find((event) => event.type === 'init') as { continuation: string } | undefined;
    const secondResult = secondTurn.find((event) => event.type === 'result') as { text: string } | undefined;

    expect(secondResult?.text).toBe('Gemini says: <message from="founder">follow up</message>');
    expect(parseContinuation(secondInit!.continuation)).toEqual([
      { role: 'user', parts: [{ text: '<message from="founder">hello</message>' }] },
      { role: 'model', parts: [{ text: 'Gemini says: <message from="founder">hello</message>' }] },
      { role: 'user', parts: [{ text: '<message from="founder">follow up</message>' }] },
      { role: 'model', parts: [{ text: 'Gemini says: <message from="founder">follow up</message>' }] },
    ]);

    query.abort();
  });

  it('starts fresh when the stored continuation is malformed', async () => {
    const createCalls: Array<{ model: string; history: FakeHistoryEntry[]; config?: FakeChatConfig }> = [];
    const provider = new GeminiProvider(
      {
        env: {
          GOOGLE_AI_API_KEY: 'test-key',
        },
      },
      {
        client: makeFakeClient((args) => createCalls.push(args)),
        toolCatalog: () => [],
      },
    );

    const query = provider.query({
      prompt: '<message from="founder">fresh start</message>',
      continuation: 'not-json',
      cwd: '/tmp/workspace',
    });

    const iterator = query.events[Symbol.asyncIterator]();
    const turn = await readTurn(iterator);
    const result = turn.find((event) => event.type === 'result') as { text: string } | undefined;

    expect(result?.text).toBe('Gemini says: <message from="founder">fresh start</message>');
    const init = turn.find((event) => event.type === 'init') as { continuation: string } | undefined;
    expect(parseContinuation(init!.continuation)).toEqual([
      { role: 'user', parts: [{ text: '<message from="founder">fresh start</message>' }] },
      { role: 'model', parts: [{ text: 'Gemini says: <message from="founder">fresh start</message>' }] },
    ]);

    query.abort();
  });

  it('advertises registered tools as Gemini functionDeclarations on chat create', async () => {
    const createCalls: Array<{ config?: FakeChatConfig }> = [];
    const provider = new GeminiProvider(
      { env: { GOOGLE_AI_API_KEY: 'test-key' } },
      {
        client: makeScriptedClient([{ chunks: [{ text: 'hi' }] }], (args) => createCalls.push(args)),
        toolCatalog: () => [
          {
            tool: {
              name: 'baget_query_metrics',
              description: 'Read recent KPI values for the founder company.',
              inputSchema: {
                type: 'object',
                properties: { metric: { type: 'string' } },
                required: ['metric'],
              },
            },
            handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
          },
        ],
        resolveTool: () => undefined,
      },
    );

    const query = provider.query({ prompt: 'hi', cwd: '/tmp/workspace' });
    await readTurn(query.events[Symbol.asyncIterator]());

    expect(createCalls).toHaveLength(1);
    const tools = createCalls[0]?.config?.tools;
    expect(tools).toBeDefined();
    expect(tools).toHaveLength(1);
    const decls = tools?.[0]?.functionDeclarations;
    expect(decls).toBeDefined();
    expect(decls).toHaveLength(1);
    expect(decls?.[0]?.name).toBe('baget_query_metrics');
    expect(decls?.[0]?.description).toBe('Read recent KPI values for the founder company.');

    query.abort();
  });

  it('executes a function call, sends the result back, and surfaces the model text reply', async () => {
    const handlerCalls: Array<{ args: Record<string, unknown> }> = [];
    const sendCalls: Array<{ message: unknown; roundIndex: number }> = [];
    const provider = new GeminiProvider(
      { env: { GOOGLE_AI_API_KEY: 'test-key' } },
      {
        client: makeScriptedClient(
          [
            // Round 0: user message → model emits a function call, no text.
            {
              chunks: [
                {
                  functionCalls: [
                    {
                      id: 'call-1',
                      name: 'baget_query_metrics',
                      args: { metric: 'waitlist' },
                    },
                  ],
                },
              ],
            },
            // Round 1: function response → model emits final text reply.
            { chunks: [{ text: 'analyst: Waitlist is at 142.' }] },
          ],
          undefined,
          (args) => sendCalls.push(args),
        ),
        toolCatalog: () => [
          {
            tool: {
              name: 'baget_query_metrics',
              description: 'Read recent KPI values.',
              inputSchema: { type: 'object', properties: { metric: { type: 'string' } } },
            },
            handler: async (args) => {
              handlerCalls.push({ args });
              return { content: [{ type: 'text', text: '{"waitlist":142}' }] };
            },
          },
        ],
        resolveTool: (name) =>
          name === 'baget_query_metrics'
            ? {
                tool: {
                  name: 'baget_query_metrics',
                  description: 'Read recent KPI values.',
                  inputSchema: { type: 'object' },
                },
                handler: async (args) => {
                  handlerCalls.push({ args });
                  return { content: [{ type: 'text', text: '{"waitlist":142}' }] };
                },
              }
            : undefined,
      },
    );

    const query = provider.query({ prompt: 'where is the waitlist at?', cwd: '/tmp/workspace' });
    const events = await readTurn(query.events[Symbol.asyncIterator]());

    expect(handlerCalls).toEqual([{ args: { metric: 'waitlist' } }]);
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[0]?.message).toBe('where is the waitlist at?');
    expect(Array.isArray(sendCalls[1]?.message)).toBe(true);
    const responseParts = sendCalls[1]?.message as Array<{ functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> } }>;
    expect(responseParts[0]?.functionResponse?.name).toBe('baget_query_metrics');
    expect(responseParts[0]?.functionResponse?.id).toBe('call-1');
    expect(responseParts[0]?.functionResponse?.response).toEqual({ output: '{"waitlist":142}' });

    const result = events.find((e) => e.type === 'result') as { text: string } | undefined;
    expect(result?.text).toBe('analyst: Waitlist is at 142.');

    query.abort();
  });

  it('returns a Gemini-visible error response when the requested tool is not registered', async () => {
    const sendCalls: Array<{ message: unknown; roundIndex: number }> = [];
    const provider = new GeminiProvider(
      { env: { GOOGLE_AI_API_KEY: 'test-key' } },
      {
        client: makeScriptedClient(
          [
            // Round 0: model calls a tool that the catalog does not know about.
            {
              chunks: [
                {
                  functionCalls: [{ id: 'call-x', name: 'nonexistent_tool', args: {} }],
                },
              ],
            },
            // Round 1: model receives the error and emits text.
            { chunks: [{ text: 'cos: Sorry, that tool is unavailable.' }] },
          ],
          undefined,
          (args) => sendCalls.push(args),
        ),
        toolCatalog: () => [],
        resolveTool: () => undefined,
      },
    );

    const query = provider.query({ prompt: 'do the thing', cwd: '/tmp/workspace' });
    const events = await readTurn(query.events[Symbol.asyncIterator]());

    const responseParts = sendCalls[1]?.message as Array<{ functionResponse?: { name?: string; response?: Record<string, unknown> } }>;
    expect(responseParts[0]?.functionResponse?.name).toBe('nonexistent_tool');
    expect(responseParts[0]?.functionResponse?.response).toEqual({
      error: 'Unknown tool: nonexistent_tool',
    });
    const result = events.find((e) => e.type === 'result') as { text: string } | undefined;
    expect(result?.text).toBe('cos: Sorry, that tool is unavailable.');

    query.abort();
  });

  it('reports tool isError as a structured error response, not a text payload', async () => {
    const sendCalls: Array<{ message: unknown; roundIndex: number }> = [];
    const provider = new GeminiProvider(
      { env: { GOOGLE_AI_API_KEY: 'test-key' } },
      {
        client: makeScriptedClient(
          [
            { chunks: [{ functionCalls: [{ id: 'c1', name: 'baget_set_direction', args: {} }] }] },
            { chunks: [{ text: 'cos: Could not save direction.' }] },
          ],
          undefined,
          (args) => sendCalls.push(args),
        ),
        toolCatalog: () => [],
        resolveTool: () => ({
          tool: {
            name: 'baget_set_direction',
            description: 'Save direction.',
            inputSchema: { type: 'object' },
          },
          handler: async () => ({
            content: [{ type: 'text', text: 'Validation failed: direction is required' }],
            isError: true,
          }),
        }),
      },
    );

    const query = provider.query({ prompt: 'set direction to enterprise', cwd: '/tmp/workspace' });
    await readTurn(query.events[Symbol.asyncIterator]());

    const responseParts = sendCalls[1]?.message as Array<{ functionResponse?: { response?: Record<string, unknown> } }>;
    expect(responseParts[0]?.functionResponse?.response).toEqual({
      error: 'Validation failed: direction is required',
    });

    query.abort();
  });
});
