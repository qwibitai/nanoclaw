import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, mock, afterEach } from 'bun:test';

// Prevent MCP SDK from spawning real child processes in provider-level tests.
// Bun hoists mock.module() above all imports, so openai.js sees the mocks.
mock.module('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect() { return Promise.resolve(); }
    listTools() { return Promise.resolve({ tools: [] }); }
    close() { return Promise.resolve(); }
  },
}));
mock.module('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {},
}));

import {
  resolveOpenAIChatCompletionsUrl,
  resolveOpenAIRequestTimeoutMs,
  resolveOpenAIStreamEnabled,
  resolveClaudeImports,
  OpenAIHttpError,
  ProviderRuntimeError,
  toProviderError,
  parseToolArguments,
  createOpenAIToolName,
  truncateToolResult,
  normalizeToolParameters,
  parseOpenAIChatResponse,
  parseRetryAfterSeconds,
  shouldRetryOpenAIError,
  getOpenAIRetryDelayMs,
  sleepOpenAIRetryDelay,
  parseOpenAISseDataLine,
  parseOpenAIStreamingChunk,
  createOpenAIStreamingAccumulator,
  applyOpenAIStreamingChunk,
  assembleOpenAIStreamingResponse,
  OpenAIProvider,
} from './openai.js';

describe('resolveOpenAIChatCompletionsUrl', () => {
  it('returns default URL when no baseUrl', () => {
    expect(resolveOpenAIChatCompletionsUrl()).toBe('https://api.openai.com/v1/chat/completions');
    expect(resolveOpenAIChatCompletionsUrl(undefined)).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('uses as-is when ending with /chat/completions', () => {
    expect(resolveOpenAIChatCompletionsUrl('https://custom.api/v1/chat/completions'))
      .toBe('https://custom.api/v1/chat/completions');
  });

  it('appends /chat/completions when ending with /v1', () => {
    expect(resolveOpenAIChatCompletionsUrl('https://custom.api/v1'))
      .toBe('https://custom.api/v1/chat/completions');
  });

  it('appends /v1/chat/completions for bare base URL', () => {
    expect(resolveOpenAIChatCompletionsUrl('https://custom.api'))
      .toBe('https://custom.api/v1/chat/completions');
  });

  it('trims whitespace from baseUrl', () => {
    expect(resolveOpenAIChatCompletionsUrl('  https://custom.api/v1  '))
      .toBe('https://custom.api/v1/chat/completions');
  });
});

describe('resolveOpenAIRequestTimeoutMs', () => {
  it('returns 120000 for undefined', () => {
    expect(resolveOpenAIRequestTimeoutMs()).toBe(120000);
    expect(resolveOpenAIRequestTimeoutMs(undefined)).toBe(120000);
  });

  it('returns 120000 for empty string', () => {
    expect(resolveOpenAIRequestTimeoutMs('')).toBe(120000);
    expect(resolveOpenAIRequestTimeoutMs('   ')).toBe(120000);
  });

  it('parses valid integer', () => {
    expect(resolveOpenAIRequestTimeoutMs('30000')).toBe(30000);
    expect(resolveOpenAIRequestTimeoutMs(' 60000 ')).toBe(60000);
  });

  it('returns default for invalid non-numeric strings', () => {
    expect(resolveOpenAIRequestTimeoutMs('abc')).toBe(120000);
    expect(resolveOpenAIRequestTimeoutMs('12.5')).toBe(120000);
    expect(resolveOpenAIRequestTimeoutMs('-100')).toBe(120000);
    expect(resolveOpenAIRequestTimeoutMs('0')).toBe(120000);
  });
});

describe('resolveOpenAIStreamEnabled', () => {
  it('returns true when undefined', () => {
    expect(resolveOpenAIStreamEnabled()).toBe(true);
    expect(resolveOpenAIStreamEnabled(undefined)).toBe(true);
  });

  it('returns false for "false", "0", "no"', () => {
    expect(resolveOpenAIStreamEnabled('false')).toBe(false);
    expect(resolveOpenAIStreamEnabled('FALSE')).toBe(false);
    expect(resolveOpenAIStreamEnabled('0')).toBe(false);
    expect(resolveOpenAIStreamEnabled('no')).toBe(false);
    expect(resolveOpenAIStreamEnabled('NO')).toBe(false);
  });

  it('returns true for other truthy values', () => {
    expect(resolveOpenAIStreamEnabled('true')).toBe(true);
    expect(resolveOpenAIStreamEnabled('1')).toBe(true);
    expect(resolveOpenAIStreamEnabled('yes')).toBe(true);
  });
});

describe('resolveClaudeImports (openai)', () => {
  function scratchDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'openai-imports-'));
  }

  it('inlines a single relative import', () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, 'frag.md'), 'FRAG CONTENT');
    const result = resolveClaudeImports('before\n@./frag.md\nafter', dir);
    expect(result).toContain('FRAG CONTENT');
    expect(result).not.toContain('@./frag.md');
  });

  it('expands nested imports relative to parent directory', () => {
    const dir = scratchDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'inner.md'), 'INNER');
    fs.writeFileSync(path.join(dir, 'sub', 'outer.md'), '@./inner.md');
    const result = resolveClaudeImports('@./sub/outer.md', dir);
    expect(result).toBe('INNER');
  });

  it('drops missing imports silently', () => {
    const dir = scratchDir();
    const result = resolveClaudeImports('A\n@./no-such-file.md\nB', dir);
    expect(result).not.toContain('@./no-such-file.md');
    expect(result).toContain('A');
    expect(result).toContain('B');
  });

  it('breaks circular imports without stack overflow', () => {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, 'a.md'), '@./b.md');
    fs.writeFileSync(path.join(dir, 'b.md'), '@./a.md');
    const result = resolveClaudeImports('@./a.md', dir);
    expect(typeof result).toBe('string');
  });
});

describe('toProviderError', () => {
  it('classifies 401 as auth/non-retryable', () => {
    const err = new OpenAIHttpError(401, 'unauthorized');
    const evt = toProviderError(err);
    expect(evt).toEqual({ type: 'error', message: 'unauthorized', retryable: false, classification: 'auth' });
  });

  it('classifies 403 as auth/non-retryable', () => {
    const err = new OpenAIHttpError(403, 'forbidden');
    const evt = toProviderError(err);
    expect(evt).toEqual({ type: 'error', message: 'forbidden', retryable: false, classification: 'auth' });
  });

  it('classifies 429 as retryable', () => {
    const err = new OpenAIHttpError(429, 'rate limited');
    const evt = toProviderError(err);
    expect(evt).toEqual({ type: 'error', message: 'rate limited', retryable: true });
  });

  it('classifies 500 as retryable', () => {
    const err = new OpenAIHttpError(500, 'server error');
    const evt = toProviderError(err);
    expect(evt).toEqual({ type: 'error', message: 'server error', retryable: true });
  });

  it('classifies 400 as non-retryable', () => {
    const err = new OpenAIHttpError(400, 'bad request');
    const evt = toProviderError(err);
    expect(evt).toEqual({ type: 'error', message: 'bad request', retryable: false });
  });

  it('classifies AbortError as retryable', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const evt = toProviderError(err);
    expect(evt).toEqual({ type: 'error', message: 'aborted', retryable: true });
  });

  it('classifies TypeError as retryable', () => {
    const evt = toProviderError(new TypeError('network fetch failed'));
    expect(evt).toEqual({ type: 'error', message: 'network fetch failed', retryable: true });
  });

  it('passes through ProviderRuntimeError', () => {
    const err = new ProviderRuntimeError('custom', true, 'custom-class');
    const evt = toProviderError(err);
    expect(evt).toEqual({ type: 'error', message: 'custom', retryable: true, classification: 'custom-class' });
  });

  it('classifies unknown error as non-retryable', () => {
    const evt = toProviderError('some string error');
    expect(evt).toEqual({ type: 'error', message: 'some string error', retryable: false });
  });
});

describe('parseToolArguments', () => {
  it('parses valid JSON object', () => {
    const result = parseToolArguments('{"key":"value"}');
    expect(result).toEqual({ ok: true, value: { key: 'value' } });
  });

  it('returns empty object for empty string', () => {
    expect(parseToolArguments('')).toEqual({ ok: true, value: {} });
    expect(parseToolArguments('  ')).toEqual({ ok: true, value: {} });
  });

  it('returns error for invalid JSON', () => {
    const result = parseToolArguments('{invalid}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('invalid JSON');
    }
  });

  it('returns error for non-object JSON (array)', () => {
    const result = parseToolArguments('[1,2,3]');
    expect(result).toEqual({ ok: false, error: 'Error: tool arguments must be a JSON object' });
  });

  it('returns error for non-object JSON (string)', () => {
    const result = parseToolArguments('"hello"');
    expect(result).toEqual({ ok: false, error: 'Error: tool arguments must be a JSON object' });
  });
});

describe('createOpenAIToolName', () => {
  it('sanitizes special characters', () => {
    const used = new Set<string>();
    expect(createOpenAIToolName('my.tool/name', used)).toBe('my_tool_name');
  });

  it('collapses multiple underscores from __', () => {
    const used = new Set<string>();
    expect(createOpenAIToolName('my__tool', used)).toBe('my_tool');
  });

  it('adds suffix for duplicates', () => {
    const used = new Set<string>();
    const first = createOpenAIToolName('tool', used);
    const second = createOpenAIToolName('tool', used);
    expect(first).toBe('tool');
    expect(second).toBe('tool_2');
    expect(used.has('tool')).toBe(true);
    expect(used.has('tool_2')).toBe(true);
  });

  it('enforces 64-char limit', () => {
    const used = new Set<string>();
    const longName = 'a'.repeat(100);
    const result = createOpenAIToolName(longName, used);
    expect(result.length).toBeLessThanOrEqual(64);
  });

  it('handles empty name', () => {
    const used = new Set<string>();
    const result = createOpenAIToolName('', used);
    expect(result).toBe('tool');
  });

  it('allows hyphens and underscores', () => {
    const used = new Set<string>();
    expect(createOpenAIToolName('my-tool_name', used)).toBe('my-tool_name');
  });
});

describe('truncateToolResult', () => {
  it('returns text unchanged when under limit', () => {
    const text = 'short result';
    expect(truncateToolResult(text)).toBe(text);
  });

  it('truncates and adds marker when over limit', () => {
    const limit = 50 * 1024;
    const text = 'x'.repeat(limit + 1000);
    const result = truncateToolResult(text);
    expect(result.length).toBeLessThan(text.length);
    expect(result).toContain('[truncated 1000 characters from MCP tool result]');
    expect(result.startsWith('x'.repeat(limit))).toBe(true);
  });

  it('returns text at exactly limit unchanged', () => {
    const limit = 50 * 1024;
    const text = 'x'.repeat(limit);
    expect(truncateToolResult(text)).toBe(text);
  });
});

describe('normalizeToolParameters', () => {
  it('adds type:object and properties when missing', () => {
    const result = normalizeToolParameters(undefined);
    expect(result).toEqual({ type: 'object', properties: {} });
  });

  it('adds type:object when schema has properties but no type', () => {
    const result = normalizeToolParameters({ properties: { foo: { type: 'string' } } } as any);
    expect(result.type).toBe('object');
    expect(result.properties).toEqual({ foo: { type: 'string' } });
  });

  it('preserves existing object schema', () => {
    const schema = { type: 'object', properties: { bar: { type: 'number' } }, required: ['bar'] };
    const result = normalizeToolParameters(schema as any);
    expect(result.type).toBe('object');
    expect(result.properties).toEqual({ bar: { type: 'number' } });
    expect(result.required).toEqual(['bar']);
  });

  it('handles empty object schema', () => {
    const result = normalizeToolParameters({} as any);
    expect(result.type).toBe('object');
    expect(result.properties).toEqual({});
  });
});

describe('parseOpenAIChatResponse', () => {
  it('parses a minimal valid response', () => {
    const payload = {
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'Hello' },
      }],
    };
    const result = parseOpenAIChatResponse(payload);
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].message.content).toBe('Hello');
    expect(result.choices[0].finish_reason).toBe('stop');
  });

  it('throws when choices missing', () => {
    expect(() => parseOpenAIChatResponse({})).toThrow('did not include choices');
  });

  it('parses response with tool_calls', () => {
    const payload = {
      choices: [{
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'my_tool', arguments: '{"a":1}' },
          }],
        },
      }],
    };
    const result = parseOpenAIChatResponse(payload);
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    expect(result.choices[0].message.tool_calls![0].function.name).toBe('my_tool');
  });
});

describe('shouldRetryOpenAIError', () => {
  it('retries 429', () => {
    expect(shouldRetryOpenAIError(new OpenAIHttpError(429, 'rate limited'))).toBe(true);
  });

  it('retries 500-599', () => {
    expect(shouldRetryOpenAIError(new OpenAIHttpError(500, 'server error'))).toBe(true);
    expect(shouldRetryOpenAIError(new OpenAIHttpError(503, 'unavailable'))).toBe(true);
  });

  it('does not retry 400', () => {
    expect(shouldRetryOpenAIError(new OpenAIHttpError(400, 'bad request'))).toBe(false);
  });

  it('does not retry 401', () => {
    expect(shouldRetryOpenAIError(new OpenAIHttpError(401, 'unauthorized'))).toBe(false);
  });

  it('retries AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(shouldRetryOpenAIError(err)).toBe(true);
  });

  it('retries TypeError (network)', () => {
    expect(shouldRetryOpenAIError(new TypeError('fetch failed'))).toBe(true);
  });

  it('respects ProviderRuntimeError.retryable', () => {
    expect(shouldRetryOpenAIError(new ProviderRuntimeError('err', true))).toBe(true);
    expect(shouldRetryOpenAIError(new ProviderRuntimeError('err', false))).toBe(false);
  });
});

describe('parseRetryAfterSeconds', () => {
  it('parses numeric retry-after header', () => {
    const headers = new Headers({ 'retry-after': '5' });
    expect(parseRetryAfterSeconds(headers)).toBe(5);
  });

  it('returns undefined when header missing', () => {
    expect(parseRetryAfterSeconds(new Headers())).toBeUndefined();
  });

  it('returns undefined for non-numeric value', () => {
    const headers = new Headers({ 'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT' });
    expect(parseRetryAfterSeconds(headers)).toBeUndefined();
  });

  it('returns undefined for zero or negative', () => {
    expect(parseRetryAfterSeconds(new Headers({ 'retry-after': '0' }))).toBeUndefined();
    expect(parseRetryAfterSeconds(new Headers({ 'retry-after': '-1' }))).toBeUndefined();
  });
});

describe('getOpenAIRetryDelayMs', () => {
  it('uses retry-after header from OpenAIHttpError when present', () => {
    const headers = new Headers({ 'retry-after': '3' });
    const err = new OpenAIHttpError(429, 'rate limited', headers);
    expect(getOpenAIRetryDelayMs(err, 1)).toBe(3000);
  });

  it('uses exponential backoff when no retry-after', () => {
    const err = new OpenAIHttpError(500, 'server error');
    // base(1000) * 2^(attempt-1) + floor(random * 500)
    expect(getOpenAIRetryDelayMs(err, 1, () => 0)).toBe(1000);
    expect(getOpenAIRetryDelayMs(err, 2, () => 0)).toBe(2000);
  });

  it('adds jitter based on random function', () => {
    const err = new OpenAIHttpError(500, 'error');
    // 1000 * 2^0 + floor(1.0 * 500) = 1500
    expect(getOpenAIRetryDelayMs(err, 1, () => 1)).toBe(1500);
  });

  it('clamps jitter random to [0, 1]', () => {
    const err = new TypeError('fetch failed');
    const delay = getOpenAIRetryDelayMs(err, 1, () => -0.5);
    // 1000 * 2^0 + floor(0 * 500) = 1000
    expect(delay).toBe(1000);
  });
});

describe('sleepOpenAIRetryDelay', () => {
  it('resolves after delay', async () => {
    await sleepOpenAIRetryDelay(0);
  });
});

describe('parseOpenAISseDataLine', () => {
  it('parses "data:" prefixed line', () => {
    const chunk = parseOpenAISseDataLine('data:{"choices":[{"index":0,"delta":{"content":"hi"}}]}');
    expect(chunk).not.toBe('done');
    expect(chunk).not.toBeUndefined();
    if (chunk && chunk !== 'done') {
      expect(chunk.choices[0].delta?.content).toBe('hi');
    }
  });

  it('parses "data: " with space', () => {
    const chunk = parseOpenAISseDataLine('data: {"choices":[{"index":0,"delta":{"content":"x"}}]}');
    expect(chunk).not.toBe('done');
    expect(chunk).not.toBeUndefined();
    if (chunk && chunk !== 'done') {
      expect(chunk.choices[0].delta?.content).toBe('x');
    }
  });

  it('returns undefined for blank lines', () => {
    expect(parseOpenAISseDataLine('')).toBeUndefined();
    expect(parseOpenAISseDataLine('   ')).toBeUndefined();
  });

  it('returns undefined for comment lines', () => {
    expect(parseOpenAISseDataLine(': keep-alive')).toBeUndefined();
  });

  it('returns "done" for [DONE]', () => {
    expect(parseOpenAISseDataLine('data: [DONE]')).toBe('done');
    expect(parseOpenAISseDataLine('data:[DONE]')).toBe('done');
  });

  it('returns undefined for non-data lines', () => {
    expect(parseOpenAISseDataLine('event: ping')).toBeUndefined();
  });
});

describe('parseOpenAIStreamingChunk', () => {
  it('parses a chunk with empty choices (usage-only)', () => {
    const result = parseOpenAIStreamingChunk({ choices: [] });
    expect(result.choices).toHaveLength(0);
  });

  it('throws for non-object payload', () => {
    expect(() => parseOpenAIStreamingChunk('not an object')).toThrow('did not include choices');
  });

  it('throws for missing choices array', () => {
    expect(() => parseOpenAIStreamingChunk({ id: 'x' })).toThrow('did not include choices');
  });
});

describe('streaming accumulation', () => {
  it('accumulates text content across chunks', () => {
    const acc = createOpenAIStreamingAccumulator();

    applyOpenAIStreamingChunk(acc, {
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }],
    });
    applyOpenAIStreamingChunk(acc, {
      choices: [{ index: 0, delta: { content: ' world' } }],
    });
    applyOpenAIStreamingChunk(acc, {
      choices: [{ index: 0, finish_reason: 'stop' }],
    });

    const response = assembleOpenAIStreamingResponse(acc);
    expect(response.choices).toHaveLength(1);
    expect(response.choices[0].message.content).toBe('Hello world');
    expect(response.choices[0].finish_reason).toBe('stop');
    expect(response.choices[0].message.role).toBe('assistant');
  });

  it('accumulates tool call arguments across fragmented deltas', () => {
    const acc = createOpenAIStreamingAccumulator();

    applyOpenAIStreamingChunk(acc, {
      choices: [{
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [{
            index: 0,
            id: 'call_abc',
            type: 'function',
            function: { name: 'my_tool', arguments: '{"ke' },
          }],
        },
      }],
    });

    applyOpenAIStreamingChunk(acc, {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: 'y":"val' },
          }],
        },
      }],
    });

    applyOpenAIStreamingChunk(acc, {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            function: { arguments: 'ue"}' },
          }],
        },
      }],
    });

    applyOpenAIStreamingChunk(acc, {
      choices: [{ index: 0, finish_reason: 'tool_calls' }],
    });

    const response = assembleOpenAIStreamingResponse(acc);
    expect(response.choices[0].message.tool_calls).toHaveLength(1);
    expect(response.choices[0].message.tool_calls![0].id).toBe('call_abc');
    expect(response.choices[0].message.tool_calls![0].function.name).toBe('my_tool');
    expect(response.choices[0].message.tool_calls![0].function.arguments).toBe('{"key":"value"}');
  });

  it('handles usage-only chunk with empty choices', () => {
    const acc = createOpenAIStreamingAccumulator();
    applyOpenAIStreamingChunk(acc, { choices: [] });
    const response = assembleOpenAIStreamingResponse(acc);
    expect(response.choices).toHaveLength(0);
  });

  it('assembles empty content when no text and no tool calls', () => {
    const acc = createOpenAIStreamingAccumulator();
    applyOpenAIStreamingChunk(acc, {
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'stop' }],
    });
    const response = assembleOpenAIStreamingResponse(acc);
    expect(response.choices[0].message.content).toBe('');
  });

  it('sets content to null when tool_calls present but no text', () => {
    const acc = createOpenAIStreamingAccumulator();
    applyOpenAIStreamingChunk(acc, {
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 0,
            id: 'call_x',
            type: 'function',
            function: { name: 'fn', arguments: '{}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    });
    const response = assembleOpenAIStreamingResponse(acc);
    expect(response.choices[0].message.content).toBeNull();
    expect(response.choices[0].message.tool_calls).toHaveLength(1);
  });
});

describe('OpenAIProvider', () => {
  it('reports supportsNativeSlashCommands as false', () => {
    const provider = new OpenAIProvider();
    expect(provider.supportsNativeSlashCommands).toBe(false);
  });

  it('isSessionInvalid always returns false', () => {
    const provider = new OpenAIProvider();
    expect(provider.isSessionInvalid(new Error('anything'))).toBe(false);
    expect(provider.isSessionInvalid(null)).toBe(false);
  });
});

describe('error classes', () => {
  it('OpenAIHttpError stores status and headers', () => {
    const headers = new Headers({ 'x-test': '1' });
    const err = new OpenAIHttpError(429, 'rate limited', headers);
    expect(err.status).toBe(429);
    expect(err.message).toBe('rate limited');
    expect(err.headers?.get('x-test')).toBe('1');
    expect(err.name).toBe('OpenAIHttpError');
    expect(err).toBeInstanceOf(Error);
  });

  it('ProviderRuntimeError stores retryable and classification', () => {
    const err = new ProviderRuntimeError('fail', false, 'auth');
    expect(err.retryable).toBe(false);
    expect(err.classification).toBe('auth');
    expect(err.name).toBe('ProviderRuntimeError');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('OpenAIProvider fetch integration', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  type Event = { type: string; message?: string; text?: string | null; retryable?: boolean };

  async function drain(events: AsyncIterable<unknown>, max = 60): Promise<Event[]> {
    const out: Event[] = [];
    for await (const ev of events) {
      const e = ev as Event;
      out.push(e);
      if (e.type === 'result' || e.type === 'error') break;
      if (out.length >= max) break;
    }
    return out;
  }

  function jsonResponse(body: object, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
  }

  function okBody(content: string) {
    return { choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] };
  }

  const baseEnv = { OPENAI_API_KEY: 'test-key', OPENAI_MODEL: 'gpt-4', OPENAI_STREAM: 'false' };

  it('sends fetch to resolved OPENAI_BASE_URL', async () => {
    let fetchedUrl = '';
    globalThis.fetch = mock((url: string) => {
      fetchedUrl = url;
      return Promise.resolve(jsonResponse(okBody('hi')));
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider({
      env: { ...baseEnv, OPENAI_BASE_URL: 'https://custom.example.com/v1' },
    });

    const q = provider.query({ prompt: 'ping', cwd: '/tmp' });
    await drain(q.events);

    expect(fetchedUrl).toBe('https://custom.example.com/v1/chat/completions');
  });

  it('sends stream: false in request body when OPENAI_STREAM=false', async () => {
    let fetchedBody = '';
    globalThis.fetch = mock((_url: string, init: { body: string }) => {
      fetchedBody = init.body;
      return Promise.resolve(jsonResponse(okBody('ok')));
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider({ env: baseEnv });
    const q = provider.query({ prompt: 'ping', cwd: '/tmp' });
    await drain(q.events);

    expect(JSON.parse(fetchedBody).stream).toBe(false);
  });

  it('emits retry progress on 429', async () => {
    let fetchCount = 0;
    globalThis.fetch = mock(() => {
      fetchCount++;
      return Promise.resolve(
        new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } }),
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAIProvider({ env: baseEnv });
    const q = provider.query({ prompt: 'test', cwd: '/tmp' });

    const events: Event[] = [];
    for await (const ev of q.events) {
      const e = ev as Event;
      events.push(e);
      if (e.type === 'progress' && e.message?.includes('retrying in')) {
        q.abort();
        break;
      }
      if (e.type === 'result' || e.type === 'error') break;
      if (events.length >= 60) break;
    }

    expect(fetchCount).toBe(1);
    const retryProgress = events.find((e) => e.type === 'progress' && e.message?.includes('retrying in'));
    expect(retryProgress).toBeDefined();
    expect(retryProgress!.message).toContain('HTTP 429');
  });

  it('yields non-retryable error on content_filter finish_reason', async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        jsonResponse({
          choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'content_filter' }],
        }),
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = new OpenAIProvider({ env: baseEnv });
    const q = provider.query({ prompt: 'test', cwd: '/tmp' });
    const events = await drain(q.events);

    const err = events.find((e) => e.type === 'error');
    expect(err).toBeDefined();
    expect(err!.message).toContain('content filter');
    expect(err!.retryable).toBe(false);
  });
});
