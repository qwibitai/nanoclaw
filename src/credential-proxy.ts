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
 * Auto-refresh: When upstream returns 401 authentication_error, the proxy
 * attempts to refresh the OAuth token using the stored refresh_token and
 * retries the request once with the new token.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { isError, isSyntaxError } from './error-utils.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

/** Read the latest OAuth access token from ~/.claude/.credentials.json */
function readClaudeCredentials(): string | undefined {
  try {
    const raw = fs.readFileSync(CRED_PATH, 'utf-8');
    const creds = JSON.parse(raw);
    return creds?.claudeAiOauth?.accessToken as string | undefined;
  } catch (err) {
    if (!isError(err) && !isSyntaxError(err)) throw err;
    return undefined;
  }
}

/** In-flight refresh promise — prevents concurrent refresh races */
let refreshInFlight: Promise<string | undefined> | null = null;

/**
 * Refresh the Claude OAuth access token using the stored refresh_token.
 * Writes the new token back to credentials.json and returns it.
 */
async function refreshClaudeOAuthToken(): Promise<string | undefined> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const raw = fs.readFileSync(CRED_PATH, 'utf-8');
      const creds = JSON.parse(raw);
      const oauth = creds?.claudeAiOauth;
      if (!oauth?.refreshToken) {
        logger.warn('No refresh token in credentials — cannot auto-refresh');
        return undefined;
      }

      logger.info('OAuth token expired — attempting auto-refresh');

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken as string,
        ...(oauth.clientId ? { client_id: oauth.clientId as string } : {}),
      }).toString();

      const newToken = await new Promise<string | undefined>((resolve) => {
        const req = httpsRequest(
          {
            hostname: 'claude.ai',
            port: 443,
            path: '/api/oauth/token',
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
                if (res.statusCode !== 200 || !data.access_token) {
                  logger.error(
                    { status: res.statusCode, data },
                    'OAuth token refresh failed',
                  );
                  resolve(undefined);
                  return;
                }

                // Update credentials file with new tokens
                oauth.accessToken = data.access_token;
                if (data.refresh_token) oauth.refreshToken = data.refresh_token;
                if (data.expires_in) {
                  oauth.expiresAt = Date.now() + data.expires_in * 1000;
                }
                fs.writeFileSync(CRED_PATH, JSON.stringify(creds, null, 2));
                logger.info('OAuth token refreshed and saved');
                resolve(data.access_token as string);
              } catch (err) {
                if (!isSyntaxError(err)) throw err;
                logger.error({ err }, 'Failed to parse OAuth refresh response');
                resolve(undefined);
              }
            });
          },
        );
        req.on('error', (err) => {
          logger.error({ err }, 'OAuth refresh request error');
          resolve(undefined);
        });
        req.write(body);
        req.end();
      });

      return newToken;
    } catch (err) {
      if (!isError(err) && !isSyntaxError(err)) throw err;
      logger.error({ err }, 'OAuth token refresh error');
      return undefined;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
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
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  /** Build outbound headers, injecting the correct credential */
  function buildHeaders(
    incomingHeaders: Record<string, string>,
    token: string | undefined,
  ): Record<string, string | number | string[] | undefined> {
    const headers: Record<string, string | number | string[] | undefined> = {
      ...incomingHeaders,
      host: upstreamUrl.host,
    };
    delete headers['connection'];
    delete headers['keep-alive'];
    delete headers['transfer-encoding'];

    if (authMode === 'api-key') {
      delete headers['x-api-key'];
      headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
    } else if (headers['authorization'] && token) {
      delete headers['authorization'];
      headers['authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        (async () => {
          // Fresh OAuth token for this request
          const freshToken =
            authMode === 'oauth'
              ? readClaudeCredentials() || oauthToken
              : undefined;

          const headers = buildHeaders(
            req.headers as Record<string, string>,
            freshToken,
          );
          headers['content-length'] = body.length;

          const upstream = makeRequest(
            {
              hostname: upstreamUrl.hostname,
              port: upstreamUrl.port || (isHttps ? 443 : 80),
              path: req.url,
              method: req.method,
              headers,
            } as RequestOptions,
            async (upRes) => {
              // For non-401 or API-key mode, stream directly (fast path)
              if (upRes.statusCode !== 401 || authMode !== 'oauth') {
                res.writeHead(upRes.statusCode!, upRes.headers);
                upRes.pipe(res);
                return;
              }

              // Buffer the 401 body to check whether it's an expired token
              const chunks401: Buffer[] = [];
              upRes.on('data', (c: Buffer) => chunks401.push(c));
              upRes.on('end', async () => {
                const bodyStr = Buffer.concat(chunks401).toString();
                let isExpired = false;
                try {
                  const parsed = JSON.parse(bodyStr);
                  isExpired =
                    parsed?.error?.type === 'authentication_error' &&
                    ((parsed?.error?.message as string) ?? '')
                      .toLowerCase()
                      .includes('expired');
                } catch (err) {
                  if (!isSyntaxError(err)) throw err;
                  // Not JSON — pass through as-is
                }

                if (!isExpired) {
                  // Not an expired-token 401 — forward as-is
                  res.writeHead(401, upRes.headers);
                  res.end(bodyStr);
                  return;
                }

                // Attempt token refresh and retry once
                logger.warn(
                  'Detected expired OAuth token — refreshing and retrying',
                );
                const newToken = await refreshClaudeOAuthToken();
                if (!newToken) {
                  // Refresh failed — return original 401
                  res.writeHead(401, upRes.headers);
                  res.end(bodyStr);
                  return;
                }

                const retryHeaders = buildHeaders(
                  req.headers as Record<string, string>,
                  newToken,
                );
                retryHeaders['content-length'] = body.length;

                const retry = makeRequest(
                  {
                    hostname: upstreamUrl.hostname,
                    port: upstreamUrl.port || (isHttps ? 443 : 80),
                    path: req.url,
                    method: req.method,
                    headers: retryHeaders,
                  } as RequestOptions,
                  (retryRes) => {
                    res.writeHead(retryRes.statusCode!, retryRes.headers);
                    retryRes.pipe(res);
                  },
                );
                retry.on('error', (err) => {
                  logger.error({ err }, 'Credential proxy retry error');
                  if (!res.headersSent) {
                    res.writeHead(502);
                    res.end('Bad Gateway');
                  }
                });
                retry.write(body);
                retry.end();
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
        })().catch((err) => {
          logger.error({ err }, 'Credential proxy handler error');
          if (!res.headersSent) {
            res.writeHead(500);
            res.end('Internal Server Error');
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
