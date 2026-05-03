/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Proxy replaces the placeholder Bearer token with the live
 *             subscription token and injects the headers required for
 *             Claude Code OAuth inference:
 *               anthropic-beta: oauth-2025-04-20 (enables Bearer OAuth)
 *               anthropic-dangerous-direct-browser-access: true
 *               x-app: cli
 *             This mirrors exactly what the Claude Code CLI sends and
 *             uses subscription credits — no exchange endpoint, no
 *             org:create_api_key scope required.
 *
 * OAuth token source (checked in order, with 30s cache):
 *   1. ~/.claude/.credentials.json  — Claude Code keeps this current via
 *      its own refresh cycle, so the proxy automatically picks up rotated
 *      tokens without a restart.
 *   2. CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN in .env — fallback
 *      for deployments without a local Claude Code install.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { log as logger } from './log.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

// ---------------------------------------------------------------------------
// Live OAuth token reader — re-reads ~/.claude/.credentials.json with a
// short TTL so rotated tokens are picked up without restarting the proxy.
// ---------------------------------------------------------------------------

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const TOKEN_CACHE_TTL_MS = 30_000;

let cachedToken: string | null = null;
let cacheExpiry = 0;

function readTokenFromCredentials(): string | null {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: { accessToken?: string };
    };
    return parsed.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

function getLiveOAuthToken(envFallback: string | undefined): string | null {
  const now = Date.now();
  if (now < cacheExpiry && cachedToken !== undefined) {
    return cachedToken;
  }
  const fromFile = readTokenFromCredentials();
  cachedToken = fromFile ?? envFallback ?? null;
  cacheExpiry = now + TOKEN_CACHE_TTL_MS;
  return cachedToken;
}

// ---------------------------------------------------------------------------

export function startCredentialProxy(port: number, host = '127.0.0.1'): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const envOauthFallback = secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> = {
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
          // OAuth mode: replace placeholder Bearer token with the live subscription
          // token and inject the headers the Claude Code CLI uses for OAuth inference.
          // This mirrors the exact request shape the host's `claude` CLI sends, which
          // lets api.anthropic.com accept Bearer OAuth tokens for subscription billing.
          const liveToken = getLiveOAuthToken(envOauthFallback);
          if (liveToken) {
            delete headers['authorization'];
            headers['authorization'] = `Bearer ${liveToken}`;

            // Enable OAuth Bearer inference (required — without this header
            // api.anthropic.com returns 401 "OAuth authentication is currently
            // not supported").
            const existing = (headers['anthropic-beta'] as string) ?? '';
            if (!existing.includes('oauth-2025-04-20')) {
              headers['anthropic-beta'] = existing
                ? `${existing},oauth-2025-04-20`
                : 'oauth-2025-04-20';
            }
            headers['anthropic-dangerous-direct-browser-access'] = 'true';
            if (!headers['x-app']) headers['x-app'] = 'cli';
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
          logger.error('Credential proxy upstream error', { err, url: req.url });
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
      logger.info('Credential proxy started', { port, host, authMode });
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
