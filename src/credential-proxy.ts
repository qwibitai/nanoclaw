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
 * In OAuth mode the token is re-read from ~/.claude/.credentials.json on
 * every request so that refreshed tokens are picked up automatically.
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
 * Read the current OAuth access token, checking (in order):
 *   1. CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN from .env
 *   2. ~/.claude/.credentials.json (written by `claude /login`)
 */
function readOAuthToken(): string | undefined {
  const secrets = readEnvFile([
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);
  if (secrets.CLAUDE_CODE_OAUTH_TOKEN) return secrets.CLAUDE_CODE_OAUTH_TOKEN;
  if (secrets.ANTHROPIC_AUTH_TOKEN) return secrets.ANTHROPIC_AUTH_TOKEN;

  // Fall back to Claude CLI credentials file
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const data = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    const token = data?.claudeAiOauth?.accessToken;
    if (token) return token;
  } catch {
    // credentials file missing or malformed — ignore
  }
  return undefined;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);

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
            const token = readOAuthToken();
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
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}

// OAuth refresh constants
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Refresh 5 minutes before expiry to avoid edge-case failures
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

/**
 * Read the full OAuth credentials object from ~/.claude/.credentials.json.
 */
function readOAuthCredentials(): OAuthCredentials | undefined {
  const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
  try {
    const data = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
    const oauth = data?.claudeAiOauth;
    if (oauth?.accessToken && oauth?.refreshToken && oauth?.expiresAt) {
      return oauth;
    }
  } catch {
    // missing or malformed
  }
  return undefined;
}

/**
 * Refresh the OAuth token using the refresh token.
 * Refresh tokens are single-use: the response includes a new refresh token.
 */
async function refreshOAuthToken(
  refreshToken: string,
): Promise<OAuthCredentials> {
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });

  return new Promise((resolve, reject) => {
    const url = new URL(OAUTH_TOKEN_URL);
    const req = httpsRequest(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `OAuth refresh failed (${res.statusCode}): ${raw.slice(0, 200)}`,
              ),
            );
            return;
          }
          try {
            const data = JSON.parse(raw);
            resolve({
              accessToken: data.access_token,
              refreshToken: data.refresh_token,
              expiresAt: Date.now() + data.expires_in * 1000,
              scopes: data.scope?.split(' '),
              subscriptionType: data.subscription_type,
              rateLimitTier: data.rate_limit_tier,
            });
          } catch (err) {
            reject(new Error(`Failed to parse OAuth refresh response: ${err}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Prevent concurrent refresh attempts (refresh tokens are single-use)
let refreshInProgress: Promise<OAuthCredentials> | null = null;

/**
 * Ensure the host's OAuth credentials are valid, refreshing if needed.
 * Writes the refreshed credentials back to ~/.claude/.credentials.json.
 * Returns the valid credentials, or undefined if not in OAuth mode or refresh fails.
 */
export async function ensureValidOAuthCredentials(): Promise<
  OAuthCredentials | undefined
> {
  const creds = readOAuthCredentials();
  if (!creds) return undefined;

  // Token still valid (with buffer)
  if (creds.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
    return creds;
  }

  logger.info('OAuth token expired or expiring soon, refreshing...');

  // Serialize concurrent refresh attempts
  if (refreshInProgress) {
    return refreshInProgress;
  }

  refreshInProgress = (async () => {
    try {
      const fresh = await refreshOAuthToken(creds.refreshToken);

      // Write back to host credentials file
      const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
      const fileData = { claudeAiOauth: fresh };
      fs.writeFileSync(credPath, JSON.stringify(fileData, null, 2), {
        mode: 0o600,
      });

      logger.info(
        {
          expiresIn: Math.round((fresh.expiresAt - Date.now()) / 1000 / 60),
        },
        'OAuth token refreshed successfully (expires in minutes)',
      );
      return fresh;
    } catch (err) {
      logger.error({ err }, 'OAuth token refresh failed');
      throw err;
    } finally {
      refreshInProgress = null;
    }
  })();

  return refreshInProgress;
}

/**
 * Copy valid OAuth credentials to a target path for container use.
 * Ensures the token is fresh before copying.
 * Returns true if credentials were copied, false if not in OAuth mode.
 */
export async function copyFreshCredentials(
  targetPath: string,
): Promise<boolean> {
  const creds = await ensureValidOAuthCredentials();
  if (!creds) return false;

  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    targetPath,
    JSON.stringify({ claudeAiOauth: creds }, null, 2),
    { mode: 0o600 },
  );
  return true;
}

/** Exported for testing. */
export { readOAuthToken };
