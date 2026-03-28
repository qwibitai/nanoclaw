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
 *
 * Room API proxy:
 *   Requests with path prefix /room-api/ are forwarded to the Room platform
 *   API (e.g. room1.attyzen.com). The proxy injects SELF_HOSTED_API_SECRET
 *   as X-Api-Secret header for music-gen, and generates HMAC signatures for
 *   facebook-page-manager requests. Containers never see these secrets.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import crypto from 'crypto';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

// ─── Room API proxy helpers ─────────────────────────────────────────────────

const ROOM_API_PREFIX = '/room-api/';

/** Generate HMAC-SHA256 signature for facebook-page-manager server-to-server auth. */
function signFacebookRequest(
  secret: string,
  method: string,
  path: string,
  timestamp: string,
  body: string,
): string {
  const payload = `${method}\n${path}\n${timestamp}\n${body}`;
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('base64');
}

/** Route a Room API request to the correct upstream service with auth. */
function handleRoomApiRequest(
  req: { url?: string; method?: string },
  res: import('http').ServerResponse,
  body: Buffer,
  roomSecrets: {
    roomApiUrl: string;
    selfHostedApiSecret: string;
    musicGenServiceUrl: string;
    facebookServiceUrl: string;
  },
): void {
  const reqPath = (req.url || '').slice(ROOM_API_PREFIX.length - 1); // keep leading /
  const method = (req.method || 'GET').toUpperCase();
  const bodyStr = body.toString();

  let targetUrl: URL;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'content-length': String(body.length),
  };

  if (reqPath.startsWith('/music-gen/')) {
    // Music-gen service: strip /music-gen prefix, add X-Api-Secret
    const servicePath = reqPath.slice('/music-gen'.length);
    targetUrl = new URL(servicePath, roomSecrets.musicGenServiceUrl);
    if (roomSecrets.selfHostedApiSecret) {
      headers['x-api-secret'] = roomSecrets.selfHostedApiSecret;
    }
  } else if (reqPath.startsWith('/facebook/')) {
    // Facebook page manager: strip /facebook prefix, add Bearer + HMAC
    const servicePath = reqPath.slice('/facebook'.length);
    targetUrl = new URL(servicePath, roomSecrets.facebookServiceUrl);
    if (roomSecrets.selfHostedApiSecret) {
      const timestamp = Date.now().toString();
      const signature = signFacebookRequest(
        roomSecrets.selfHostedApiSecret,
        method,
        servicePath,
        timestamp,
        bodyStr,
      );
      headers['authorization'] = `Bearer ${roomSecrets.selfHostedApiSecret}`;
      headers['x-request-timestamp'] = timestamp;
      headers['x-request-signature'] = signature;
    }
  } else if (reqPath.startsWith('/api/')) {
    // Room Worker API (room1.attyzen.com/api/...): pass through with auth cookie/header
    targetUrl = new URL(reqPath, roomSecrets.roomApiUrl);
    if (roomSecrets.selfHostedApiSecret) {
      headers['x-api-secret'] = roomSecrets.selfHostedApiSecret;
    }
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: `Unknown Room API route: ${reqPath}` }));
    return;
  }

  const isHttps = targetUrl.protocol === 'https:';
  const makeReq = isHttps ? httpsRequest : httpRequest;

  const upstream = makeReq(
    {
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method,
      headers,
    } as RequestOptions,
    (upRes) => {
      res.writeHead(upRes.statusCode!, upRes.headers);
      upRes.pipe(res);
    },
  );

  upstream.on('error', (err) => {
    logger.error({ err, url: targetUrl.href }, 'Room API proxy upstream error');
    if (!res.headersSent) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: 'Room API upstream error' }));
    }
  });

  upstream.write(body);
  upstream.end();
}

// ─── Main proxy ─────────────────────────────────────────────────────────────

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ROOM_API_URL',
    'SELF_HOSTED_API_SECRET',
    'MUSIC_GEN_SERVICE_URL',
    'FACEBOOK_SERVICE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  // Room API configuration (optional — only available when configured)
  const roomSecrets = {
    roomApiUrl: secrets.ROOM_API_URL || 'https://room1.attyzen.com',
    selfHostedApiSecret: secrets.SELF_HOSTED_API_SECRET || '',
    musicGenServiceUrl:
      secrets.MUSIC_GEN_SERVICE_URL ||
      'https://music-gen-container.attyzen.com',
    facebookServiceUrl:
      secrets.FACEBOOK_SERVICE_URL ||
      'https://facebook-page-manager-container.attyzen.com',
  };

  const roomApiConfigured = !!roomSecrets.selfHostedApiSecret;
  if (roomApiConfigured) {
    logger.info(
      {
        roomApiUrl: roomSecrets.roomApiUrl,
        musicGen: roomSecrets.musicGenServiceUrl,
        facebook: roomSecrets.facebookServiceUrl,
      },
      'Room API proxy enabled',
    );
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // ── Room API proxy: /room-api/* ──────────────────────────────
        if (req.url?.startsWith(ROOM_API_PREFIX)) {
          if (!roomApiConfigured) {
            res.writeHead(503);
            res.end(
              JSON.stringify({
                error:
                  'Room API not configured. Set SELF_HOSTED_API_SECRET in .env',
              }),
            );
            return;
          }
          handleRoomApiRequest(req, res, body, roomSecrets);
          return;
        }

        // ── Anthropic API proxy (default) ────────────────────────────
        const headers: Record<
          string,
          string | number | string[] | undefined
        > = {
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
      logger.info(
        { port, host, authMode, roomApi: roomApiConfigured },
        'Credential proxy started',
      );
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

/** Check if Room API credentials are configured. */
export function isRoomApiConfigured(): boolean {
  const secrets = readEnvFile(['SELF_HOSTED_API_SECRET']);
  return !!secrets.SELF_HOSTED_API_SECRET;
}
