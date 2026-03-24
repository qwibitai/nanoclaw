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
 *
 * OAuth token refresh (fixes #730):
 *   When the proxy is in OAuth mode it now reads the token **on every
 *   request** instead of caching it once at startup.  Resolution order:
 *     1. ~/.claude/.credentials.json  (auto-refreshed by Claude CLI)
 *     2. .env  CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN
 *   This prevents overnight 401 errors caused by expired tokens.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

/**
 * Read the freshest OAuth token available on the host.
 *
 * Resolution order:
 *   1. ~/.claude/.credentials.json  – written & auto-refreshed by the
 *      Claude Code CLI.  The file contains `{ "accessToken": "…",
 *      "refreshToken": "…", "expiresAt": "…" }`.
 *   2. .env  CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN – static
 *      fallback for setups that don't use the CLI on the host.
 *
 * Exported for testing.
 */
export function getFreshOAuthToken(): string | undefined {
  // 1. Try ~/.claude/.credentials.json (auto-refreshed by Claude CLI)
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const raw = fs.readFileSync(credPath, 'utf-8');
    const creds = JSON.parse(raw) as {
      accessToken?: string;
      expiresAt?: string;
    };
    if (creds.accessToken) {
      // If expiresAt is present and the token is still valid (or will
      // be valid for at least 60 s), use it.  If parsing fails or the
      // field is absent, use the token optimistically — the CLI keeps
      // it refreshed in the background.
      if (creds.expiresAt) {
        const expiresMs = new Date(creds.expiresAt).getTime();
        if (expiresMs > Date.now() + 60_000) {
          logger.debug('Using OAuth token from ~/.claude/.credentials.json');
          return creds.accessToken;
        }
        // Token expired — fall through to .env
        logger.warn(
          'OAuth token in ~/.claude/.credentials.json is expired, falling back to .env',
        );
      } else {
        // No expiresAt field — use optimistically
        logger.debug(
          'Using OAuth token from ~/.claude/.credentials.json (no expiresAt)',
        );
        return creds.accessToken;
      }
    }
  } catch {
    // File does not exist or is unreadable — expected when the CLI is
    // not installed on the host.
  }

  // 2. Fallback: re-read .env on every call so manual edits are picked up
  const secrets = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
  return secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
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

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
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

        if (authMode === 'api-key') {
          // API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth mode: resolve a fresh token on every request so
          // expired tokens are automatically replaced (#730).
          if (headers['authorization']) {
            delete headers['authorization'];
            const freshToken = getFreshOAuthToken();
            if (freshToken) {
              headers['authorization'] = `Bearer ${freshToken}`;
            } else {
              logger.warn(
                'OAuth mode: no valid token available — request will likely fail with 401',
              );
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
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
