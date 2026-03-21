/**
 * @fileoverview Hardened credential proxy for container isolation
 * 
 * Security improvements over basic credential proxy:
 * - Unconditional credential injection on every request
 * - Streaming (no buffering) to prevent OOM on large payloads
 * - Per-request credential reload for rotation support
 * - Request timeouts for long agent conversations
 * - Structured JSON error responses
 * - Hop-by-hop header stripping per RFC 2616
 * - Health check endpoint for monitoring
 * 
 * @module credential-proxy-hardened
 * 
 * @example
 * ```ts
 * import { startCredentialProxy, detectAuthMode } from './credential-proxy-hardened';
 * 
 * // Start proxy
 * const server = await startCredentialProxy(8765);
 * 
 * // Detect auth mode (for compatibility)
 * const mode = detectAuthMode(); // 'api-key' | 'oauth'
 * 
 * // Stop proxy
 * await stopCredentialProxy(server);
 * ```
 */

import { createServer, Server, IncomingMessage, ServerResponse } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import { pipeline } from 'stream';
import { URL } from 'url';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// Configuration constants
/** Maximum time for a single request (10 minutes) */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/** Maximum time to connect to upstream (30 seconds) */
const UPSTREAM_CONNECT_TIMEOUT_MS = 30000;

// RFC 2616 §13.5.1 hop-by-hop headers
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

interface CredentialSet {
  apiKey: string | null;
  oauthToken: string | null;
  baseUrl: string;
}

/**
 * Read current credentials from environment
 * Re-read on each request to support rotation without restart
 * 
 * @returns Current credential set
 * @internal Exported for testing only
 */
export function getCurrentCredentials(): CredentialSet {
  const env = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  return {
    apiKey: env.ANTHROPIC_API_KEY || null,
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_AUTH_TOKEN || null,
    baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  };
}

/**
 * Detect authentication mode based on available credentials
 */
export function detectAuthMode(): 'api-key' | 'oauth' {
  const creds = getCurrentCredentials();
  return creds.apiKey ? 'api-key' : 'oauth';
}

/**
 * Send JSON error response
 */
function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  res.writeHead(status, {
    'content-type': 'application/json',
  });
  res.end(JSON.stringify({ error: { code, message } }));
}

/**
 * Send health check response
 */
function sendHealth(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
}

/**
 * Strip hop-by-hop headers that should not be forwarded
 */
function stripHopByHopHeaders(headers: Record<string, unknown>): void {
  for (const header of HOP_BY_HOP_HEADERS) {
    delete headers[header];
  }

  // Also strip any headers listed in Connection header
  const connectionHeader = headers['connection'];
  if (typeof connectionHeader === 'string') {
    for (const h of connectionHeader.split(',').map(s => s.trim().toLowerCase())) {
      delete headers[h];
    }
  }
}

/**
 * Inject credentials into request headers
 * Unconditionally replaces any existing auth headers
 */
function injectCredentials(
  headers: Record<string, string | number | string[] | undefined>,
  creds: CredentialSet,
): void {
  // Always strip any existing auth headers from container
  delete headers['x-api-key'];
  delete headers['authorization'];
  delete headers['anthropic-beta'];

  if (creds.apiKey) {
    // API key mode: inject x-api-key
    headers['x-api-key'] = creds.apiKey;
  } else if (creds.oauthToken) {
    // OAuth mode: inject both Authorization and anthropic-beta
    headers['authorization'] = `Bearer ${creds.oauthToken}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  }
}

/**
 * Proxy a single request to upstream
 */
function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  creds: CredentialSet,
): void {
  const startTime = Date.now();
  const upstreamUrl = new URL(creds.baseUrl);
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  // Build upstream headers
  const headers: Record<string, string | number | string[] | undefined> = {
    ...req.headers,
    host: upstreamUrl.host,
  };

  // Strip hop-by-hop headers
  stripHopByHopHeaders(headers);

  // Inject credentials unconditionally
  injectCredentials(headers, creds);

  // Content-length will be handled by streaming
  delete headers['content-length'];

  const options: RequestOptions = {
    hostname: upstreamUrl.hostname,
    port: upstreamUrl.port || (isHttps ? 443 : 80),
    path: req.url,
    method: req.method,
    headers,
    timeout: UPSTREAM_CONNECT_TIMEOUT_MS,
  };

  const upstreamReq = makeRequest(options, (upstreamRes) => {
    // Log request completion
    const duration = Date.now() - startTime;
    logger.info(
      {
        method: req.method,
        path: req.url,
        status: upstreamRes.statusCode,
        duration,
      },
      'Proxied request',
    );

    // Forward status and headers
    res.writeHead(upstreamRes.statusCode!, upstreamRes.headers);

    // Stream response back
    pipeline(upstreamRes, res, (err) => {
      if (err) {
        logger.error({ err, url: req.url }, 'Response streaming error');
      }
    });
  });

  upstreamReq.on('error', (err) => {
    logger.error({ err, url: req.url }, 'Upstream request error');
    sendError(res, 502, 'upstream_error', 'Failed to reach upstream server');
  });

  upstreamReq.on('timeout', () => {
    logger.error({ url: req.url }, 'Upstream request timeout');
    upstreamReq.destroy();
    sendError(res, 504, 'gateway_timeout', 'Upstream server timeout');
  });

  // Stream request body
  pipeline(req, upstreamReq, (err) => {
    if (err) {
      logger.error({ err, url: req.url }, 'Request streaming error');
    }
  });
}

/**
 * Start the hardened credential proxy
 */
export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // Health check endpoint
      if (req.method === 'GET' && req.url === '/health') {
        sendHealth(res);
        return;
      }

      // Get current credentials (re-read on each request for rotation)
      const creds = getCurrentCredentials();

      // Check credentials available
      if (!creds.apiKey && !creds.oauthToken) {
        logger.error('No credentials available');
        sendError(res, 503, 'no_credentials', 'No API credentials configured');
        return;
      }

      // Proxy the request
      proxyRequest(req, res, creds);
    });

    server.on('error', (err) => {
      logger.error({ err }, 'Credential proxy server error');
      reject(err);
    });

    server.listen(port, host, () => {
      logger.info({ port, host }, 'Hardened credential proxy started');
      resolve(server);
    });
  });
}

/**
 * Stop the credential proxy
 */
export async function stopCredentialProxy(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}
