/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    At startup, proxy exchanges the OAuth token for a temporary
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             The cached API key is then injected on /v1/ requests
 *             (same as API key mode). The proxy also replaces Authorization
 *             headers for containers that do their own exchange.
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

/** Exchange an OAuth token for a temporary API key. */
export async function exchangeOAuthToken(
  oauthToken: string,
  upstreamUrl: URL,
): Promise<string> {
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeReq = isHttps ? httpsRequest : httpRequest;
  const body = JSON.stringify({});

  return new Promise((resolve, reject) => {
    const req = makeReq(
      {
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || (isHttps ? 443 : 80),
        path: '/api/oauth/claude_cli/create_api_key',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${oauthToken}`,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(body),
        },
      } as RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            // The response may use "api_key" or "key"
            const apiKey = data.api_key || data.key;
            if (apiKey) {
              resolve(apiKey);
            } else {
              reject(
                new Error(
                  `OAuth exchange: no api_key in response: ${JSON.stringify(data)}`,
                ),
              );
            }
          } catch (err) {
            reject(err);
          }
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('OAuth exchange request timeout'));
    });
    req.write(body);
    req.end();
  });
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
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  // Cached API key from OAuth exchange (set at startup in OAuth mode)
  let cachedApiKey: string | undefined;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
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

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else if (cachedApiKey && req.url?.startsWith('/v1/')) {
          // OAuth mode with cached API key: inject like API key mode
          delete headers['x-api-key'];
          headers['x-api-key'] = cachedApiKey;
          // Remove any placeholder Authorization header
          delete headers['authorization'];
        } else {
          // OAuth mode without cached key, or non-/v1/ requests (e.g. exchange):
          // replace placeholder Bearer token with the real one
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
            path: req.url,
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

    server.listen(port, host, async () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');

      if (authMode === 'oauth' && oauthToken) {
        try {
          cachedApiKey = await exchangeOAuthToken(oauthToken, upstreamUrl);
          logger.info('OAuth token exchanged for temporary API key');
        } catch (err) {
          logger.warn(
            { err },
            'OAuth token exchange failed — containers can still do their own exchange',
          );
        }
      }

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
