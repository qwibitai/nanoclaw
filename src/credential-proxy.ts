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
 * OAuth token refresh:
 *   On macOS, reads fresh tokens directly from the Keychain when .env
 *   value is stale. This avoids manual token rotation.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

/**
 * Re-read OAuth token on each request (with short TTL cache).
 * On macOS, falls back to reading directly from the Keychain when
 * the .env token is missing or has been invalidated by a 401.
 */
const TOKEN_CACHE_TTL_MS = 30_000; // 30 seconds
let cachedOAuthToken: string | undefined;
let tokenCacheTime = 0;
let lastTokenInvalid = false;

/** Try to read fresh OAuth token from macOS Keychain (no shell injection risk). */
function readTokenFromKeychain(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    const raw = execFileSync(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { timeout: 5000, encoding: 'utf-8' },
    ).trim();
    if (!raw) return undefined;
    const creds = JSON.parse(raw) as Record<string, unknown>;
    const oauth = creds?.claudeAiOauth as
      | { accessToken?: string }
      | undefined;
    return oauth?.accessToken ?? undefined;
  } catch {
    return undefined;
  }
}

/** Sync Keychain token back to .env files (best-effort). */
function syncTokenToEnvFile(token: string): void {
  const envPaths = [
    path.join(process.cwd(), '.env'),
    path.join(process.cwd(), 'data', 'env', 'env'),
  ];
  for (const envPath of envPaths) {
    try {
      let content = fs.readFileSync(envPath, 'utf-8');
      if (content.includes('CLAUDE_CODE_OAUTH_TOKEN=')) {
        content = content.replace(
          /^CLAUDE_CODE_OAUTH_TOKEN=.*/m,
          `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
        );
        fs.writeFileSync(envPath, content);
      }
    } catch {
      // File may not exist — that's fine
    }
  }
}

function getFreshOAuthToken(): string | undefined {
  const now = Date.now();
  if (
    cachedOAuthToken &&
    !lastTokenInvalid &&
    now - tokenCacheTime < TOKEN_CACHE_TTL_MS
  ) {
    return cachedOAuthToken;
  }

  // First try .env file
  const fresh = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
  let token: string | undefined =
    fresh.CLAUDE_CODE_OAUTH_TOKEN || fresh.ANTHROPIC_AUTH_TOKEN || undefined;

  // If .env token was previously invalid (401) or missing, try Keychain
  if (!token || lastTokenInvalid) {
    const keychainToken = readTokenFromKeychain();
    if (keychainToken && keychainToken !== token) {
      logger.info('OAuth token refreshed from Keychain');
      token = keychainToken;
      syncTokenToEnvFile(token);
    }
  }

  cachedOAuthToken = token;
  tokenCacheTime = now;
  lastTokenInvalid = false;
  return cachedOAuthToken;
}

/** Mark current cached token as invalid (e.g., after a 401 response). */
function invalidateCachedToken(): void {
  lastTokenInvalid = true;
  tokenCacheTime = 0;
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
          // OAuth mode: replace placeholder Bearer token with the real one
          // only when the container actually sends an Authorization header
          // (exchange request + auth probes). Post-exchange requests use
          // x-api-key only, so they pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            const freshToken = getFreshOAuthToken();
            if (freshToken) {
              headers['authorization'] = `Bearer ${freshToken}`;
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
            // On 401, invalidate cached token so the next request
            // will attempt to read a fresh one from the Keychain.
            if (upRes.statusCode === 401 && authMode === 'oauth') {
              invalidateCachedToken();
              logger.warn(
                'Upstream returned 401 — cached OAuth token invalidated, will refresh on next request',
              );
            }
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
