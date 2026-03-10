/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Identification:
 *   Container → group: Docker bridge IP (req.socket.remoteAddress)
 *   Service routing:   URL path prefix (e.g. /claude/v1/messages)
 *
 * Currently supported services:
 *   /claude/*  — Anthropic API (api-key or OAuth mode)
 *
 * Two auth modes (resolved per-request from the group's credentials):
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

/** Pluggable credential resolver. Default reads .env; per-group-auth skill replaces this. */
export type CredentialResolver = (scope: string) => Record<string, string>;

let credentialResolver: CredentialResolver = defaultResolver;

function defaultResolver(_scope: string): Record<string, string> {
  return readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);
}

/** Replace the credential resolver (called by per-group-auth skill at startup). */
export function setCredentialResolver(resolver: CredentialResolver): void {
  credentialResolver = resolver;
}

// --- Container IP → group scope registry ---
// Each Docker container on a bridge network gets a unique IP assigned by the kernel.
// container-runner registers the mapping after spawn; we look it up on each request.
const containerIpToScope = new Map<string, string>();

/** Register a container IP → group scope mapping (called by container-runner after spawn). */
export function registerContainerIP(ip: string, scope: string): void {
  containerIpToScope.set(ip, scope);
  logger.debug({ ip, scope }, 'Registered container IP');
}

/** Unregister a container IP mapping (called on container exit). */
export function unregisterContainerIP(ip: string): void {
  containerIpToScope.delete(ip);
  logger.debug({ ip }, 'Unregistered container IP');
}

/** Normalize IPv4-mapped IPv6 addresses (e.g. ::ffff:172.17.0.2 → 172.17.0.2). */
function normalizeIP(raw: string): string {
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  return raw;
}

/** Parse service prefix from URL path. Returns { service, path } or null. */
function parseServicePrefix(url: string): { service: string; path: string } | null {
  const match = url.match(/^\/([a-z][a-z0-9-]*)(\/.*)?$/);
  if (!match) return null;
  return { service: match[1], path: match[2] || '/' };
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  // Read upstream URL once (not credential-dependent)
  const envConfig = readEnvFile(['ANTHROPIC_BASE_URL']);
  const upstreamUrl = new URL(
    envConfig.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // Parse service prefix from URL (e.g. /claude/v1/messages)
        const parsed = parseServicePrefix(req.url || '/');
        if (!parsed) {
          res.writeHead(400);
          res.end('Bad Request: missing service prefix (e.g. /claude/)');
          return;
        }

        // Currently only /claude/ is supported
        if (parsed.service !== 'claude') {
          res.writeHead(404);
          res.end(`Unknown service: ${parsed.service}`);
          return;
        }

        // Identify which container is calling by its bridge IP
        const remoteIP = normalizeIP(req.socket.remoteAddress || '');
        const scope = containerIpToScope.get(remoteIP) || 'default';

        if (!containerIpToScope.has(remoteIP)) {
          logger.warn(
            { remoteIP, service: parsed.service, url: req.url },
            'Request from unknown container IP, using default credentials',
          );
        }

        // Resolve credentials for this scope
        const secrets = credentialResolver(scope);
        const authMode: AuthMode = secrets.ANTHROPIC_API_KEY
          ? 'api-key'
          : 'oauth';
        const oauthToken =
          secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

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

        // Forward to upstream with service prefix stripped
        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: parsed.path,
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
            { err, url: req.url, scope, service: parsed.service },
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
      logger.info({ port, host }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode is configured for a given scope. */
export function detectAuthMode(scope: string): AuthMode {
  const secrets = credentialResolver(scope);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
