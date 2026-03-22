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

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

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
        const rawBody = Buffer.concat(chunks);

        // ── Prompt caching injection ─────────────────────────────────────────
        // For every POST /v1/messages we inject cache_control on the system
        // prompt so Anthropic caches CLAUDE.md across conversation turns.
        // Cache read price = 10% of normal input price → ~30% overall cost
        // reduction on multi-turn conversations.
        let body = rawBody;
        if (req.method === 'POST' && req.url?.startsWith('/v1/messages')) {
          try {
            const json = JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>;
            let modified = false;

            if (typeof json.system === 'string' && json.system.length > 0) {
              // String form → convert to content-block array with cache_control
              json.system = [
                { type: 'text', text: json.system, cache_control: { type: 'ephemeral' } },
              ];
              modified = true;
            } else if (Array.isArray(json.system) && json.system.length > 0) {
              // Array form — inject on the last block if not already cached
              const last = json.system[json.system.length - 1] as Record<string, unknown>;
              if (!last.cache_control) {
                last.cache_control = { type: 'ephemeral' };
                modified = true;
              }
            }

            if (modified) {
              body = Buffer.from(JSON.stringify(json), 'utf-8');
            }
          } catch {
            // Not valid JSON or unexpected format — forward unchanged
          }
        }
        // ────────────────────────────────────────────────────────────────────

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Enable prompt caching on messages API calls
        if (req.url?.startsWith('/v1/messages')) {
          const existing = headers['anthropic-beta'];
          const parts = existing
            ? (Array.isArray(existing) ? existing : [existing as string])
            : [];
          if (!parts.includes('prompt-caching-2024-07-31')) {
            parts.push('prompt-caching-2024-07-31');
          }
          headers['anthropic-beta'] = parts.join(',');
        }

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
