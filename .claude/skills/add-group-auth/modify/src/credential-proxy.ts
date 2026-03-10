/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to upstream APIs.
 * The proxy injects real credentials so containers never see them.
 *
 * Identification:
 *   Container → group: Docker bridge IP (req.socket.remoteAddress)
 *   Service routing:   URL path prefix (e.g. /claude/v1/messages)
 *
 * The proxy is just a dispatcher. Services self-register via
 * registerProxyService() and own the entire upstream call.
 */
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';

import { logger } from './logger.js';

// ── Service registry ────────────────────────────────────────────────

/** A proxy service handles one URL prefix and owns the full upstream call. */
export interface ProxyService {
  /** URL prefix without slashes, e.g. 'claude'. */
  prefix: string;
  /**
   * Forward an incoming request to the upstream service.
   * The proxy has already:
   * - stripped the /<prefix> from the URL (path is the remainder)
   * - resolved the group scope from the container's IP
   * - resolved credentials via the credential resolver
   *
   * The service is responsible for forwarding to its upstream,
   * injecting credentials, and piping the response back.
   */
  forward(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    body: Buffer,
    secrets: Record<string, string>,
  ): void;
}

const serviceRegistry = new Map<string, ProxyService>();

/** Register a proxy service. Called at startup (or by credential providers). */
export function registerProxyService(service: ProxyService): void {
  serviceRegistry.set(service.prefix, service);
  logger.debug({ prefix: service.prefix }, 'Registered proxy service');
}

/** Get a registered proxy service by prefix. */
export function getProxyService(prefix: string): ProxyService | undefined {
  return serviceRegistry.get(prefix);
}

/** Get all registered proxy services. */
export function getAllProxyServices(): ProxyService[] {
  return [...serviceRegistry.values()];
}

// ── Credential resolver ─────────────────────────────────────────────

/** Pluggable credential resolver. Default reads .env; per-group-auth skill replaces this. */
export type CredentialResolver = (scope: string) => Record<string, string>;

let credentialResolver: CredentialResolver = defaultResolver;

function defaultResolver(_scope: string): Record<string, string> {
  // Stub — replaced by setCredentialResolver() at startup when
  // the per-group-auth skill wires in its own resolver.
  return {};
}

/** Replace the credential resolver (called by per-group-auth skill at startup). */
export function setCredentialResolver(resolver: CredentialResolver): void {
  credentialResolver = resolver;
}

// ── Container IP → group scope registry ─────────────────────────────

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

// ── Proxy server ────────────────────────────────────────────────────

/** Parse service prefix from URL path. Returns { prefix, path } or null. */
function parseServicePrefix(url: string): { prefix: string; path: string } | null {
  const match = url.match(/^\/([a-z][a-z0-9-]*)(\/.*)?$/);
  if (!match) return null;
  return { prefix: match[1], path: match[2] || '/' };
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
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
          res.end('Bad Request: missing service prefix');
          return;
        }

        // Look up the service
        const service = serviceRegistry.get(parsed.prefix);
        if (!service) {
          res.writeHead(404);
          res.end(`Unknown service: ${parsed.prefix}`);
          return;
        }

        // Identify which container is calling by its bridge IP
        const remoteIP = normalizeIP(req.socket.remoteAddress || '');
        const scope = containerIpToScope.get(remoteIP) || 'default';

        if (!containerIpToScope.has(remoteIP)) {
          logger.warn(
            { remoteIP, service: parsed.prefix, url: req.url },
            'Request from unknown container IP, using default credentials',
          );
        }

        // Resolve credentials and dispatch to the service
        const secrets = credentialResolver(scope);
        service.forward(req, res, parsed.path, body, secrets);
      });
    });

    server.listen(port, host, () => {
      const services = [...serviceRegistry.keys()];
      logger.info({ port, host, services }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

// ── Auth mode detection (used by container-runner) ──────────────────

export type AuthMode = 'api-key' | 'oauth';

/** Detect which auth mode is configured for a given scope. */
export function detectAuthMode(scope: string): AuthMode {
  const secrets = credentialResolver(scope);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
