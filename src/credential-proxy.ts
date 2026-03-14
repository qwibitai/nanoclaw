/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Data flow:
 *   Container (ANTHROPIC_BASE_URL=http://host.docker.internal:<port>)
 *     → This proxy (replaces auth headers)
 *       → api.anthropic.com (real credentials)
 *         → SSE streams back through proxy to container
 *
 * Security model (OAuth):
 *   The SDK's normal OAuth flow calls /api/oauth/claude_cli/create_api_key to
 *   exchange an OAuth token for a temporary API key, then uses that key for
 *   subsequent requests. In our setup the container is untrusted — if we allowed
 *   the exchange, the response body would deliver a working temp API key into
 *   the container, defeating credential isolation entirely.
 *
 *   Instead, we inject the real credential on every outbound request. The SDK
 *   inside the container only ever has a placeholder key, which is worthless
 *   outside this proxy. No credential ever enters the container.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { getFreshOAuthToken } from './oauth-token.js';

const REQUEST_TIMEOUT = 600_000; // 10 minutes for long agent conversations

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const upstreamUrl = new URL(
    process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer(
      async (req: IncomingMessage, res: ServerResponse) => {
        const start = Date.now();

        // Health check
        if (req.method === 'GET' && req.url === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }

        // Read API key from .env on each request (rotated keys take effect
        // immediately). OAuth tokens are handled by getFreshOAuthToken() which
        // reads from ~/.claude/.credentials.json with auto-refresh.
        const creds = readEnvFile([
          'ANTHROPIC_API_KEY',
          'CLAUDE_CODE_OAUTH_TOKEN',
          'ANTHROPIC_AUTH_TOKEN',
        ]);
        const apiKey = creds.ANTHROPIC_API_KEY;
        const oauthToken = apiKey ? null : await getFreshOAuthToken();

        if (!apiKey && !oauthToken) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: 'No credentials configured on host' }),
          );
          return;
        }

        // Build forwarded headers — replace auth
        const headers: Record<string, string | string[] | undefined> = {
          ...req.headers,
        };
        // Strip hop-by-hop headers that must not be forwarded (RFC 2616 §13.5.1).
        // transfer-encoding is critical: we stream via req.pipe(), so forwarding
        // the client's chunked framing header while the upstream negotiates its
        // own would cause mismatches.
        delete headers.host;
        delete headers.connection;
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        // Credential injection — always unconditional, never exchange-based.
        //
        // See module docstring for security rationale. We inject the real
        // credential on every request. The container SDK only has a placeholder,
        // so the OAuth exchange endpoint is never called — no temp API key ever
        // enters the container.
        if (apiKey) {
          headers['x-api-key'] = apiKey;
          delete headers['authorization'];
        } else if (oauthToken) {
          headers['authorization'] = `Bearer ${oauthToken}`;
          // OAuth on the Messages API requires this beta feature flag.
          // Without it, api.anthropic.com returns 401 "OAuth authentication is
          // currently not supported." The SDK normally sends this itself, but
          // since we bypass the exchange flow (the SDK thinks it has an API key
          // via the placeholder), it won't. We must inject it.
          // If Anthropic graduates OAuth out of beta, this becomes a no-op.
          headers['anthropic-beta'] = 'oauth-2025-04-20';
          delete headers['x-api-key'];
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
            upRes.pipe(res); // Stream SSE without buffering
          },
        );

        upstream.setTimeout(REQUEST_TIMEOUT, () => {
          logger.warn({ path: req.url }, 'Proxy request timed out');
          upstream.destroy();
        });

        upstream.on('error', (err) => {
          const duration = Date.now() - start;
          logger.error(
            { err, path: req.url, duration },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
          }
        });

        req.pipe(upstream); // Stream request body (handles large base64 images)

        res.on('finish', () => {
          const duration = Date.now() - start;
          logger.debug(
            {
              method: req.method,
              path: req.url,
              status: res.statusCode,
              duration,
            },
            'Proxied API request',
          );
        });
      },
    );

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): 'api-key' | 'oauth' {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
