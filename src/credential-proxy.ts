/**
 * Credential proxy — sits between containers and the Anthropic API.
 * Injects real credentials into requests, replacing container placeholders.
 *
 * Auth modes:
 *   - api-key:  Uses ANTHROPIC_API_KEY from .env (never expires until revoked)
 *   - oauth:    Uses CLAUDE_CODE_OAUTH_TOKEN from .env (1-year token via `claude setup-token`)
 *
 * No auto-refresh logic — tokens are either long-lived API keys or 1-year
 * setup-tokens that don't need runtime refresh.
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding']);

/** Detect auth mode by checking for ANTHROPIC_API_KEY in .env */
export function detectAuthMode(): AuthMode {
  const env = readEnvFile(['ANTHROPIC_API_KEY']);
  return env.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}

/**
 * Start the credential proxy HTTP server.
 *
 * @param port - Port to listen on (0 for random)
 * @param host - Bind address (default '127.0.0.1')
 * @param envOverrides - When provided, skips .env reading (for tests)
 */
export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
  envOverrides?: Record<string, string>,
): Promise<http.Server> {
  // Load environment
  const env = envOverrides ?? readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const apiKey = env.ANTHROPIC_API_KEY;
  const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN;
  const upstreamBase = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const mode: AuthMode = apiKey ? 'api-key' : 'oauth';

  if (mode === 'oauth' && !oauthToken) {
    logger.warn(
      'OAuth mode but CLAUDE_CODE_OAUTH_TOKEN is empty. ' +
      'Run `claude setup-token` to generate a 1-year token and add it to .env',
    );
  }

  // --- Proxy server ---
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('error', (err) => {
      logger.error({ err }, 'Client request error');
      if (!res.headersSent) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('Bad Request');
      }
    });
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const upstream = new URL(req.url || '/', upstreamBase);
      const isHttps = upstream.protocol === 'https:';
      const transport = isHttps ? https : http;

      // Build headers
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (HOP_BY_HOP.has(key.toLowerCase())) continue;
        if (typeof value === 'string') {
          headers[key] = value;
        } else if (Array.isArray(value)) {
          headers[key] = value.join(', ');
        }
      }

      // Replace host
      headers['host'] = upstream.host;
      // Update content-length
      headers['content-length'] = String(body.length);

      // Inject credentials
      if (mode === 'api-key' && apiKey) {
        headers['x-api-key'] = apiKey;
      } else if (mode === 'oauth' && oauthToken) {
        // Remove placeholder x-api-key and inject real OAuth token
        delete headers['x-api-key'];
        headers['authorization'] = `Bearer ${oauthToken}`;
      }

      const upstreamReq = transport.request(
        {
          hostname: upstream.hostname,
          port: upstream.port || (isHttps ? 443 : 80),
          path: upstream.pathname + upstream.search,
          method: req.method,
          headers,
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode!, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );

      upstreamReq.on('error', (err) => {
        logger.error({ err }, 'Upstream request failed');
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain' });
          res.end('Bad Gateway');
        } else {
          res.destroy();
        }
      });

      upstreamReq.write(body);
      upstreamReq.end();
    });
  });

  return new Promise<http.Server>((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address() as { port: number };
      logger.info({ port: addr.port, mode }, 'Credential proxy started');
      resolve(server);
    });
  });
}
