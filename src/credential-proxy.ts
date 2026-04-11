/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 * In OAuth mode, auto-refreshes tokens before expiry.
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
import fs from 'node:fs';
import path from 'node:path';

import { readEnvFile } from './env.js';
import { readCredentials, writeCredentials } from './credential-store.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const MIN_REFRESH_DELAY_MS = 30_000; // 30 seconds
const REFRESH_MARGIN_MS = 5 * 60_000; // 5 minutes before expiry
const RETRY_DELAY_MS = 60_000; // 1 minute on failure

/** Simple HTTPS POST that returns parsed JSON. */
function fetchJson(
  url: string,
  body: Record<string, string>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = httpsRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(
              JSON.parse(Buffer.concat(chunks).toString()) as Record<
                string,
                unknown
              >,
            );
          } catch (err) {
            reject(new Error(`Failed to parse token response: ${err}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/** Update CLAUDE_CODE_OAUTH_TOKEN in the .env file. */
function updateEnvToken(token: string): void {
  const envPath = path.join(process.cwd(), '.env');
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf-8');
  } catch {
    // File doesn't exist yet — we'll create it
  }

  const line = `CLAUDE_CODE_OAUTH_TOKEN=${token}`;
  const regex = /^CLAUDE_CODE_OAUTH_TOKEN=.*/m;

  if (regex.test(content)) {
    content = content.replace(regex, line);
  } else {
    content = content.trimEnd() + (content ? '\n' : '') + line + '\n';
  }

  fs.writeFileSync(envPath, content, 'utf-8');
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
  options?: {
    label?: string;
    oauthTokenOverride?: string;
    credentialsPath?: string;
  },
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  let oauthToken =
    options?.oauthTokenOverride ||
    secrets.CLAUDE_CODE_OAUTH_TOKEN ||
    secrets.ANTHROPIC_AUTH_TOKEN;
  const proxyLabel = options?.label || 'default';

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Auto-refresh (OAuth only) ---
  if (authMode === 'oauth') {
    // If credentialsPath is provided, read from that file; otherwise default credential store
    const creds = readCredentials(options?.credentialsPath);
    if (creds) {
      // Use credential store token if fresher (or if no token set yet)
      if (creds.accessToken && creds.accessToken !== oauthToken) {
        oauthToken = creds.accessToken;
        logger.info({ label: proxyLabel }, 'Using token from credential store');
      }
      if (creds.refreshToken) {
        scheduleRefresh(creds.expiresAt, creds.refreshToken);
      } else {
        logger.warn(
          { label: proxyLabel },
          'No refresh token available, auto-refresh disabled',
        );
      }
    }
  }

  function scheduleRefresh(expiresAt: number, refreshToken: string): void {
    const delay = Math.max(
      expiresAt - Date.now() - REFRESH_MARGIN_MS,
      MIN_REFRESH_DELAY_MS,
    );
    logger.info({ delayMs: delay }, 'Scheduling OAuth token refresh');
    refreshTimer = setTimeout(() => doRefresh(refreshToken), delay);
  }

  async function doRefresh(refreshToken: string): Promise<void> {
    try {
      const data = await fetchJson(TOKEN_ENDPOINT, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      });

      if (typeof data.access_token !== 'string') {
        throw new Error(
          `Token response missing access_token: ${JSON.stringify(data)}`,
        );
      }

      oauthToken = data.access_token as string;
      const newRefresh = (data.refresh_token as string) || refreshToken;
      const expiresIn = (data.expires_in as number) || 3600;
      const expiresAt = Date.now() + expiresIn * 1000;

      // Persist to the same credentials file this proxy reads from
      writeCredentials(
        {
          accessToken: oauthToken,
          refreshToken: newRefresh,
          expiresAt,
          scopes: [],
        },
        options?.credentialsPath,
      );
      updateEnvToken(oauthToken);

      logger.info('OAuth token refreshed successfully');
      scheduleRefresh(expiresAt, newRefresh);
    } catch (err) {
      logger.error({ err }, 'OAuth token refresh failed, retrying in 60s');
      refreshTimer = setTimeout(() => doRefresh(refreshToken), RETRY_DELAY_MS);
    }
  }

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

    // Clean up timer on server close
    const origClose = server.close.bind(server);
    server.close = function (cb?: (err?: Error) => void) {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
      }
      return origClose(cb);
    } as typeof server.close;

    server.listen(port, host, () => {
      logger.info(
        { port, host, authMode, label: proxyLabel },
        'Credential proxy started',
      );
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
