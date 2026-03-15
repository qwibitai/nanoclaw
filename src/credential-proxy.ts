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
 * OAuth tokens expire (~1 hour). The proxy auto-refreshes them using the
 * stored refresh token before they expire, so agents never see 401s.
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { homedir } from 'os';
import { join } from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** Refresh the token this many ms before it actually expires. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface OAuthCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  [key: string]: unknown;
}

/**
 * Read the full OAuth credential object from ~/.claude/.credentials.json
 * or fall back to the macOS keychain.
 */
function readFullOAuthCredentials(): OAuthCredentials | undefined {
  // Primary: credentials file written by Claude Code CLI
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    const data = JSON.parse(readFileSync(credPath, 'utf8'));
    const oauth = data?.claudeAiOauth;
    if (oauth?.accessToken) return oauth as OAuthCredentials;
  } catch {
    // fall through to keychain
  }

  // Fallback: macOS keychain
  if (process.platform !== 'darwin') return undefined;
  try {
    const raw = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    const data = JSON.parse(raw);
    const oauth = data?.claudeAiOauth;
    if (oauth?.accessToken) return oauth as OAuthCredentials;
  } catch {
    // not available
  }

  return undefined;
}

/**
 * Persist refreshed OAuth credentials back to ~/.claude/.credentials.json
 * so the next process restart picks up the new token.
 */
function saveOAuthCredentials(updated: OAuthCredentials): void {
  const credPath = join(homedir(), '.claude', '.credentials.json');
  try {
    let root: Record<string, unknown> = {};
    try {
      root = JSON.parse(readFileSync(credPath, 'utf8'));
    } catch {
      // file missing — start fresh
    }
    root.claudeAiOauth = {
      ...((root.claudeAiOauth as object) ?? {}),
      ...updated,
    };
    writeFileSync(credPath, JSON.stringify(root, null, 2));
  } catch (err) {
    logger.warn({ err }, 'Failed to persist refreshed OAuth token');
  }
}

/**
 * Exchange a refresh token for a new access token.
 * Returns the updated credentials, or undefined on failure.
 */
function refreshOAuthToken(
  refreshToken: string,
): Promise<OAuthCredentials | undefined> {
  return new Promise((resolve) => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OAUTH_CLIENT_ID,
    }).toString();

    const req = httpsRequest(
      {
        hostname: 'platform.claude.com',
        port: 443,
        path: '/v1/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (data.access_token) {
              const creds: OAuthCredentials = {
                accessToken: data.access_token,
                refreshToken: data.refresh_token ?? refreshToken,
                expiresAt: data.expires_in
                  ? Date.now() + data.expires_in * 1000
                  : undefined,
              };
              logger.info('OAuth token refreshed successfully');
              resolve(creds);
            } else {
              logger.error(
                { status: res.statusCode, data },
                'OAuth token refresh returned no access_token',
              );
              resolve(undefined);
            }
          } catch (err) {
            logger.error({ err }, 'Failed to parse OAuth refresh response');
            resolve(undefined);
          }
        });
      },
    );

    req.on('error', (err) => {
      logger.error({ err }, 'OAuth token refresh request failed');
      resolve(undefined);
    });

    req.write(body);
    req.end();
  });
}

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

  // Token cache: tracks the current access token AND its real expiry time.
  // When the token is within REFRESH_BUFFER_MS of expiry we trigger a refresh.
  const TOKEN_CACHE_TTL_MS = 30_000; // re-read from disk every 30 s at most
  interface TokenCache {
    value?: string;
    /** Wall-clock expiry of the cache entry (not the token itself). */
    cacheExpiresAt: number;
    /** Real expiry of the OAuth token, if known. */
    tokenExpiresAt?: number;
  }
  let tokenCache: TokenCache = { cacheExpiresAt: 0 };
  let refreshPromise: Promise<void> | null = null;

  const doRefresh = (refreshToken: string, now: number): Promise<void> => {
    refreshPromise = (async () => {
      const updated = await refreshOAuthToken(refreshToken);
      if (updated) {
        saveOAuthCredentials(updated);
        tokenCache = {
          value: updated.accessToken,
          cacheExpiresAt: now + TOKEN_CACHE_TTL_MS,
          tokenExpiresAt: updated.expiresAt,
        };
      }
      refreshPromise = null;
    })();
    return refreshPromise;
  };

  const ensureTokenFresh = async (): Promise<void> => {
    if (refreshPromise) return refreshPromise;

    const now = Date.now();

    // Always read from disk so we have an up-to-date expiresAt.
    // This is critical when the proxy falls back to the macOS keychain,
    // which does not include expiresAt — in that case we treat the token
    // as needing a refresh so the proxy can learn the real expiry.
    const creds = readFullOAuthCredentials();
    const tokenExpiry = creds?.expiresAt ?? tokenCache.tokenExpiresAt;

    if (
      creds?.refreshToken &&
      (tokenExpiry === undefined || now >= tokenExpiry - REFRESH_BUFFER_MS)
    ) {
      return doRefresh(creds.refreshToken, now);
    }
  };

  const getOauthToken = async (): Promise<string | undefined> => {
    if (secrets.CLAUDE_CODE_OAUTH_TOKEN) return secrets.CLAUDE_CODE_OAUTH_TOKEN;
    if (secrets.ANTHROPIC_AUTH_TOKEN) return secrets.ANTHROPIC_AUTH_TOKEN;

    const now = Date.now();

    // Re-read from disk if cache TTL elapsed, then refresh if needed.
    if (now >= tokenCache.cacheExpiresAt) {
      const creds = readFullOAuthCredentials();
      tokenCache = {
        value: creds?.accessToken,
        cacheExpiresAt: now + TOKEN_CACHE_TTL_MS,
        tokenExpiresAt: creds?.expiresAt,
      };
      // Refresh when expired, near-expiry, OR when expiresAt is unknown
      // (keychain fallback — the keychain doesn't store expiresAt).
      if (
        creds?.refreshToken &&
        (creds.expiresAt === undefined ||
          now >= creds.expiresAt - REFRESH_BUFFER_MS)
      ) {
        await ensureTokenFresh();
      }
    }

    return tokenCache.value;
  };

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
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
            const token = await getOauthToken();
            if (token) {
              headers['authorization'] = `Bearer ${token}`;
            }
          }
        }

        const forwardRequest = (
          hdrs: Record<string, string | number | string[] | undefined>,
          onResponse: (upRes: import('http').IncomingMessage) => void,
        ) => {
          const up = makeRequest(
            {
              hostname: upstreamUrl.hostname,
              port: upstreamUrl.port || (isHttps ? 443 : 80),
              path: req.url,
              method: req.method,
              headers: hdrs,
            } as RequestOptions,
            onResponse,
          );
          up.on('error', (err) => {
            logger.error(
              { err, url: req.url },
              'Credential proxy upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });
          up.write(body);
          up.end();
          return up;
        };

        forwardRequest(headers, async (upRes) => {
          // On 401, refresh the token and retry once (OAuth mode only).
          if (
            upRes.statusCode === 401 &&
            authMode === 'oauth' &&
            headers['authorization']
          ) {
            // Drain the 401 body so the socket is reusable.
            upRes.resume();
            logger.warn(
              { url: req.url },
              'Upstream 401 — refreshing OAuth token and retrying',
            );
            // Force-invalidate the cache so ensureTokenFresh will refresh.
            tokenCache = { cacheExpiresAt: 0 };
            await ensureTokenFresh();
            const newToken = tokenCache.value;
            const retryHeaders = { ...headers };
            if (newToken) {
              retryHeaders['authorization'] = `Bearer ${newToken}`;
            }
            forwardRequest(retryHeaders, (retryRes) => {
              res.writeHead(retryRes.statusCode!, retryRes.headers);
              retryRes.pipe(res);
            });
          } else {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          }
        });
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
