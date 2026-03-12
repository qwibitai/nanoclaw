/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Auth modes:
 *   api-key:    Proxy injects x-api-key (Anthropic direct).
 *   openrouter: Proxy injects Authorization: Bearer (OpenRouter gateway).
 *   oauth:      Container CLI exchanges placeholder for temp key; proxy
 *               injects real OAuth token on exchange requests.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth' | 'openrouter';

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
    'OPENROUTER_API_KEY',
  ]);

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isOpenRouter = upstreamUrl.hostname.includes('openrouter.ai');
  const openRouterKey =
    secrets.OPENROUTER_API_KEY ||
    secrets.ANTHROPIC_AUTH_TOKEN ||
    secrets.ANTHROPIC_API_KEY;

  let authMode: AuthMode;
  if ((secrets.OPENROUTER_API_KEY || (isOpenRouter && openRouterKey)) && openRouterKey) {
    authMode = 'openrouter';
  } else if (secrets.ANTHROPIC_API_KEY) {
    authMode = 'api-key';
  } else {
    authMode = 'oauth';
  }

  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

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

        if (authMode === 'openrouter') {
          // OpenRouter uses Authorization: Bearer, not x-api-key
          delete headers['x-api-key'];
          headers['authorization'] = `Bearer ${openRouterKey}`;
        } else if (authMode === 'api-key') {
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
    'ANTHROPIC_BASE_URL',
    'OPENROUTER_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isOpenRouter = upstreamUrl.hostname.includes('openrouter.ai');
  const openRouterKey =
    secrets.OPENROUTER_API_KEY ||
    secrets.ANTHROPIC_AUTH_TOKEN ||
    secrets.ANTHROPIC_API_KEY;
  if (
    (secrets.OPENROUTER_API_KEY || (isOpenRouter && openRouterKey)) &&
    openRouterKey
  ) {
    return 'openrouter';
  }
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
