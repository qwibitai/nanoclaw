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
const TOKEN_CACHE_TTL_MS = 5_000; // 5 seconds — Keychain read is fast
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
        logger.info({ envPath }, 'Synced refreshed OAuth token to env file');
      }
    } catch (err) {
      logger.warn({ err, envPath }, 'Failed to sync OAuth token to env file');
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

  // On macOS, always prefer Keychain as the source of truth —
  // Claude Code continuously refreshes it, so .env goes stale quickly.
  let token: string | undefined;
  const keychainToken = readTokenFromKeychain();
  if (keychainToken) {
    token = keychainToken;
    if (lastTokenInvalid) {
      logger.info('OAuth token refreshed from Keychain');
      syncTokenToEnvFile(token);
    }
  }

  // Fallback to .env file (non-macOS or Keychain unavailable)
  if (!token) {
    const fresh = readEnvFile([
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_AUTH_TOKEN',
    ]);
    token =
      fresh.CLAUDE_CODE_OAUTH_TOKEN || fresh.ANTHROPIC_AUTH_TOKEN || undefined;
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
        const originalHeaders = req.headers as Record<string, string>;
        const hadAuthHeader = !!originalHeaders['authorization'];

        function buildHeaders(): Record<string, string | number | string[] | undefined> {
          const headers: Record<string, string | number | string[] | undefined> = {
            ...originalHeaders,
            host: upstreamUrl.host,
            'content-length': body.length,
          };
          delete headers['connection'];
          delete headers['keep-alive'];
          delete headers['transfer-encoding'];

          if (authMode === 'api-key') {
            delete headers['x-api-key'];
            headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
          } else if (hadAuthHeader) {
            delete headers['authorization'];
            const freshToken = getFreshOAuthToken();
            if (freshToken) {
              headers['authorization'] = `Bearer ${freshToken}`;
            }
          }
          return headers;
        }

        function forwardRequest(isRetry: boolean): void {
          const headers = buildHeaders();
          const upstream = makeRequest(
            {
              hostname: upstreamUrl.hostname,
              port: upstreamUrl.port || (isHttps ? 443 : 80),
              path: req.url,
              method: req.method,
              headers,
            } as RequestOptions,
            (upRes) => {
              // On 401 with OAuth + Authorization header: retry once
              // with a freshly-read token from the Keychain.
              if (
                upRes.statusCode === 401 &&
                authMode === 'oauth' &&
                hadAuthHeader &&
                !isRetry
              ) {
                // Drain the 401 response body before retrying
                upRes.resume();
                invalidateCachedToken();
                logger.warn(
                  'Upstream returned 401 — retrying with refreshed token from Keychain',
                );
                forwardRequest(true);
                return;
              }

              if (upRes.statusCode === 401 && authMode === 'oauth') {
                invalidateCachedToken();
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
        }

        forwardRequest(false);
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
