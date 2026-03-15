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

/**
 * Replace lone surrogate \uXXXX escape sequences in a JSON body string.
 * V8's JSON.stringify emits \uD800-\uDFFF escapes for lone surrogates in JS
 * strings; Anthropic's JSON parser rejects them. Surrogates can originate from
 * any tool result (file reads, bash output, web fetches) stored in the session
 * transcript — not just from WhatsApp messages.
 */
function sanitizeLoneSurrogateEscapes(str: string): string {
  // Match any \uXXXX escape in the surrogate range (D800–DFFF)
  return str.replace(
    /\\u[dD][89aAbBcCdDeEfF][0-9a-fA-F]{2}/g,
    (match, offset, full) => {
      const cp = parseInt(match.slice(2), 16);
      if (cp <= 0xdbff) {
        // High surrogate — valid only if immediately followed by a low surrogate
        const next = full.slice(offset + 6, offset + 12);
        if (/^\\u[dD][cCdDeEfF][0-9a-fA-F]{2}$/.test(next)) return match;
      } else {
        // Low surrogate — valid only if immediately preceded by a high surrogate
        const prev = full.slice(offset - 6, offset);
        if (/^\\u[dD][89aAbB][0-9a-fA-F]{2}$/.test(prev)) return match;
      }
      return '\\uFFFD';
    },
  );
}

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
        // Sanitize lone surrogate \uXXXX escapes before forwarding.
        // These can appear in JSON bodies from tool results (file reads, bash
        // output, web fetches) stored in the session transcript, not just from
        // incoming WhatsApp messages.
        const rawBody = Buffer.concat(chunks);
        const sanitizedStr = sanitizeLoneSurrogateEscapes(
          rawBody.toString('utf8'),
        );
        const body = Buffer.from(sanitizedStr, 'utf8');
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
