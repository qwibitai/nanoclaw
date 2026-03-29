/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    OAuth tokens can't be used as Bearer for inference (Anthropic
 *             rejects it) but DO work as x-api-key. The exchange endpoint
 *             /api/oauth/claude_cli/create_api_key requires org:create_api_key
 *             scope which user tokens may lack. Workaround: mock the exchange
 *             response returning the real OAuth token as the "api_key", then
 *             inject it as x-api-key on all subsequent inference requests.
 *
 *             Token freshness: the proxy reads ~/.claude/.credentials.json on
 *             each request (cached 60s) so it picks up auto-refreshed tokens
 *             without needing a nanoclaw restart. The secrets.yaml only needs
 *             a non-empty placeholder for CLAUDE_CODE_OAUTH_TOKEN to enable
 *             OAuth mode.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

const CLAUDE_CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');
const CREDENTIALS_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // re-read at most once per 4 hours

let _cachedToken: string | undefined;
let _cacheExpiry = 0;

/**
 * Read the current OAuth access token from ~/.claude/.credentials.json,
 * cached for CREDENTIALS_CACHE_TTL_MS to avoid disk reads on every request.
 * Falls back to the env-provided token if the file is absent or unreadable.
 */
function getLiveOAuthToken(envFallback: string | undefined): string | undefined {
  const now = Date.now();
  if (_cachedToken && now < _cacheExpiry) return _cachedToken;

  try {
    if (existsSync(CLAUDE_CREDENTIALS_PATH)) {
      const raw = readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf8');
      const creds = JSON.parse(raw);
      const token = creds?.claudeAiOauth?.accessToken;
      if (token) {
        _cachedToken = token;
        _cacheExpiry = now + CREDENTIALS_CACHE_TTL_MS;
        return token;
      }
    }
  } catch {
    // ignore parse errors — fall through to env fallback
  }

  _cachedToken = envFallback;
  _cacheExpiry = now + CREDENTIALS_CACHE_TTL_MS;
  return envFallback;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const fileSecrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  // Fall back to process.env for secrets managed by sops exec-env
  const secrets = {
    ANTHROPIC_API_KEY: fileSecrets.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY,
    CLAUDE_CODE_OAUTH_TOKEN: fileSecrets.CLAUDE_CODE_OAUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN,
    ANTHROPIC_AUTH_TOKEN: fileSecrets.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: fileSecrets.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL,
  };

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const envOauthToken =
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
          // OAuth mode: read the freshest token on each request (cached 60s)
          // so auto-refreshed tokens are picked up without a restart.
          const oauthToken = getLiveOAuthToken(envOauthToken);

          // Mock the exchange endpoint — containers don't need org:create_api_key
          // scope. Return the OAuth token itself as the api_key; it works as
          // x-api-key for inference calls.
          if (req.url === '/api/oauth/claude_cli/create_api_key') {
            const mock = JSON.stringify({ api_key: oauthToken });
            res.writeHead(200, { 'Content-Type': 'application/json', 'content-length': Buffer.byteLength(mock) });
            res.end(mock);
            logger.info('Credential proxy: mocked OAuth exchange with live token');
            return;
          }

          // All other requests: inject OAuth token as x-api-key
          delete headers['authorization'];
          delete headers['x-api-key'];
          if (oauthToken) {
            headers['x-api-key'] = oauthToken;
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
  const apiKey = secrets.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
  return apiKey ? 'api-key' : 'oauth';
}
