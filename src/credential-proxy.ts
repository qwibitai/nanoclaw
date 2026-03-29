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
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const REFRESH_URL = 'https://platform.claude.com/v1/oauth/token';
// Anthropic Claude CLI OAuth client ID
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes before expiry

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export function defaultCredentialsPath(): string {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

export function readCredentials(credentialsPath: string): OAuthCredentials {
  const raw = fs.readFileSync(credentialsPath, 'utf-8');
  const data = JSON.parse(raw);
  const oauth = data.claudeAiOauth;
  if (!oauth) {
    throw new Error(
      'credentials file missing claudeAiOauth — run "claude" to authenticate',
    );
  }
  return {
    accessToken: oauth.accessToken,
    refreshToken: oauth.refreshToken,
    expiresAt: oauth.expiresAt,
  };
}

export async function refreshOAuthToken(
  refreshToken: string,
  tokenUrl = REFRESH_URL,
): Promise<OAuthCredentials> {
  const url = new URL(tokenUrl);
  const isHttps = url.protocol === 'https:';
  const makeReq = isHttps ? httpsRequest : httpRequest;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  }).toString();

  return new Promise((resolve, reject) => {
    const req = makeReq(
      {
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `OAuth refresh failed with ${res.statusCode}: ${Buffer.concat(chunks).toString()}`,
              ),
            );
            return;
          }
          const json = JSON.parse(Buffer.concat(chunks).toString());
          if (!json.access_token || typeof json.expires_in !== 'number') {
            reject(new Error('OAuth refresh response missing required fields'));
            return;
          }
          resolve({
            accessToken: json.access_token,
            refreshToken: json.refresh_token,
            expiresAt: Date.now() + json.expires_in * 1000,
          });
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export async function ensureValidToken(
  credentialsPath: string,
  tokenUrl = REFRESH_URL,
  maxRetries = 3,
): Promise<OAuthCredentials> {
  const creds = readCredentials(credentialsPath);

  // Token still valid (outside 5-minute buffer)
  if (creds.expiresAt - Date.now() > REFRESH_BUFFER_MS) {
    return creds;
  }

  logger.info('OAuth token expiring soon, refreshing...');

  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const refreshed = await refreshOAuthToken(creds.refreshToken, tokenUrl);

      // Write back to credentials file, preserving other fields
      const raw = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'));
      raw.claudeAiOauth = {
        ...raw.claudeAiOauth,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: refreshed.expiresAt,
      };
      fs.writeFileSync(credentialsPath, JSON.stringify(raw, null, 2));

      logger.info('OAuth token refreshed successfully');
      return refreshed;
    } catch (err) {
      lastError = err as Error;
      logger.warn(
        { err, attempt, maxRetries },
        'OAuth refresh attempt failed',
      );
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  logger.error(
    { err: lastError },
    'All OAuth refresh attempts failed, using current token',
  );
  return creds;
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
