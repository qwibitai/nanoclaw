/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Three auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *   Vertex:   Container SDK sends requests here with CLAUDE_CODE_SKIP_VERTEX_AUTH=1
 *             (no GCP creds in container). Proxy obtains Google OAuth2 tokens
 *             on the host and injects Bearer auth before forwarding to the
 *             real Vertex AI endpoint.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth' | 'vertex';

export interface ProxyConfig {
  authMode: AuthMode;
}

/** Vertex AI config read from .env. */
export interface VertexConfig {
  region: string;
  projectId: string;
}

/**
 * Lazily obtain a Google OAuth2 access token using Application Default Credentials.
 * Caches the auth client across calls; the library handles token refresh internally.
 */
async function getGoogleAccessToken(credentialsPath?: string): Promise<string> {
  // Dynamic import so google-auth-library is only loaded for Vertex mode
  const { GoogleAuth } = await import('google-auth-library');
  // Re-use a singleton auth instance (stored on the function itself)
  if (!(getGoogleAccessToken as any)._auth) {
    (getGoogleAccessToken as any)._auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      ...(credentialsPath ? { keyFile: credentialsPath } : {}),
    });
  }
  const auth: InstanceType<typeof GoogleAuth> = (getGoogleAccessToken as any)
    ._auth;
  const token = await auth.getAccessToken();
  if (!token) throw new Error('Failed to obtain Google access token');
  return token;
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
    'CLAUDE_CODE_USE_VERTEX',
    'CLOUD_ML_REGION',
    'ANTHROPIC_VERTEX_PROJECT_ID',
    'GOOGLE_APPLICATION_CREDENTIALS',
  ]);

  const authMode: AuthMode = secrets.CLAUDE_CODE_USE_VERTEX
    ? 'vertex'
    : secrets.ANTHROPIC_API_KEY
      ? 'api-key'
      : 'oauth';

  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  // For api-key and oauth modes, upstream is api.anthropic.com (or custom base URL)
  // For vertex mode, upstream is {region}-aiplatform.googleapis.com
  const vertexRegion = secrets.CLOUD_ML_REGION;
  const upstreamUrl = new URL(
    authMode === 'vertex'
      ? vertexRegion === 'global'
        ? 'https://aiplatform.googleapis.com/v1'
        : `https://${vertexRegion}-aiplatform.googleapis.com/v1`
      : secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  const gcpCredentialsPath = secrets.GOOGLE_APPLICATION_CREDENTIALS;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
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
        } else if (authMode === 'vertex') {
          // Vertex mode: obtain Google OAuth2 token and inject as Bearer auth.
          // The container SDK sends requests with no real auth
          // (CLAUDE_CODE_SKIP_VERTEX_AUTH=1).
          try {
            const accessToken = await getGoogleAccessToken(gcpCredentialsPath);
            delete headers['authorization'];
            headers['authorization'] = `Bearer ${accessToken}`;
          } catch (err) {
            logger.error({ err }, 'Failed to obtain Google access token');
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Failed to obtain Google credentials');
            }
            return;
          }
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

        // For Vertex AI, the upstream URL includes a path prefix (/v1) that
        // must be prepended to the request path from the container SDK.
        const upstreamPathPrefix = upstreamUrl.pathname.replace(/\/$/, '');
        const forwardPath =
          upstreamPathPrefix !== '/' ? upstreamPathPrefix + req.url : req.url;

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: forwardPath,
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
  const secrets = readEnvFile(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_VERTEX']);
  if (secrets.CLAUDE_CODE_USE_VERTEX) return 'vertex';
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}

/** Read Vertex AI config from .env (region + project ID). */
export function readVertexConfig(): VertexConfig | null {
  const env = readEnvFile(['CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID']);
  if (!env.CLOUD_ML_REGION || !env.ANTHROPIC_VERTEX_PROJECT_ID) return null;
  return {
    region: env.CLOUD_ML_REGION,
    projectId: env.ANTHROPIC_VERTEX_PROJECT_ID,
  };
}
