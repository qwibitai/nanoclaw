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
 * OAuth tokens are sourced from (in priority order):
 *   1. CLAUDE_CODE_OAUTH_TOKEN in .env (access or refresh token)
 *   2. ANTHROPIC_AUTH_TOKEN in .env
 *   3. ~/.claude/.credentials.json (written by `claude login`)
 *
 * Refresh tokens (sk-ant-ort01-*) are automatically exchanged for
 * short-lived access tokens and refreshed before expiry.
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

// --- OAuth token management ---

const OAUTH_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

interface TokenCache {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix ms
}

let tokenCache: TokenCache | null = null;
let refreshPromise: Promise<TokenCache> | null = null;

interface CredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

export function readCredentialsFile(): TokenCache | null {
  const credPath = path.join(
    process.env.HOME || os.homedir(),
    '.claude',
    '.credentials.json',
  );
  try {
    const raw: CredentialsFile = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    const creds = raw.claudeAiOauth;
    if (creds?.accessToken && creds?.refreshToken && creds?.expiresAt) {
      return {
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt: creds.expiresAt,
      };
    }
  } catch {
    // File doesn't exist or is malformed
  }
  return null;
}

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

function refreshAccessToken(refreshToken: string): Promise<TokenCache> {
  const url = new URL(OAUTH_TOKEN_ENDPOINT);
  const bodyStr = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });

  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyStr),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString();
          try {
            const data = JSON.parse(responseBody);
            if (data.access_token) {
              resolve({
                accessToken: data.access_token,
                expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
                refreshToken: data.refresh_token || refreshToken,
              });
            } else {
              reject(
                new Error(
                  `Token refresh failed: ${responseBody.slice(0, 200)}`,
                ),
              );
            }
          } catch (err) {
            reject(new Error(`Token refresh parse error: ${err}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

async function getValidAccessToken(
  staticFallback: string | undefined,
): Promise<string | undefined> {
  // If we have a token cache with refresh capability
  if (tokenCache) {
    const needsRefresh =
      !tokenCache.accessToken ||
      Date.now() >= tokenCache.expiresAt - REFRESH_MARGIN_MS;

    if (needsRefresh && tokenCache.refreshToken) {
      // Use shared promise to prevent concurrent refreshes
      if (!refreshPromise) {
        refreshPromise = refreshAccessToken(tokenCache.refreshToken)
          .then((newCache) => {
            tokenCache = newCache;
            logger.info('OAuth access token refreshed successfully');
            return newCache;
          })
          .catch((err) => {
            logger.error({ err }, 'OAuth token refresh failed');
            // Try re-reading credentials file as fallback
            const creds = readCredentialsFile();
            if (creds && creds.accessToken !== tokenCache?.accessToken) {
              tokenCache = creds;
              logger.info(
                'Loaded updated token from credentials file after refresh failure',
              );
              return creds;
            }
            throw err;
          })
          .finally(() => {
            refreshPromise = null;
          });
      }
      try {
        const result = await refreshPromise;
        return result.accessToken;
      } catch {
        // If refresh fails entirely, return whatever we have
        if (tokenCache.accessToken) return tokenCache.accessToken;
      }
    }

    if (tokenCache.accessToken) return tokenCache.accessToken;
  }

  // Static fallback (direct access token from .env)
  return staticFallback;
}

/** Reset token cache — exposed for testing */
export function _resetTokenCache(): void {
  tokenCache = null;
  refreshPromise = null;
}

// --- Proxy server ---

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

  // Initialize token cache for OAuth mode
  if (authMode === 'oauth') {
    if (oauthToken?.startsWith('sk-ant-ort01-')) {
      // .env has a refresh token — set up cache to trigger refresh on first use
      tokenCache = {
        accessToken: '',
        refreshToken: oauthToken,
        expiresAt: 0, // forces immediate refresh
      };
      logger.info('OAuth configured with refresh token from .env');
    } else if (!oauthToken) {
      // No token in .env — try credentials file
      const creds = readCredentialsFile();
      if (creds) {
        tokenCache = creds;
        logger.info('OAuth configured from ~/.claude/.credentials.json');
      }
    }
    // else: oauthToken is a static access token, use as-is (existing behavior)
  }

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
            const token = await getValidAccessToken(oauthToken);
            if (token) {
              headers['authorization'] = `Bearer ${token}`;
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
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
  if (secrets.ANTHROPIC_API_KEY) return 'api-key';
  if (secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN)
    return 'oauth';
  // Check credentials file as fallback
  if (readCredentialsFile()) return 'oauth';
  return 'oauth';
}
