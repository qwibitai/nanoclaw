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

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

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
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

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

  return listenWithRetry(server, port, host, authMode);
}

const MAX_RETRIES = 10;
const BASE_DELAY_MS = 1000;

/** Retry listen() on EADDRINUSE with exponential backoff (up to ~30s total). */
function listenWithRetry(
  server: Server,
  port: number,
  host: string,
  authMode: AuthMode,
  attempt = 0,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, Math.min(attempt, 4));
        logger.warn(
          { port, attempt: attempt + 1, maxRetries: MAX_RETRIES, retryInMs: delay },
          'Port in use, retrying...',
        );
        setTimeout(() => {
          resolve(listenWithRetry(server, port, host, authMode, attempt + 1));
        }, delay);
      } else {
        reject(err);
      }
    };

    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
