/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Credentials are fetched on-demand from Solo Vault (with 5-minute TTL cache)
 * when SOLO_VAULT_TOKEN is configured. Falls back to .env injection otherwise.
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

import {
  applyCredentialHeaders,
  loadCredentialState,
  loadCredentialStateSync,
} from './credentials.js';
import { logger } from './logger.js';

export type { AuthMode } from './credentials.js';

export interface ProxyConfig {
  authMode: import('./credentials.js').AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        loadCredentialState()
          .then((credentialState) => {
            const upstreamUrl = new URL(credentialState.baseUrl);
            const isHttps = upstreamUrl.protocol === 'https:';
            const makeRequest = isHttps ? httpsRequest : httpRequest;

            const headers: Record<
              string,
              string | number | string[] | undefined
            > = {
              ...(req.headers as Record<string, string>),
              host: upstreamUrl.host,
              'content-length': body.length,
            };

            // Strip hop-by-hop headers that must not be forwarded by proxies
            delete headers['connection'];
            delete headers['keep-alive'];
            delete headers['transfer-encoding'];
            const upstreamHeaders = applyCredentialHeaders(
              headers,
              credentialState,
            );

            const upstream = makeRequest(
              {
                hostname: upstreamUrl.hostname,
                port: upstreamUrl.port || (isHttps ? 443 : 80),
                path: req.url,
                method: req.method,
                headers: upstreamHeaders,
              } as RequestOptions,
              (upRes) => {
                res.writeHead(upRes.statusCode!, upRes.headers);
                upRes.pipe(res).on('error', (err) => {
                  logger.error(
                    { err, url: req.url },
                    'Credential proxy response pipe error',
                  );
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
          })
          .catch((err) => {
            logger.error({ err }, 'Credential proxy failed to refresh secrets');
            forwardRequest(req, res, body, loadCredentialStateSync());
          });
      });
    });

    server.listen(port, host, () => {
      const credentialState = loadCredentialStateSync();
      logger.info(
        {
          port,
          host,
          authMode: credentialState.authMode,
          credentialSource: credentialState.credentialSource,
        },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Forward a request to the upstream Anthropic API with the given secrets. */
function forwardRequest(
  req: import('http').IncomingMessage,
  res: import('http').ServerResponse,
  body: Buffer,
  credentialState: import('./credentials.js').CredentialState,
): void {
  if (res.headersSent) return; // Guard against double-write from race with .then() path
  const upstreamUrl = new URL(credentialState.baseUrl);
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  const headers: Record<string, string | number | string[] | undefined> = {
    ...(req.headers as Record<string, string>),
    host: upstreamUrl.host,
    'content-length': body.length,
  };

  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['transfer-encoding'];
  const upstreamHeaders = applyCredentialHeaders(headers, credentialState);

  const upstream = makeRequest(
    {
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port || (isHttps ? 443 : 80),
      path: req.url,
      method: req.method,
      headers: upstreamHeaders,
    } as RequestOptions,
    (upRes) => {
      res.writeHead(upRes.statusCode!, upRes.headers);
      upRes.pipe(res).on('error', (err) => {
        logger.error(
          { err, url: req.url },
          'Credential proxy response pipe error',
        );
      });
    },
  );

  upstream.on('error', (err) => {
    logger.error({ err, url: req.url }, 'Credential proxy upstream error');
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });

  upstream.write(body);
  upstream.end();
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): import('./credentials.js').AuthMode {
  return loadCredentialStateSync().authMode;
}
