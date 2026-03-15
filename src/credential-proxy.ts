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

import { readEnvFile, refreshSecrets, isVaultConfigured } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

const CREDENTIAL_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
] as const;

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // On-demand vault refresh: fetch fresh credentials if vault is configured
        // and cache has expired (TTL-based, no-op when cache is fresh)
        const credentialPromise = isVaultConfigured()
          ? refreshSecrets([...CREDENTIAL_KEYS]).then(() =>
              readEnvFile([...CREDENTIAL_KEYS]),
            )
          : Promise.resolve(readEnvFile([...CREDENTIAL_KEYS]));

        credentialPromise
          .then((secrets) => {
            const authMode: AuthMode = secrets.ANTHROPIC_API_KEY
              ? 'api-key'
              : 'oauth';
            const oauthToken =
              secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

            const upstreamUrl = new URL(
              secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
            );
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

            if (authMode === 'api-key') {
              // API key mode: inject x-api-key on every request
              delete headers['x-api-key'];
              headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
            } else {
              // OAuth mode: replace placeholder Bearer token with the real one
              // only when the container actually sends an Authorization header
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
          })
          .catch((err) => {
            logger.error(
              { err },
              'Credential proxy failed to refresh secrets',
            );
            // Fall back to .env-based credentials
            const secrets = readEnvFile([...CREDENTIAL_KEYS]);
            forwardRequest(req, res, body, secrets);
          });
      });
    });

    server.listen(port, host, () => {
      const vaultStatus = isVaultConfigured()
        ? 'vault-backed'
        : 'env-file-only';
      const secrets = readEnvFile([...CREDENTIAL_KEYS]);
      const authMode: AuthMode = secrets.ANTHROPIC_API_KEY
        ? 'api-key'
        : 'oauth';
      logger.info(
        { port, host, authMode, credentialSource: vaultStatus },
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
  secrets: Record<string, string>,
): void {
  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
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

  if (authMode === 'api-key') {
    delete headers['x-api-key'];
    headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
  } else {
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
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
