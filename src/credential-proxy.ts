/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

function isOpenRouterHostname(hostname: string): boolean {
  return /(^|\.)openrouter\.ai$/i.test(hostname);
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function isOpenRouterAuthTarget(
  upstreamUrl: URL,
): boolean {
  return isOpenRouterHostname(upstreamUrl.hostname);
}

function isOpenRouterTranslationTarget(
  upstreamUrl: URL,
  secrets: Record<string, string>,
): boolean {
  if (isOpenRouterAuthTarget(upstreamUrl)) return true;
  // Allow local test/proxy setups that emulate OpenRouter while still requiring
  // explicit OpenRouter credentials to avoid false positives on Anthropic.
  return isLocalHost(upstreamUrl.hostname) && Boolean(secrets.OPENROUTER_API_KEY);
}

function resolveAuthMode(
  upstreamUrl: URL,
  secrets: Record<string, string>,
): AuthMode {
  const hasAnthropicKey = Boolean(secrets.ANTHROPIC_API_KEY);
  const hasOpenRouterKey = Boolean(secrets.OPENROUTER_API_KEY);
  if (hasAnthropicKey) return 'api-key';
  if (hasOpenRouterKey && isOpenRouterAuthTarget(upstreamUrl)) {
    return 'api-key';
  }
  return 'oauth';
}

function buildUpstreamPath(upstream: URL, incomingPath: string): string {
  const basePath = upstream.pathname?.replace(/\/+$/, '') || '';
  const reqPath = incomingPath.startsWith('/') ? incomingPath : `/${incomingPath}`;
  if (!basePath || basePath === '/') return reqPath;
  return `${basePath}${reqPath}`;
}

function buildForwardHeaders(
  reqHeaders: IncomingMessage['headers'],
  upstreamUrl: URL,
  bodyLength: number,
  authMode: AuthMode,
  secrets: Record<string, string>,
): Record<string, string | number | string[] | undefined> {
  const headers: Record<string, string | number | string[] | undefined> = {
    ...(reqHeaders as Record<string, string>),
    host: upstreamUrl.host,
    'content-length': bodyLength,
  };

  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];

  if (authMode === 'api-key') {
    delete headers['x-api-key'];
    const apiKey = isOpenRouterTranslationTarget(upstreamUrl, secrets)
      ? secrets.OPENROUTER_API_KEY || secrets.ANTHROPIC_API_KEY
      : secrets.ANTHROPIC_API_KEY || secrets.OPENROUTER_API_KEY;
    if (apiKey) {
      headers['x-api-key'] = apiKey;
    }
  } else if (headers['authorization']) {
    const oauthToken =
      secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
    delete headers['authorization'];
    if (oauthToken) {
      headers['authorization'] = `Bearer ${oauthToken}`;
    }
  }

  return headers;
}

function safeJsonParse(body: Buffer): JsonObject | null {
  try {
    return JSON.parse(body.toString('utf-8')) as JsonObject;
  } catch {
    return null;
  }
}

function isOpenRouterUpstream(
  upstreamUrl: URL,
  secrets: Record<string, string>,
): boolean {
  return isOpenRouterTranslationTarget(upstreamUrl, secrets);
}

function isMessagesEndpoint(url: string | undefined): boolean {
  return /^\/v1\/messages(?:\?.*)?$/.test(url || '');
}

function getProviderFromModel(model: string): string | null {
  const slashIndex = model.indexOf('/');
  if (slashIndex <= 0) return null;
  return model.slice(0, slashIndex);
}

function shouldTranslateToOpenRouterChat(
  req: IncomingMessage,
  body: JsonObject | null,
  upstreamUrl: URL,
  secrets: Record<string, string>,
): body is JsonObject {
  if (!isMessagesEndpoint(req.url) || req.method !== 'POST' || !body) return false;
  if (!isOpenRouterUpstream(upstreamUrl, secrets)) return false;

  const model = typeof body.model === 'string' ? body.model : '';
  if (!model || model.startsWith('anthropic/')) return false;

  return Boolean(getProviderFromModel(model));
}

function normalizeContentBlocks(content: JsonValue | undefined): JsonObject[] {
  if (typeof content === 'string') {
    return content ? [{ type: 'text', text: content }] : [];
  }
  return Array.isArray(content)
    ? content.filter((item): item is JsonObject => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

function stringifyTextContent(content: JsonValue | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
      if (item.type === 'text' && typeof item.text === 'string') return item.text;
      return '';
    })
    .join('');
}

function stringifyToolResultContent(content: JsonValue | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return stringifyTextContent(content);
  if (content && typeof content === 'object') return JSON.stringify(content);
  return '';
}

function convertAnthropicMessagesToOpenRouter(body: JsonObject): JsonObject[] {
  const messages: JsonObject[] = [];

  const systemText = stringifyTextContent(body.system);
  if (systemText) {
    messages.push({ role: 'system', content: systemText });
  }

  const anthropicMessages = Array.isArray(body.messages) ? body.messages : [];
  for (const entry of anthropicMessages) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const role = entry.role;
    if (role !== 'user' && role !== 'assistant') continue;

    const blocks = normalizeContentBlocks(entry.content);
    if (role === 'assistant') {
      const textParts: string[] = [];
      const toolCalls: JsonObject[] = [];

      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
          continue;
        }

        if (block.type === 'tool_use' && typeof block.name === 'string') {
          toolCalls.push({
            id: typeof block.id === 'string' ? block.id : `tool_${toolCalls.length}`,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(
                block.input && typeof block.input === 'object' ? block.input : {},
              ),
            },
          });
        }
      }

      if (textParts.length > 0 || toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: textParts.join('') || null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
      continue;
    }

    let pendingText = '';
    const flushUserText = () => {
      if (!pendingText) return;
      messages.push({ role: 'user', content: pendingText });
      pendingText = '';
    };

    if (blocks.length === 0 && typeof entry.content === 'string' && entry.content) {
      messages.push({ role: 'user', content: entry.content });
      continue;
    }

    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        pendingText += block.text;
        continue;
      }

      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        flushUserText();
        messages.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: stringifyToolResultContent(block.content),
        });
      }
    }

    flushUserText();
  }

  return messages;
}

function convertAnthropicToolChoice(
  toolChoice: JsonValue | undefined,
): JsonValue | undefined {
  if (!toolChoice || typeof toolChoice !== 'object' || Array.isArray(toolChoice)) {
    return toolChoice;
  }

  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'tool' && typeof toolChoice.name === 'string') {
    return {
      type: 'function',
      function: { name: toolChoice.name },
    };
  }

  return toolChoice;
}

function compactObject(object: Record<string, JsonValue | undefined>): JsonObject {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined),
  ) as JsonObject;
}

function buildOpenRouterChatBody(body: JsonObject): JsonObject {
  const model = body.model as string;
  const provider = getProviderFromModel(model);

  return compactObject({
    model,
    messages: convertAnthropicMessagesToOpenRouter(body),
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    top_k: body.top_k,
    stop: body.stop_sequences,
    tools: Array.isArray(body.tools)
      ? body.tools.map((tool) => {
          if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
          return compactObject({
            type: 'function',
            function: compactObject({
              name: tool.name,
              description: tool.description,
              parameters:
                tool.input_schema && typeof tool.input_schema === 'object'
                  ? (tool.input_schema as JsonObject)
                  : undefined,
            }),
          });
        })
      : undefined,
    tool_choice: convertAnthropicToolChoice(body.tool_choice),
    provider: provider
      ? {
          only: [provider],
          allow_fallbacks: false,
        }
      : undefined,
    stream: false,
  });
}

function parseToolArguments(argumentsText: unknown): JsonValue {
  if (typeof argumentsText !== 'string' || !argumentsText) return {};
  try {
    return JSON.parse(argumentsText) as JsonValue;
  } catch {
    return {};
  }
}

function mapFinishReason(reason: unknown): string | null {
  switch (reason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
      return 'end_turn';
    default:
      return null;
  }
}

function convertOpenRouterResponseToAnthropic(body: JsonObject): JsonObject {
  const choice = Array.isArray(body.choices) && body.choices[0] && typeof body.choices[0] === 'object'
    ? (body.choices[0] as JsonObject)
    : {};
  const message =
    choice.message && typeof choice.message === 'object' && !Array.isArray(choice.message)
      ? (choice.message as JsonObject)
      : {};
  const contentBlocks: JsonObject[] = [];

  if (typeof message.content === 'string' && message.content) {
    contentBlocks.push({ type: 'text', text: message.content });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const toolCall of message.tool_calls) {
      if (!toolCall || typeof toolCall !== 'object' || Array.isArray(toolCall)) continue;
      const fn =
        toolCall.function && typeof toolCall.function === 'object' && !Array.isArray(toolCall.function)
          ? (toolCall.function as JsonObject)
          : {};
      if (typeof fn.name !== 'string') continue;
      contentBlocks.push({
        type: 'tool_use',
        id: typeof toolCall.id === 'string' ? toolCall.id : `tool_${contentBlocks.length}`,
        name: fn.name,
        input: parseToolArguments(fn.arguments),
      });
    }
  }

  const usage =
    body.usage && typeof body.usage === 'object' && !Array.isArray(body.usage)
      ? (body.usage as JsonObject)
      : {};

  return {
    id: typeof body.id === 'string' ? body.id : `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model: typeof body.model === 'string' ? body.model : 'unknown',
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens:
        typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
      output_tokens:
        typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
    },
  };
}

function writeSseEvent(
  res: ServerResponse,
  event: string,
  payload: JsonObject,
): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeAnthropicStreamingResponse(
  res: ServerResponse,
  anthropicMessage: JsonObject,
): void {
  const content = Array.isArray(anthropicMessage.content)
    ? anthropicMessage.content.filter(
        (block): block is JsonObject => Boolean(block && typeof block === 'object' && !Array.isArray(block)),
      )
    : [];
  const usage =
    anthropicMessage.usage && typeof anthropicMessage.usage === 'object' && !Array.isArray(anthropicMessage.usage)
      ? (anthropicMessage.usage as JsonObject)
      : {};

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  writeSseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      ...anthropicMessage,
      content: [],
      usage: {
        input_tokens:
          typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
        output_tokens: 0,
      },
    },
  });

  content.forEach((block, index) => {
    if (block.type === 'text') {
      writeSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      if (typeof block.text === 'string' && block.text) {
        writeSseEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        });
      }
      writeSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index,
      });
      return;
    }

    if (block.type === 'tool_use') {
      writeSseEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      });
      writeSseEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(
            block.input && typeof block.input === 'object' ? block.input : {},
          ),
        },
      });
      writeSseEvent(res, 'content_block_stop', {
        type: 'content_block_stop',
        index,
      });
    }
  });

  writeSseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: anthropicMessage.stop_reason,
      stop_sequence: null,
    },
    usage: {
      output_tokens:
        typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
    },
  });
  writeSseEvent(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function forwardRequest(
  makeRequest: typeof httpsRequest | typeof httpRequest,
  options: RequestOptions,
  body: Buffer,
): Promise<{ statusCode: number; headers: IncomingMessage['headers']; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const upstream = makeRequest(options, (upRes) => {
      const chunks: Buffer[] = [];
      upRes.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      upRes.on('end', () => {
        resolve({
          statusCode: upRes.statusCode || 500,
          headers: upRes.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    upstream.on('error', reject);
    upstream.write(body);
    upstream.end();
  });
}

async function handleTranslatedOpenRouterRequest(
  req: IncomingMessage,
  res: ServerResponse,
  makeRequest: typeof httpsRequest | typeof httpRequest,
  upstreamUrl: URL,
  authMode: AuthMode,
  secrets: Record<string, string>,
  bodyJson: JsonObject,
): Promise<void> {
  const translatedBody = Buffer.from(
    JSON.stringify(buildOpenRouterChatBody(bodyJson)),
    'utf-8',
  );
  const headers = buildForwardHeaders(
    req.headers,
    upstreamUrl,
    translatedBody.length,
    authMode,
    secrets,
  );
  delete headers['anthropic-version'];
  delete headers['anthropic-beta'];
  // Ensure upstream returns plain JSON so translation can parse safely.
  delete headers['accept-encoding'];
  headers['accept-encoding'] = 'identity';

  const upstreamResponse = await forwardRequest(
    makeRequest,
    {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? 443 : 80),
      path: buildUpstreamPath(upstreamUrl, '/v1/chat/completions'),
      method: 'POST',
      headers,
    } as RequestOptions,
    translatedBody,
  );

  if (upstreamResponse.statusCode >= 400) {
    res.writeHead(upstreamResponse.statusCode, upstreamResponse.headers);
    res.end(upstreamResponse.body);
    return;
  }

  const translatedResponse = convertOpenRouterResponseToAnthropic(
    JSON.parse(upstreamResponse.body.toString('utf-8')) as JsonObject,
  );
  const wantsStream = bodyJson.stream === true;
  if (wantsStream) {
    writeAnthropicStreamingResponse(res, translatedResponse);
    return;
  }

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(translatedResponse));
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const authMode = resolveAuthMode(upstreamUrl, secrets);
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const bodyJson = safeJsonParse(body);

        if (shouldTranslateToOpenRouterChat(req, bodyJson, upstreamUrl, secrets)) {
          handleTranslatedOpenRouterRequest(
            req,
            res,
            makeRequest,
            upstreamUrl,
            authMode,
            secrets,
            bodyJson,
          ).catch((err) => {
            logger.error({ err, url: req.url }, 'Credential proxy translation error');
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });
          return;
        }

        const headers = buildForwardHeaders(
          req.headers,
          upstreamUrl,
          body.length,
          authMode,
          secrets,
        );

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: buildUpstreamPath(upstreamUrl, req.url || '/'),
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'OPENROUTER_API_KEY',
    'ANTHROPIC_BASE_URL',
  ]);
  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  return resolveAuthMode(upstreamUrl, secrets);
}
