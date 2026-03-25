/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Primary: OAuth (Max plan).
 * Fallback: If upstream returns 429 (rate limit) and an API key is
 *           configured, retries with API key + claude-haiku-4-5-20251001.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

const FALLBACK_MODEL = 'claude-haiku-4-5-20251001';

export interface NanoClawHandlers {
  getInviteLink?: (jid: string) => Promise<string | null>;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
  handlers: NanoClawHandlers = {},
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  // Primary: OAuth (Max plan). Fallback to API key only if no OAuth token.
  const authMode: AuthMode =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN
      ? 'oauth'
      : secrets.ANTHROPIC_API_KEY
        ? 'api-key'
        : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
  const canFallback = authMode === 'oauth' && !!secrets.ANTHROPIC_API_KEY;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  function buildUpstreamOpts(
    reqUrl: string | undefined,
    method: string | undefined,
    headers: Record<string, string | number | string[] | undefined>,
  ): RequestOptions {
    return {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (isHttps ? 443 : 80),
      path: reqUrl,
      method,
      headers,
    };
  }

  function injectOAuth(
    headers: Record<string, string | number | string[] | undefined>,
    reqUrl: string | undefined,
  ): void {
    const isExchange = reqUrl?.includes('/api/oauth/claude_cli/create_api_key');
    if (isExchange || headers['authorization']) {
      delete headers['x-api-key'];
      delete headers['authorization'];
      if (oauthToken) {
        headers['authorization'] = `Bearer ${oauthToken}`;
      }
    }
  }

  function injectApiKey(
    headers: Record<string, string | number | string[] | undefined>,
  ): void {
    delete headers['x-api-key'];
    delete headers['authorization'];
    headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
  }

  function swapModelInBody(body: Buffer): Buffer {
    try {
      const parsed = JSON.parse(body.toString());
      if (parsed.model) {
        parsed.model = FALLBACK_MODEL;
        return Buffer.from(JSON.stringify(parsed));
      }
    } catch {
      // Not JSON or no model field — send as-is
    }
    return body;
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // NanoClaw internal endpoints (not proxied to Anthropic)
      if (req.url?.startsWith('/nanoclaw/')) {
        const url = new URL(req.url, `http://${req.headers.host}`);

        if (url.pathname === '/nanoclaw/invite-link' && req.method === 'GET') {
          const jid = url.searchParams.get('jid');
          if (!jid || !handlers.getInviteLink) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({ error: 'Missing jid or handler not ready' }),
            );
            return;
          }
          handlers
            .getInviteLink(jid)
            .then((link) => {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ link }));
            })
            .catch((err) => {
              logger.error({ err, jid }, 'Error getting invite link');
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Internal error' }));
            });
          return;
        }

        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const baseHeaders: Record<
          string,
          string | number | string[] | undefined
        > = {
          ...(req.headers as Record<string, string>),
          host: upstreamUrl.host,
          'content-length': body.length,
        };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete baseHeaders['connection'];
        delete baseHeaders['keep-alive'];
        delete baseHeaders['transfer-encoding'];

        const headers = { ...baseHeaders };

        if (authMode === 'api-key') {
          injectApiKey(headers);
        } else {
          injectOAuth(headers, req.url);
        }

        // Determine if this is a retryable request (messages endpoint, not exchange)
        const isMessagesEndpoint =
          req.url?.includes('/v1/messages') && req.method === 'POST';
        const shouldRetryOn429 = canFallback && isMessagesEndpoint;

        if (!shouldRetryOn429) {
          // No fallback possible — pipe directly (fast path)
          const upstream = makeRequest(
            buildUpstreamOpts(req.url, req.method, headers),
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
          return;
        }

        // Retryable path — buffer response to check for 429
        const upstream = makeRequest(
          buildUpstreamOpts(req.url, req.method, headers),
          (upRes) => {
            if (upRes.statusCode !== 429) {
              // Not rate limited — forward normally
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
              return;
            }

            // Rate limited — consume the response and retry with API key + Haiku
            const discardChunks: Buffer[] = [];
            upRes.on('data', (c) => discardChunks.push(c));
            upRes.on('end', () => {
              logger.warn(
                { url: req.url, fallbackModel: FALLBACK_MODEL },
                'Rate limited on OAuth, retrying with API key + Haiku',
              );

              const fallbackBody = swapModelInBody(body);
              const fallbackHeaders = { ...baseHeaders };
              injectApiKey(fallbackHeaders);
              fallbackHeaders['content-length'] = fallbackBody.length;

              const retry = makeRequest(
                buildUpstreamOpts(req.url, req.method, fallbackHeaders),
                (retryRes) => {
                  res.writeHead(retryRes.statusCode!, retryRes.headers);
                  retryRes.pipe(res);
                },
              );
              retry.on('error', (err) => {
                logger.error(
                  { err, url: req.url },
                  'Credential proxy fallback upstream error',
                );
                if (!res.headersSent) {
                  res.writeHead(502);
                  res.end('Bad Gateway');
                }
              });
              retry.write(fallbackBody);
              retry.end();
            });
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
        { port, host, authMode, canFallback },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
  return secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN
    ? 'oauth'
    : secrets.ANTHROPIC_API_KEY
      ? 'api-key'
      : 'oauth';
}
