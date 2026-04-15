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
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { recordTokenUsage } from './db.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import {
  createStreamState,
  translateRequest,
  translateResponse,
  translateSSEChunk,
} from './openai-translator.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  // Detect if upstream is an OpenAI-compatible endpoint
  const upstreamRaw = secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const isOpenAI =
    upstreamRaw.includes('openai.com') ||
    upstreamRaw.includes('localhost:11434') ||
    !!secrets.OPENAI_API_KEY;
  const openaiApiKey = secrets.OPENAI_API_KEY;

  const upstreamUrl = new URL(
    isOpenAI && !secrets.ANTHROPIC_BASE_URL
      ? 'https://api.openai.com'
      : upstreamRaw,
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // Extract attribution query params (container, group) from the URL
      // and strip them before forwarding upstream
      const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
      const containerName =
        parsedUrl.searchParams.get('container') || 'unknown';
      const groupFolder = parsedUrl.searchParams.get('group') || 'unknown';
      parsedUrl.searchParams.delete('container');
      parsedUrl.searchParams.delete('group');
      const upstreamPath =
        parsedUrl.pathname +
        (parsedUrl.searchParams.size > 0
          ? `?${parsedUrl.searchParams.toString()}`
          : '');

      if (isOpenAI) {
        logger.debug(
          { method: req.method, path: upstreamPath },
          'Proxy request',
        );
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks);

        // In OpenAI mode, intercept non-messages API calls from the SDK
        if (isOpenAI) {
          if (upstreamPath.includes('/api/oauth/')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ api_key: 'openai-mode-no-exchange' }));
            return;
          }
          // Check if non-/v1/messages requests are actually messages calls
          // (SDK may send to root or other paths depending on URL construction)
          if (!upstreamPath.startsWith('/v1/messages')) {
            // Log what we're getting so we can debug
            const bodyPreview = rawBody.toString().slice(0, 500);
            const looksLikeMessages =
              bodyPreview.includes('"messages"') &&
              bodyPreview.includes('"model"');
            if (looksLikeMessages) {
              logger.info(
                { path: upstreamPath },
                'OpenAI mode: treating as messages request (body contains messages+model)',
              );
              // Fall through to normal translation below
            } else {
              logger.debug(
                { path: upstreamPath, bodyPreview },
                'OpenAI mode: stubbing non-messages request',
              );
              res.writeHead(404, { 'content-type': 'application/json' });
              res.end(
                JSON.stringify({
                  type: 'error',
                  error: {
                    type: 'not_found_error',
                    message: 'Not available in OpenAI proxy mode',
                  },
                }),
              );
              return;
            }
          }
        }

        // Determine if this is a Messages API call that needs translation
        // The SDK may send to /v1/messages or to / depending on URL construction
        const bodyStr = rawBody.toString();
        const isMessagesCall =
          isOpenAI &&
          (upstreamPath.includes('/v1/messages') ||
            (bodyStr.includes('"messages"') && bodyStr.includes('"model"')));

        let body: Buffer;
        let targetPath: string;
        let originalModel = '';

        if (isMessagesCall) {
          // Translate Anthropic Messages API → OpenAI Chat Completions
          try {
            const translated = translateRequest(
              bodyStr,
              secrets.OPENAI_MODEL || undefined,
            );
            body = Buffer.from(translated.openaiBody);
            originalModel = translated.originalModel;
            targetPath = '/v1/chat/completions';
            logger.debug(
              { originalModel, targetModel: secrets.OPENAI_MODEL, targetPath },
              'Translated Anthropic → OpenAI request',
            );
          } catch (err) {
            logger.error(
              { err },
              'Failed to translate request to OpenAI format',
            );
            res.writeHead(500);
            res.end('Translation error');
            return;
          }
        } else {
          body = rawBody;
          targetPath = upstreamPath;
        }

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (isOpenAI && openaiApiKey) {
          // OpenAI mode: inject Bearer token
          delete headers['x-api-key'];
          delete headers['authorization'];
          delete headers['anthropic-version'];
          delete headers['anthropic-beta'];
          headers['authorization'] = `Bearer ${openaiApiKey}`;
          headers['content-type'] = 'application/json';
        } else if (authMode === 'api-key') {
          // Anthropic API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: targetPath,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            const contentType = upRes.headers['content-type'] || '';
            const isSSE = contentType.includes('text/event-stream');
            const isJSON = contentType.includes('application/json');

            if (isMessagesCall && isSSE) {
              // OpenAI SSE → Anthropic SSE translation
              const state = createStreamState(originalModel);
              res.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                connection: 'keep-alive',
              });

              let buffer = '';
              upRes.on('data', (chunk: Buffer) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep incomplete line
                for (const line of lines) {
                  const trimmed = line.trim();
                  if (!trimmed) continue;
                  const anthropicEvents = translateSSEChunk(trimmed, state);
                  for (const event of anthropicEvents) {
                    res.write(event + '\n');
                  }
                }
              });
              upRes.on('end', () => {
                // Process remaining buffer
                if (buffer.trim()) {
                  const anthropicEvents = translateSSEChunk(
                    buffer.trim(),
                    state,
                  );
                  for (const event of anthropicEvents) {
                    res.write(event + '\n');
                  }
                }
                res.end();
                try {
                  if (state.inputTokens > 0 || state.outputTokens > 0) {
                    recordTokenUsage({
                      container_name: containerName,
                      group_folder: groupFolder,
                      model: originalModel,
                      input_tokens: state.inputTokens,
                      output_tokens: state.outputTokens,
                      cache_read_input_tokens: 0,
                      cache_creation_input_tokens: 0,
                    });
                  }
                } catch {
                  // Never let token tracking break the proxy
                }
              });
            } else if (isMessagesCall && isJSON) {
              // OpenAI JSON → Anthropic JSON translation
              const jsonChunks: Buffer[] = [];
              upRes.on('data', (c: Buffer) => jsonChunks.push(c));
              upRes.on('end', () => {
                const openaiResponse = Buffer.concat(jsonChunks).toString();
                logger.debug(
                  {
                    statusCode: upRes.statusCode,
                    responsePreview: openaiResponse.slice(0, 500),
                  },
                  'OpenAI JSON response received',
                );
                try {
                  const anthropicResponse = translateResponse(
                    openaiResponse,
                    originalModel,
                  );
                  res.writeHead(200, {
                    'content-type': 'application/json',
                  });
                  res.end(anthropicResponse);
                  try {
                    extractTokensFromJSON(
                      anthropicResponse,
                      containerName,
                      groupFolder,
                    );
                  } catch {
                    // Never let token tracking break the proxy
                  }
                } catch (err) {
                  logger.error({ err }, 'Failed to translate OpenAI response');
                  res.writeHead(502);
                  res.end('Translation error');
                }
              });
            } else if (isSSE) {
              // Native Anthropic SSE — stream through with token extraction
              res.writeHead(upRes.statusCode!, upRes.headers);
              const sseChunks: Buffer[] = [];
              upRes.on('data', (chunk: Buffer) => {
                sseChunks.push(chunk);
                res.write(chunk);
              });
              upRes.on('end', () => {
                res.end();
                try {
                  extractTokensFromSSE(
                    Buffer.concat(sseChunks).toString(),
                    containerName,
                    groupFolder,
                  );
                } catch {
                  // Never let token tracking break the proxy
                }
              });
            } else if (isJSON) {
              // Native Anthropic JSON — buffer, extract tokens, forward
              const jsonChunks: Buffer[] = [];
              upRes.on('data', (c: Buffer) => jsonChunks.push(c));
              upRes.on('end', () => {
                const responseBody = Buffer.concat(jsonChunks);
                res.writeHead(upRes.statusCode!, upRes.headers);
                res.end(responseBody);
                try {
                  extractTokensFromJSON(
                    responseBody.toString(),
                    containerName,
                    groupFolder,
                  );
                } catch {
                  // Never let token tracking break the proxy
                }
              });
            } else {
              // Other content types: pipe straight through
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
            }
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
      logger.info(
        {
          port,
          host,
          authMode,
          openaiMode: isOpenAI,
          upstream: upstreamUrl.hostname,
        },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}

function extractTokensFromJSON(
  body: string,
  containerName: string,
  groupFolder: string,
): void {
  const parsed = JSON.parse(body);
  if (!parsed.usage) return;
  recordTokenUsage({
    container_name: containerName,
    group_folder: groupFolder,
    model: parsed.model || null,
    input_tokens: parsed.usage.input_tokens || 0,
    output_tokens: parsed.usage.output_tokens || 0,
    cache_read_input_tokens: parsed.usage.cache_read_input_tokens || 0,
    cache_creation_input_tokens: parsed.usage.cache_creation_input_tokens || 0,
  });
}

function extractTokensFromSSE(
  data: string,
  containerName: string,
  groupFolder: string,
): void {
  // Claude API streaming: message_start has input token counts,
  // message_delta has output token counts. Collect both.
  let model: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  for (const line of data.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const jsonStr = line.slice(6);
    if (jsonStr === '[DONE]') continue;
    try {
      const event = JSON.parse(jsonStr);
      if (event.type === 'message_start' && event.message) {
        model = event.message.model || model;
        if (event.message.usage) {
          inputTokens = event.message.usage.input_tokens || 0;
          cacheReadTokens = event.message.usage.cache_read_input_tokens || 0;
          cacheCreationTokens =
            event.message.usage.cache_creation_input_tokens || 0;
        }
      }
      if (event.type === 'message_delta' && event.usage) {
        outputTokens = event.usage.output_tokens || 0;
      }
    } catch {
      // Skip unparseable lines
    }
  }

  if (inputTokens > 0 || outputTokens > 0) {
    recordTokenUsage({
      container_name: containerName,
      group_folder: groupFolder,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: cacheCreationTokens,
    });
  }
}
