import fs from 'fs';
import path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

const OPENAI_CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_CONTINUATION = JSON.stringify({ provider: 'openai', v: 1 });
const MAX_TOOL_STEPS = 12;
const MAX_TOOL_RESULT_CHARS = 50 * 1024;
const OPENAI_MAX_ATTEMPTS = 3;
const OPENAI_RETRY_BASE_DELAY_MS = 1000;
const OPENAI_RETRY_MAX_JITTER_MS = 500;

/**
 * Resolves the OpenAI chat completions endpoint URL.
 * - If baseUrl is not provided, returns the default OpenAI URL.
 * - If baseUrl ends with `/chat/completions`, uses it as-is.
 * - If baseUrl ends with `/v1`, appends `/chat/completions`.
 * - Otherwise, appends `/v1/chat/completions`.
 */
export function resolveOpenAIChatCompletionsUrl(baseUrl?: string): string {
  if (!baseUrl) {
    return OPENAI_CHAT_COMPLETIONS_URL;
  }

  const trimmed = baseUrl.trim();
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed;
  }
  if (trimmed.endsWith('/v1')) {
    return `${trimmed}/chat/completions`;
  }
  return `${trimmed}/v1/chat/completions`;
}

/**
 * Resolves the OpenAI request timeout in milliseconds.
 * - If raw is not provided or invalid, returns the default 120000 ms.
 * - Parses raw as an integer and returns it if valid and positive.
 * - Returns default if parsing fails or value is non-positive.
 */
export function resolveOpenAIRequestTimeoutMs(raw?: string): number {
  const DEFAULT_TIMEOUT_MS = 120000;

  if (!raw) {
    return DEFAULT_TIMEOUT_MS;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return DEFAULT_TIMEOUT_MS;
  }

  // Strict validation: only accept strings that are purely digits
  if (!/^\d+$/.test(trimmed)) {
    return DEFAULT_TIMEOUT_MS;
  }

  const parsed = Number(trimmed);
  if (parsed <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }

  return parsed;
}

export function resolveOpenAIStreamEnabled(raw?: string): boolean {
  if (!raw) {
    return true;
  }

  const normalized = raw.trim().toLowerCase();
  return normalized !== 'false' && normalized !== '0' && normalized !== 'no';
}

type JsonObject = Record<string, unknown>;

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

type OpenAIChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content?: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

interface OpenAIChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: JsonObject;
  };
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  stream: boolean;
  tools?: OpenAIChatTool[];
  tool_choice?: 'auto';
}

interface OpenAIChatResponse {
  choices: Array<{
    index: number;
    finish_reason?: string;
    message: Extract<OpenAIChatMessage, { role: 'assistant' }>;
  }>;
}

export interface OpenAIStreamingToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface OpenAIStreamingChoiceDelta {
  role?: string;
  content?: string | null;
  tool_calls?: OpenAIStreamingToolCallDelta[];
}

export interface OpenAIStreamingChoice {
  index: number;
  delta?: OpenAIStreamingChoiceDelta;
  finish_reason?: string | null;
}

export interface OpenAIStreamingChatChunk {
  choices: OpenAIStreamingChoice[];
}

export interface OpenAIStreamingToolCallState {
  id?: string;
  type?: string;
  name: string;
  arguments: string;
}

export interface OpenAIStreamingChoiceState {
  index: number;
  content: string;
  finishReason?: string;
  toolCalls: Map<number, OpenAIStreamingToolCallState>;
}

export interface OpenAIStreamingAccumulator {
  choices: Map<number, OpenAIStreamingChoiceState>;
}

type McpCallResult = Awaited<ReturnType<Client['callTool']>>;
type McpContentResult = Extract<McpCallResult, { content: unknown[] }>;
type McpContentItem = McpContentResult['content'][number];

interface McpSession {
  client: Client;
  tools: OpenAIChatTool[];
  mcpNameByOpenAIName: Map<string, string>;
}

function log(msg: string): void {
  console.error(`[openai-provider] ${msg}`);
}

// ── System-prompt assembly ──────────────────────────────────────────────────
// OpenAI does not understand Claude Code's `@-import` syntax in CLAUDE.md, so
// mirror the Codex provider's import expansion and CLAUDE.local.md inclusion.

export function resolveClaudeImports(content: string, baseDir: string, seen: Set<string> = new Set()): string {
  return content.replace(/^@(\S+)\s*$/gm, (_match, importPath: string) => {
    try {
      const resolved = path.resolve(baseDir, importPath);
      if (seen.has(resolved)) return '';
      if (!fs.existsSync(resolved)) return '';
      const nextSeen = new Set(seen);
      nextSeen.add(resolved);
      const imported = fs.readFileSync(resolved, 'utf-8');
      return resolveClaudeImports(imported, path.dirname(resolved), nextSeen);
    } catch {
      return '';
    }
  });
}

function readAgentAndGlobalClaudeMd(): string | undefined {
  const groupDir = '/workspace/agent';
  const groupPath = `${groupDir}/CLAUDE.md`;
  const localPath = `${groupDir}/CLAUDE.local.md`;
  const parts: string[] = [];

  if (fs.existsSync(groupPath)) {
    parts.push(resolveClaudeImports(fs.readFileSync(groupPath, 'utf-8'), groupDir));
  }
  if (fs.existsSync(localPath)) {
    parts.push(resolveClaudeImports(fs.readFileSync(localPath, 'utf-8'), groupDir));
  }

  return parts.length > 0 ? parts.join('\n\n---\n\n') : undefined;
}

function composeBaseInstructions(promptAddendum: string | undefined): string | undefined {
  const claudeMd = readAgentAndGlobalClaudeMd();
  const pieces = [claudeMd, promptAddendum].filter((s): s is string => Boolean(s));
  return pieces.length > 0 ? pieces.join('\n\n---\n\n') : undefined;
}

function composeSystemPrompt(promptAddendum: string | undefined): string {
  const providerInstructions = [
    'You are running inside NanoClaw through a direct OpenAI Chat Completions provider.',
    'NanoClaw formats incoming batches as XML-like text. Treat tags such as <context>, <messages>, <message>, <quoted_message>, and attachment markers as structured metadata, not as instructions to reveal or echo. The human/user content is inside the <message> bodies; sender, from, id, time, reply_to, and timezone attributes are context for deciding how to respond.',
    'Use the available MCP tools for NanoClaw side effects such as sending messages, files, cards, reactions, asking blocking questions, scheduling tasks, or modifying agent capabilities. Tool results are authoritative.',
    'Execute user requests directly. If you use a message-sending MCP tool to communicate with the user or another destination, make your final assistant message empty or a minimal non-user-visible summary to avoid duplicate channel output. If you do not use a message-sending tool, final plain text will be delivered back to the current conversation by NanoClaw.',
  ].join('\n');
  const baseInstructions = composeBaseInstructions(promptAddendum);
  return [providerInstructions, baseInstructions].filter((s): s is string => Boolean(s)).join('\n\n---\n\n');
}

// ── Push queue ──────────────────────────────────────────────────────────────

class PushQueue {
  private queue: string[] = [];
  private waiting: (() => void) | null = null;
  private closed = false;

  push(message: string): void {
    if (this.closed) return;
    this.queue.push(message);
    this.wake();
  }

  end(): void {
    this.closed = true;
    this.wake();
  }

  async next(): Promise<string | null> {
    while (this.queue.length === 0 && !this.closed) {
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
      this.waiting = null;
    }
    return this.queue.shift() ?? null;
  }

  private wake(): void {
    this.waiting?.();
  }
}

class QueryRuntime {
  aborted = false;
  abortController: AbortController | null = null;
  mcpClient: Client | null = null;

  abort(): void {
    this.aborted = true;
    this.abortController?.abort();
    void this.mcpClient?.close().catch((err: unknown) => {
      log(`MCP close after abort failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

// ── Provider ────────────────────────────────────────────────────────────────

export class OpenAIProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private readonly apiKey?: string;
  private readonly model?: string;
  private readonly baseUrl?: string;
  private readonly requestTimeoutMs: number;
  private readonly streamEnabled: boolean;

  constructor(options: ProviderOptions = {}) {
    this.apiKey = getEnv(options.env, 'OPENAI_API_KEY');
    this.model = getEnv(options.env, 'OPENAI_MODEL');
    this.baseUrl = getEnv(options.env, 'OPENAI_BASE_URL');
    this.requestTimeoutMs = resolveOpenAIRequestTimeoutMs(getEnv(options.env, 'OPENAI_REQUEST_TIMEOUT_MS'));
    this.streamEnabled = resolveOpenAIStreamEnabled(getEnv(options.env, 'OPENAI_STREAM'));
    log(`Chat completions URL: ${resolveOpenAIChatCompletionsUrl(this.baseUrl)}`);
  }

  /**
   * OpenAI Chat Completions API is stateless; there is no server-side session or thread.
   * OPENAI_CONTINUATION is just a static marker { provider: 'openai', v: 1 } for continuation
   * tracking, not a session token. Always returns false.
   */
  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const queue = new PushQueue();
    const runtime = new QueryRuntime();
    const apiKey = this.apiKey;
    const model = this.model;
    const baseUrl = this.baseUrl;
    const requestTimeoutMs = this.requestTimeoutMs;
    const streamEnabled = this.streamEnabled;

    queue.push(input.prompt);

    async function* gen(): AsyncGenerator<ProviderEvent> {
      yield { type: 'activity' };
      yield { type: 'init', continuation: OPENAI_CONTINUATION };

      if (!apiKey) {
        yield { type: 'error', message: 'OPENAI_API_KEY is required for the OpenAI provider', retryable: false, classification: 'auth' };
        return;
      }
      if (!model) {
        yield { type: 'error', message: 'OPENAI_MODEL is required for the OpenAI provider', retryable: false };
        return;
      }

      let mcpSession: McpSession | null = null;
      const messages: OpenAIChatMessage[] = [{ role: 'system', content: composeSystemPrompt(input.systemContext?.instructions) }];

      try {
        yield { type: 'progress', message: 'Starting NanoClaw MCP tools' };
        mcpSession = await startMcpSession();
        runtime.mcpClient = mcpSession.client;
        yield { type: 'activity' };
        yield { type: 'progress', message: `Discovered ${mcpSession.tools.length} MCP tools` };

        while (!runtime.aborted) {
          const prompt = await queue.next();
          if (prompt === null || runtime.aborted) return;

          messages.push({ role: 'user', content: prompt });
          yield* runOneTurn(messages, mcpSession, apiKey, model, baseUrl, requestTimeoutMs, streamEnabled, runtime);
        }
      } catch (err) {
        if (!runtime.aborted) {
          yield toProviderError(err);
        }
      } finally {
        if (mcpSession) {
          runtime.mcpClient = null;
          await mcpSession.client.close().catch((err: unknown) => {
            log(`MCP close failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
      }
    }

    return {
      push: (message: string) => queue.push(message),
      end: () => queue.end(),
      abort: () => {
        runtime.abort();
        queue.end();
      },
      events: gen(),
    };
  }
}

// ── Turn loop ───────────────────────────────────────────────────────────────

async function* runOneTurn(
  messages: OpenAIChatMessage[],
  mcpSession: McpSession,
  apiKey: string,
  model: string,
  baseUrl: string | undefined,
  requestTimeoutMs: number,
  streamEnabled: boolean,
  runtime: QueryRuntime,
): AsyncGenerator<ProviderEvent> {
  for (let step = 1; step <= MAX_TOOL_STEPS; step++) {
    if (runtime.aborted) return;

    let response: OpenAIChatResponse | undefined;

    for (let attempt = 1; attempt <= OPENAI_MAX_ATTEMPTS; attempt++) {
      if (runtime.aborted) return;

      yield { type: 'activity' };
      yield {
        type: 'progress',
        message:
          attempt === 1
            ? step === 1
              ? 'Calling OpenAI'
              : `Calling OpenAI after tool step ${step - 1}`
            : `Retrying OpenAI request (attempt ${attempt} of ${OPENAI_MAX_ATTEMPTS})`,
      };

      try {
        if (streamEnabled) {
          response = yield* createStreamingChatCompletion(apiKey, model, messages, mcpSession.tools, baseUrl, requestTimeoutMs, runtime);
        } else {
          response = await createChatCompletion(apiKey, model, messages, mcpSession.tools, baseUrl, requestTimeoutMs, runtime);
        }
        break;
      } catch (err) {
        if (runtime.aborted) return;
        if (attempt >= OPENAI_MAX_ATTEMPTS || !shouldRetryOpenAIError(err)) {
          throw err;
        }

        const delayMs = getOpenAIRetryDelayMs(err, attempt);
        yield { type: 'activity' };
        yield {
          type: 'progress',
          message: `OpenAI request failed transiently (${describeOpenAIError(err)}); retrying in ${delayMs}ms`,
        };

        if (runtime.aborted) return;
        await sleepOpenAIRetryDelay(delayMs);
        if (runtime.aborted) return;
      }
    }

    if (runtime.aborted) return;
    if (!response) {
      throw new ProviderRuntimeError('OpenAI request did not return a response', true);
    }

    const choice = response.choices[0];
    if (!choice) {
      throw new ProviderRuntimeError('OpenAI returned no choices', true);
    }

    const assistantMessage = choice.message;
    messages.push(assistantMessage);
    yield { type: 'activity' };

    // Handle finish_reason before processing tool calls or result
    if (choice.finish_reason === 'content_filter') {
      throw new ProviderRuntimeError('Response blocked by content filter', false);
    }

    if (choice.finish_reason === 'length') {
      yield { type: 'progress', message: 'Response truncated due to length limit' };
    }

    const toolCalls = assistantMessage.tool_calls ?? [];
    if (toolCalls.length === 0) {
      const text = assistantMessage.content?.trim() ? assistantMessage.content : null;
      yield { type: 'result', text };
      return;
    }

    yield { type: 'progress', message: `OpenAI requested ${toolCalls.length} tool call${toolCalls.length === 1 ? '' : 's'}` };

    if (toolCalls.length === 1) {
      if (runtime.aborted) return;
      const tc = toolCalls[0];
      const mcpName = mcpSession.mcpNameByOpenAIName.get(tc.function.name);
      yield { type: 'activity' };
      yield { type: 'progress', message: `Running MCP tool: ${mcpName ?? tc.function.name}` };
      const toolMessage = await callMcpToolAsMessage(tc, mcpSession);
      messages.push(toolMessage);
      yield { type: 'activity' };
    } else {
      // OpenAI's tool calls within a single assistant response are independent: the model
      // has not seen any tool result yet when it generates multiple calls, so their execution
      // order cannot affect each other's semantics. We launch them concurrently and collect
      // results with Promise.allSettled to ensure one failure does not drop other results.
      // Messages are appended in the original toolCalls order for deterministic history.
      if (runtime.aborted) return;
      for (const tc of toolCalls) {
        const mcpName = mcpSession.mcpNameByOpenAIName.get(tc.function.name);
        yield { type: 'activity' };
        yield { type: 'progress', message: `Running MCP tool: ${mcpName ?? tc.function.name}` };
      }

      const settled = await Promise.allSettled(
        toolCalls.map((tc) => callMcpToolAsMessage(tc, mcpSession)),
      );

      for (let i = 0; i < toolCalls.length; i++) {
        const result = settled[i];
        if (result.status === 'fulfilled') {
          messages.push(result.value);
        } else {
          const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
          messages.push({
            role: 'tool',
            tool_call_id: toolCalls[i].id,
            content: `Error: ${errMsg}`,
          });
        }
      }
      yield { type: 'activity' };
    }
  }

  throw new ProviderRuntimeError(`OpenAI tool loop exceeded ${MAX_TOOL_STEPS} steps`, false);
}

async function callMcpToolAsMessage(
  toolCall: OpenAIToolCall,
  mcpSession: McpSession,
): Promise<Extract<OpenAIChatMessage, { role: 'tool' }>> {
  const openAIName = toolCall.function.name;
  const mcpName = mcpSession.mcpNameByOpenAIName.get(openAIName);

  if (!mcpName) {
    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: `Error: unknown MCP tool mapped from OpenAI tool name "${openAIName}"`,
    };
  }

  const parsedArgs = parseToolArguments(toolCall.function.arguments);
  if (!parsedArgs.ok) {
    return { role: 'tool', tool_call_id: toolCall.id, content: parsedArgs.error };
  }

  try {
    const result = await mcpSession.client.callTool({ name: mcpName, arguments: parsedArgs.value });
    const text = truncateToolResult(formatMcpResult(result));
    return { role: 'tool', tool_call_id: toolCall.id, content: text };
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err);
    return { role: 'tool', tool_call_id: toolCall.id, content: `Error while running ${mcpName}: ${errMessage}` };
  }
}

async function createChatCompletion(
  apiKey: string,
  model: string,
  messages: OpenAIChatMessage[],
  tools: OpenAIChatTool[],
  baseUrl: string | undefined,
  requestTimeoutMs: number,
  runtime: QueryRuntime,
): Promise<OpenAIChatResponse> {
  const request: OpenAIChatRequest = {
    model,
    messages,
    stream: false,
  };

  if (tools.length > 0) {
    request.tools = tools;
    request.tool_choice = 'auto';
  }

  const controller = new AbortController();
  runtime.abortController = controller;

  const url = resolveOpenAIChatCompletionsUrl(baseUrl);

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    timeoutTimer = setTimeout(() => {
      controller.abort();
    }, requestTimeoutMs);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new OpenAIHttpError(response.status, await readOpenAIError(response), response.headers);
    }

    const payload: unknown = await response.json();
    return parseOpenAIChatResponse(payload);
  } finally {
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer);
    }
    if (runtime.abortController === controller) {
      runtime.abortController = null;
    }
  }
}

async function* createStreamingChatCompletion(
  apiKey: string,
  model: string,
  messages: OpenAIChatMessage[],
  tools: OpenAIChatTool[],
  baseUrl: string | undefined,
  requestTimeoutMs: number,
  runtime: QueryRuntime,
): AsyncGenerator<ProviderEvent, OpenAIChatResponse, void> {
  const request: OpenAIChatRequest = {
    model,
    messages,
    stream: true,
  };

  if (tools.length > 0) {
    request.tools = tools;
    request.tool_choice = 'auto';
  }

  const controller = new AbortController();
  runtime.abortController = controller;

  const url = resolveOpenAIChatCompletionsUrl(baseUrl);
  const accumulator = createOpenAIStreamingAccumulator();

  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    timeoutTimer = setTimeout(() => {
      controller.abort();
    }, requestTimeoutMs);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new OpenAIHttpError(response.status, await readOpenAIError(response), response.headers);
    }

    if (!response.body) {
      throw new ProviderRuntimeError('OpenAI streaming response did not include a body', true);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;

    while (!done) {
      const read = await reader.read();
      if (read.done) break;

      buffer += decoder.decode(read.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const parsed = parseOpenAISseDataLine(line);
        if (parsed === 'done') {
          done = true;
          break;
        }
        if (parsed === undefined) continue;

        applyOpenAIStreamingChunk(accumulator, parsed);
        yield { type: 'activity' };
      }
    }

    buffer += decoder.decode();
    if (!done && buffer.length > 0) {
      const parsed = parseOpenAISseDataLine(buffer);
      if (parsed !== undefined && parsed !== 'done') {
        applyOpenAIStreamingChunk(accumulator, parsed);
        yield { type: 'activity' };
      }
    }

    return assembleOpenAIStreamingResponse(accumulator);
  } catch (err) {
    if (err instanceof OpenAIHttpError || err instanceof ProviderRuntimeError || err instanceof TypeError || (err instanceof Error && err.name === 'AbortError')) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    throw new ProviderRuntimeError(`OpenAI streaming response failed before completion: ${message}`, true);
  } finally {
    if (timeoutTimer !== null) {
      clearTimeout(timeoutTimer);
    }
    if (runtime.abortController === controller) {
      runtime.abortController = null;
    }
  }
}

export function createOpenAIStreamingAccumulator(): OpenAIStreamingAccumulator {
  return { choices: new Map() };
}

export function parseOpenAISseDataLine(line: string): OpenAIStreamingChatChunk | 'done' | undefined {
  const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!normalized.trim() || normalized.startsWith(':')) {
    return undefined;
  }
  if (!normalized.startsWith('data:')) {
    return undefined;
  }

  const rawData = normalized.slice(5);
  const data = rawData.startsWith(' ') ? rawData.slice(1) : rawData;
  if (data.trim() === '[DONE]') {
    return 'done';
  }

  const payload = JSON.parse(data) as unknown;
  return parseOpenAIStreamingChunk(payload);
}

export function parseOpenAIStreamingChunk(payload: unknown): OpenAIStreamingChatChunk {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new Error('OpenAI streaming chunk did not include choices');
  }

  return {
    choices: payload.choices.map(parseOpenAIStreamingChoice),
  };
}

function parseOpenAIStreamingChoice(payload: unknown, fallbackIndex: number): OpenAIStreamingChoice {
  if (!isRecord(payload)) {
    throw new Error('OpenAI streaming choice was not an object');
  }

  return {
    index: typeof payload.index === 'number' ? payload.index : fallbackIndex,
    delta: parseOpenAIStreamingDelta(payload.delta),
    finish_reason:
      typeof payload.finish_reason === 'string' || payload.finish_reason === null ? payload.finish_reason : undefined,
  };
}

function parseOpenAIStreamingDelta(payload: unknown): OpenAIStreamingChoiceDelta | undefined {
  if (payload === undefined || payload === null) {
    return undefined;
  }
  if (!isRecord(payload)) {
    throw new Error('OpenAI streaming delta was not an object');
  }

  const delta: OpenAIStreamingChoiceDelta = {};
  if (typeof payload.role === 'string') {
    delta.role = payload.role;
  }
  if (typeof payload.content === 'string' || payload.content === null) {
    delta.content = payload.content;
  }
  if (payload.tool_calls !== undefined) {
    if (!Array.isArray(payload.tool_calls)) {
      throw new Error('OpenAI streaming tool_calls delta was not an array');
    }
    delta.tool_calls = payload.tool_calls.map(parseOpenAIStreamingToolCallDelta);
  }

  return delta;
}

function parseOpenAIStreamingToolCallDelta(payload: unknown): OpenAIStreamingToolCallDelta {
  if (!isRecord(payload)) {
    throw new Error('OpenAI streaming tool call delta was not an object');
  }

  const delta: OpenAIStreamingToolCallDelta = {};
  if (typeof payload.index === 'number') {
    delta.index = payload.index;
  }
  if (typeof payload.id === 'string') {
    delta.id = payload.id;
  }
  if (typeof payload.type === 'string') {
    delta.type = payload.type;
  }
  if (payload.function !== undefined) {
    if (!isRecord(payload.function)) {
      throw new Error('OpenAI streaming tool call function delta was not an object');
    }
    delta.function = {};
    if (typeof payload.function.name === 'string') {
      delta.function.name = payload.function.name;
    }
    if (typeof payload.function.arguments === 'string') {
      delta.function.arguments = payload.function.arguments;
    }
  }

  return delta;
}

export function applyOpenAIStreamingChunk(accumulator: OpenAIStreamingAccumulator, chunk: OpenAIStreamingChatChunk): void {
  for (const choice of chunk.choices) {
    let state = accumulator.choices.get(choice.index);
    if (!state) {
      state = { index: choice.index, content: '', toolCalls: new Map() };
      accumulator.choices.set(choice.index, state);
    }

    if (typeof choice.finish_reason === 'string') {
      state.finishReason = choice.finish_reason;
    }

    const delta = choice.delta;
    if (!delta) continue;

    if (typeof delta.content === 'string') {
      state.content += delta.content;
    }

    if (!delta.tool_calls) continue;

    for (const toolCallDelta of delta.tool_calls) {
      if (typeof toolCallDelta.index !== 'number') {
        throw new Error('OpenAI streaming tool call delta was missing index');
      }

      let toolCall = state.toolCalls.get(toolCallDelta.index);
      if (!toolCall) {
        toolCall = { name: '', arguments: '' };
        state.toolCalls.set(toolCallDelta.index, toolCall);
      }

      if (typeof toolCallDelta.id === 'string' && !toolCall.id) {
        toolCall.id = toolCallDelta.id;
      }
      if (typeof toolCallDelta.type === 'string' && !toolCall.type) {
        toolCall.type = toolCallDelta.type;
      }
      if (toolCallDelta.function) {
        if (typeof toolCallDelta.function.name === 'string') {
          toolCall.name += toolCallDelta.function.name;
        }
        if (typeof toolCallDelta.function.arguments === 'string') {
          toolCall.arguments += toolCallDelta.function.arguments;
        }
      }
    }
  }
}

export function assembleOpenAIStreamingResponse(accumulator: OpenAIStreamingAccumulator): OpenAIChatResponse {
  return {
    choices: [...accumulator.choices.values()]
      .sort((a, b) => a.index - b.index)
      .map((choice) => ({
        index: choice.index,
        finish_reason: choice.finishReason,
        message: assembleOpenAIStreamingMessage(choice),
      })),
  };
}

function assembleOpenAIStreamingMessage(choice: OpenAIStreamingChoiceState): Extract<OpenAIChatMessage, { role: 'assistant' }> {
  const toolCalls = [...choice.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([_index, toolCall]) => assembleOpenAIStreamingToolCall(toolCall));

  const message: Extract<OpenAIChatMessage, { role: 'assistant' }> = { role: 'assistant' };
  if (choice.content.length > 0) {
    message.content = choice.content;
  } else if (toolCalls.length > 0) {
    message.content = null;
  } else {
    message.content = '';
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return message;
}

function assembleOpenAIStreamingToolCall(toolCall: OpenAIStreamingToolCallState): OpenAIToolCall {
  if (!toolCall.id) {
    throw new Error('OpenAI streaming tool call was missing id');
  }
  if (!toolCall.name) {
    throw new Error('OpenAI streaming tool call was missing function name');
  }

  return {
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments: toolCall.arguments,
    },
  };
}

// ── MCP integration ─────────────────────────────────────────────────────────

async function startMcpSession(): Promise<McpSession> {
  const client = new Client({ name: 'nanoclaw-openai-provider', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: 'bun',
    args: ['run', '/app/src/mcp-tools/index.ts'],
  });

  await client.connect(transport);
  const mcpTools = await listAllMcpTools(client);
  const catalog = buildToolCatalog(mcpTools);
  return { client, ...catalog };
}

async function listAllMcpTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...result.tools);
    cursor = result.nextCursor;
  } while (cursor);

  return tools;
}

function buildToolCatalog(mcpTools: Tool[]): Pick<McpSession, 'tools' | 'mcpNameByOpenAIName'> {
  const used = new Set<string>();
  const mcpNameByOpenAIName = new Map<string, string>();
  const tools = mcpTools.map((tool): OpenAIChatTool => {
    const openAIName = createOpenAIToolName(tool.name, used);
    mcpNameByOpenAIName.set(openAIName, tool.name);
    return {
      type: 'function',
      function: {
        name: openAIName,
        description: tool.description,
        parameters: normalizeToolParameters(tool.inputSchema),
      },
    };
  });

  return { tools, mcpNameByOpenAIName };
}

export function createOpenAIToolName(mcpName: string, used: Set<string>): string {
  const sanitized = mcpName.replace(/__+/g, '_').replace(/[^A-Za-z0-9_-]/g, '_');
  const base = (sanitized || 'tool').slice(0, 64);

  if (!used.has(base)) {
    used.add(base);
    return base;
  }

  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

export function normalizeToolParameters(schema: Tool['inputSchema'] | undefined): JsonObject {
  const params: JsonObject = isRecord(schema) ? { ...schema } : {};
  if (params.type !== 'object') {
    params.type = 'object';
  }
  if (!isRecord(params.properties)) {
    params.properties = {};
  }
  return params;
}

export function parseToolArguments(raw: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, value: {} };

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isRecord(parsed)) {
      return { ok: false, error: 'Error: tool arguments must be a JSON object' };
    }
    return { ok: true, value: parsed };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Error: invalid JSON tool arguments: ${message}` };
  }
}

function formatMcpResult(result: McpCallResult): string {
  if ('content' in result && Array.isArray(result.content)) {
    const text = result.content.map(formatMcpContentItem).join('\n');
    return 'isError' in result && result.isError ? `Tool returned an error:\n${text}` : text;
  }
  if ('toolResult' in result) {
    return stringifyUnknown(result.toolResult);
  }
  return stringifyUnknown(result);
}

function formatMcpContentItem(item: McpContentItem): string {
  switch (item.type) {
    case 'text':
      return item.text;
    case 'image':
      return `[image: ${item.mimeType}, ${item.data.length} base64 chars]`;
    case 'audio':
      return `[audio: ${item.mimeType}, ${item.data.length} base64 chars]`;
    case 'resource':
      return stringifyUnknown(item.resource);
    case 'resource_link':
      return `[resource: ${item.name} at ${item.uri}]`;
    default:
      return stringifyUnknown(item);
  }
}

export function truncateToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n\n[truncated ${text.length - MAX_TOOL_RESULT_CHARS} characters from MCP tool result]`;
}

// ── OpenAI response parsing and errors ──────────────────────────────────────

export class OpenAIHttpError extends Error {
  readonly status: number;
  readonly headers?: Headers;

  constructor(status: number, message: string, headers?: Headers) {
    super(message);
    this.name = 'OpenAIHttpError';
    this.status = status;
    this.headers = headers;
  }
}

export class ProviderRuntimeError extends Error {
  readonly retryable: boolean;
  readonly classification?: string;

  constructor(message: string, retryable: boolean, classification?: string) {
    super(message);
    this.name = 'ProviderRuntimeError';
    this.retryable = retryable;
    this.classification = classification;
  }
}

export function parseRetryAfterSeconds(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')?.trim();
  if (!raw) return undefined;

  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export function shouldRetryOpenAIError(err: unknown): boolean {
  if (err instanceof ProviderRuntimeError) {
    return err.retryable;
  }

  if (err instanceof OpenAIHttpError) {
    return err.status === 429 || (err.status >= 500 && err.status <= 599);
  }

  if (err instanceof Error && err.name === 'AbortError') {
    return true;
  }

  return err instanceof TypeError;
}

export function getOpenAIRetryDelayMs(err: unknown, retryAttempt: number, random: () => number = Math.random): number {
  if (err instanceof OpenAIHttpError && err.headers) {
    const retryAfterSeconds = parseRetryAfterSeconds(err.headers);
    if (retryAfterSeconds !== undefined) {
      return Math.round(retryAfterSeconds * 1000);
    }
  }

  const exponentialDelayMs = OPENAI_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryAttempt - 1);
  const jitterRatio = Math.max(0, Math.min(random(), 1));
  const jitterMs = Math.floor(jitterRatio * OPENAI_RETRY_MAX_JITTER_MS);
  return exponentialDelayMs + jitterMs;
}

export async function sleepOpenAIRetryDelay(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function describeOpenAIError(err: unknown): string {
  if (err instanceof OpenAIHttpError) {
    return `HTTP ${err.status}`;
  }
  if (err instanceof Error) {
    return err.name || err.message;
  }
  return String(err);
}

async function readOpenAIError(response: Response): Promise<string> {
  const fallback = `OpenAI request failed with HTTP ${response.status}`;
  const text = await response.text();
  if (!text.trim()) return fallback;

  const parsed = safeJsonParse(text);
  if (isRecord(parsed)) {
    const error = parsed.error;
    if (isRecord(error) && typeof error.message === 'string') {
      return `${fallback}: ${error.message}`;
    }
  }

  return `${fallback}: ${text.slice(0, 500)}`;
}

export function parseOpenAIChatResponse(payload: unknown): OpenAIChatResponse {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new Error('OpenAI response did not include choices');
  }

  return {
    choices: payload.choices.map((choice, index) => parseOpenAIChoice(choice, index)),
  };
}

function parseOpenAIChoice(payload: unknown, fallbackIndex: number): OpenAIChatResponse['choices'][number] {
  if (!isRecord(payload)) {
    throw new Error('OpenAI choice was not an object');
  }
  return {
    index: typeof payload.index === 'number' ? payload.index : fallbackIndex,
    finish_reason: typeof payload.finish_reason === 'string' ? payload.finish_reason : undefined,
    message: parseAssistantMessage(payload.message),
  };
}

function parseAssistantMessage(payload: unknown): Extract<OpenAIChatMessage, { role: 'assistant' }> {
  if (!isRecord(payload) || payload.role !== 'assistant') {
    throw new Error('OpenAI choice did not include an assistant message');
  }

  const message: Extract<OpenAIChatMessage, { role: 'assistant' }> = { role: 'assistant' };
  if (typeof payload.content === 'string' || payload.content === null) {
    message.content = payload.content;
  }

  const toolCalls = parseOpenAIToolCalls(payload.tool_calls);
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return message;
}

function parseOpenAIToolCalls(payload: unknown): OpenAIToolCall[] {
  if (payload === undefined || payload === null) return [];
  if (!Array.isArray(payload)) {
    throw new Error('OpenAI tool_calls was not an array');
  }
  return payload.map(parseOpenAIToolCall);
}

function parseOpenAIToolCall(payload: unknown): OpenAIToolCall {
  if (!isRecord(payload) || payload.type !== 'function' || typeof payload.id !== 'string' || !isRecord(payload.function)) {
    throw new Error('OpenAI tool call was malformed');
  }

  const fn = payload.function;
  if (typeof fn.name !== 'string') {
    throw new Error('OpenAI tool call function name was missing');
  }

  return {
    id: payload.id,
    type: 'function',
    function: {
      name: fn.name,
      arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}',
    },
  };
}

export function toProviderError(err: unknown): ProviderEvent {
  if (err instanceof ProviderRuntimeError) {
    return { type: 'error', message: err.message, retryable: err.retryable, classification: err.classification };
  }

  if (err instanceof OpenAIHttpError) {
    if (err.status === 401 || err.status === 403) {
      return { type: 'error', message: err.message, retryable: false, classification: 'auth' };
    }
    if (err.status === 429) {
      return { type: 'error', message: err.message, retryable: true };
    }
    if (err.status >= 500 && err.status <= 599) {
      return { type: 'error', message: err.message, retryable: true };
    }
    return { type: 'error', message: err.message, retryable: false };
  }

  if (err instanceof Error && err.name === 'AbortError') {
    return { type: 'error', message: err.message, retryable: true };
  }

  if (err instanceof TypeError) {
    return { type: 'error', message: err.message, retryable: true };
  }

  return { type: 'error', message: err instanceof Error ? err.message : String(err), retryable: false };
}

function getEnv(env: Record<string, string | undefined> | undefined, key: string): string | undefined {
  const value = env?.[key] ?? process.env[key];
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json = JSON.stringify(value, null, 2);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

registerProvider('openai', (opts) => new OpenAIProvider(opts));
