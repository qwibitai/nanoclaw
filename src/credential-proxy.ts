/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to AI provider APIs.
 * The proxy injects real credentials so containers never see them.
 *
 * Anthropic proxy (port 3001) — backbone, two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Provider proxies (ports 3002–3005) — one per additional AI provider:
 *   OpenRouter (3002): Anthropic-API-compatible, supports all Claude models.
 *                      Requires OPENROUTER_API_KEY. Path-prefixes /v1/* → /api/v1/*.
 *   OpenAI    (3003): OpenAI-compatible, for tool-level calls from the agent.
 *                      Requires OPENAI_API_KEY.
 *   Gemini    (3004): Google Gemini OpenAI-compatible endpoint.
 *                      Requires GEMINI_API_KEY.
 *   Moonshot  (3005): Moonshot AI OpenAI-compatible endpoint.
 *                      Requires MOONSHOT_API_KEY.
 *
 * Provider proxies only start when the matching key is present in .env.
 * The agent accesses secondary providers via NANOCLAW_*_URL env vars.
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

// ─── Anthropic proxy (unchanged public API) ───────────────────────────────────

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

// ─── Provider proxies (OpenRouter, OpenAI, Gemini, Moonshot) ─────────────────

interface ProviderConfig {
  name: string;
  port: number;
  /** Full base URL of the upstream API (e.g. 'https://openrouter.ai'). */
  upstreamBase: string;
  /**
   * Optional path prefix prepended to every forwarded request path.
   * Used for OpenRouter: SDK sends /v1/messages → proxy forwards /api/v1/messages.
   */
  upstreamPathPrefix?: string;
  /** .env keys to read and pass to injectAuth. */
  envKeys: string[];
  /** Mutate headers in-place to inject auth for this provider. */
  injectAuth(
    secrets: Record<string, string>,
    headers: Record<string, string | number | string[] | undefined>,
  ): void;
}

function buildProviderProxy(
  config: ProviderConfig,
  secrets: Record<string, string>,
  host: string,
): Promise<Server> {
  const upstreamUrl = new URL(config.upstreamBase);
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

        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        config.injectAuth(secrets, headers);

        const forwardPath = config.upstreamPathPrefix
          ? config.upstreamPathPrefix + req.url
          : req.url;

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
            { err, url: req.url, provider: config.name },
            'Provider proxy upstream error',
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

    server.listen(config.port, host, () => {
      logger.info(
        { port: config.port, host, provider: config.name },
        'Provider proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

// Port defaults match config.ts — read from process.env to avoid importing
// config.ts (which calls readEnvFile at module load, breaking test mocks).
const OPENROUTER_PROXY_PORT = parseInt(process.env.OPENROUTER_PROXY_PORT || '3002', 10);
const OPENAI_PROXY_PORT = parseInt(process.env.OPENAI_PROXY_PORT || '3003', 10);
const GEMINI_PROXY_PORT = parseInt(process.env.GEMINI_PROXY_PORT || '3004', 10);
const MOONSHOT_PROXY_PORT = parseInt(process.env.MOONSHOT_PROXY_PORT || '3005', 10);

const PROVIDER_CONFIGS: ProviderConfig[] = [
  {
    name: 'openrouter',
    port: OPENROUTER_PROXY_PORT,
    upstreamBase: 'https://openrouter.ai',
    // SDK sends /v1/messages; OpenRouter Anthropic-compatible endpoint is /api/v1/messages
    upstreamPathPrefix: '/api',
    envKeys: ['OPENROUTER_API_KEY'],
    injectAuth(secrets, headers) {
      delete headers['x-api-key'];
      delete headers['authorization'];
      if (secrets.OPENROUTER_API_KEY) {
        headers['authorization'] = `Bearer ${secrets.OPENROUTER_API_KEY}`;
        // OpenRouter recommended identification headers
        headers['http-referer'] = 'https://nanoclaw.app';
        headers['x-title'] = 'NanoClaw';
      }
    },
  },
  {
    name: 'openai',
    port: OPENAI_PROXY_PORT,
    upstreamBase: 'https://api.openai.com',
    envKeys: ['OPENAI_API_KEY'],
    injectAuth(secrets, headers) {
      delete headers['authorization'];
      if (secrets.OPENAI_API_KEY) {
        headers['authorization'] = `Bearer ${secrets.OPENAI_API_KEY}`;
      }
    },
  },
  {
    name: 'gemini',
    port: GEMINI_PROXY_PORT,
    upstreamBase: 'https://generativelanguage.googleapis.com',
    envKeys: ['GEMINI_API_KEY'],
    injectAuth(secrets, headers) {
      delete headers['authorization'];
      if (secrets.GEMINI_API_KEY) {
        headers['authorization'] = `Bearer ${secrets.GEMINI_API_KEY}`;
      }
    },
  },
  {
    name: 'moonshot',
    port: MOONSHOT_PROXY_PORT,
    upstreamBase: 'https://api.moonshot.cn',
    envKeys: ['MOONSHOT_API_KEY'],
    injectAuth(secrets, headers) {
      delete headers['authorization'];
      if (secrets.MOONSHOT_API_KEY) {
        headers['authorization'] = `Bearer ${secrets.MOONSHOT_API_KEY}`;
      }
    },
  },
];

/**
 * Start proxy servers for all AI providers that have an API key configured.
 * Returns an array of servers (for shutdown). Providers without a key are
 * silently skipped — the container will see a connection refused if it tries
 * to reach a provider that was not started.
 */
export async function startProviderProxies(
  host = '127.0.0.1',
): Promise<Server[]> {
  const allKeys = PROVIDER_CONFIGS.flatMap((c) => c.envKeys);
  const secrets = readEnvFile(allKeys);

  const servers: Server[] = [];
  for (const config of PROVIDER_CONFIGS) {
    const hasKey = config.envKeys.some((k) => !!secrets[k]);
    if (!hasKey) {
      logger.debug(
        { provider: config.name },
        'Provider proxy skipped (no API key configured)',
      );
      continue;
    }
    const server = await buildProviderProxy(config, secrets, host);
    servers.push(server);
  }

  return servers;
}
