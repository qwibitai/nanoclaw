/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the API endpoints.
 * The proxy injects real credentials so containers never see them.
 *
 * Supports multiple upstream services:
 * - Anthropic: Two auth modes
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 * - Groq:     Proxy injects Authorization: Bearer <GROQ_API_KEY>
 * - OpenAI:   Proxy injects Authorization: Bearer <OPENAI_API_KEY>
 *
 * Routing is port-based: each service gets its own listener on a dedicated port.
 * This avoids Host header routing issues since SDKs don't send correct Host headers
 * when using BASE_URL overrides.
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

/** Service types that the proxy can route to */
type ServiceType = 'anthropic' | 'groq' | 'openai';

/** Service configuration for routing */
interface ServiceConfig {
  hostname: string;
  baseUrl: string;
  port: number;
  isHttps: boolean;
}

/** Get service configuration based on service type */
function getServiceConfig(
  serviceType: ServiceType,
  secrets: Record<string, string | undefined>,
): ServiceConfig {
  switch (serviceType) {
    case 'anthropic': {
      const baseUrl = secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
      const url = new URL(baseUrl);
      return {
        hostname: url.hostname,
        baseUrl,
        port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80),
        isHttps: url.protocol === 'https:',
      };
    }
    case 'groq': {
      const baseUrl = secrets.GROQ_BASE_URL || 'https://api.groq.com';
      const url = new URL(baseUrl);
      return {
        hostname: url.hostname,
        baseUrl,
        port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80),
        isHttps: url.protocol === 'https:',
      };
    }
    case 'openai': {
      const baseUrl = secrets.OPENAI_BASE_URL || 'https://api.openai.com';
      const url = new URL(baseUrl);
      return {
        hostname: url.hostname,
        baseUrl,
        port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 80),
        isHttps: url.protocol === 'https:',
      };
    }
  }
}

/** Create a request handler for a specific service type */
function createRequestHandler(
  serviceType: ServiceType,
  secrets: Record<string, string | undefined>,
) {
  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  return (req: any, res: any) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const serviceConfig = getServiceConfig(serviceType, secrets);
      const upstreamUrl = new URL(serviceConfig.baseUrl);
      const makeRequest = serviceConfig.isHttps ? httpsRequest : httpRequest;

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

      // Inject appropriate credentials based on service type
      if (serviceType === 'anthropic') {
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
      } else if (serviceType === 'groq') {
        // Groq uses Bearer token in Authorization header
        if (secrets.GROQ_API_KEY) {
          delete headers['authorization'];
          headers['authorization'] = `Bearer ${secrets.GROQ_API_KEY}`;
        }
      } else if (serviceType === 'openai') {
        // OpenAI uses Bearer token in Authorization header
        if (secrets.OPENAI_API_KEY) {
          delete headers['authorization'];
          headers['authorization'] = `Bearer ${secrets.OPENAI_API_KEY}`;
        }
      }

      const upstream = makeRequest(
        {
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port || (serviceConfig.isHttps ? 443 : 80),
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
          { err, url: req.url, service: serviceType },
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
  };
}

/** Wrapper to hold multiple servers for different services */
export interface CredentialProxyServers {
  anthropic: Server | null;
  groq: Server | null;
  openai: Server | null;
  close: () => void;
}

/**
 * Start credential proxy servers.
 * Each service gets its own port-based listener to avoid Host header routing issues.
 */
export function startCredentialProxies(
  ports: {
    anthropic: number;
    groq: number;
    openai: number;
  },
  host = '127.0.0.1',
): Promise<CredentialProxyServers> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'GROQ_API_KEY',
    'GROQ_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const servers: CredentialProxyServers = {
    anthropic: null,
    groq: null,
    openai: null,
    close: () => {
      servers.anthropic?.close();
      servers.groq?.close();
      servers.openai?.close();
    },
  };

  const startServer = (
    serviceType: ServiceType,
    port: number,
  ): Promise<Server> => {
    return new Promise((resolve, reject) => {
      const server = createServer(
        createRequestHandler(serviceType, secrets),
      );

      server.listen(port, host, () => {
        logger.info(
          {
            port,
            host,
            service: serviceType,
          },
          `Credential proxy server started for ${serviceType}`,
        );
        resolve(server);
      });

      server.on('error', reject);
    });
  };

  // Start Anthropic proxy (always required)
  return startServer('anthropic', ports.anthropic).then((anthropicServer) => {
    servers.anthropic = anthropicServer;

    // Start Groq proxy if key is configured
    const groqPromise = secrets.GROQ_API_KEY
      ? startServer('groq', ports.groq).then((s) => {
          servers.groq = s;
          return s;
        })
      : Promise.resolve(null);

    // Start OpenAI proxy if key is configured
    const openaiPromise = secrets.OPENAI_API_KEY
      ? startServer('openai', ports.openai).then((s) => {
          servers.openai = s;
          return s;
        })
      : Promise.resolve(null);

    return Promise.all([groqPromise, openaiPromise]).then(() => {
      logger.info(
        {
          authMode,
          services: {
            anthropic: {
              port: ports.anthropic,
              configured: !!secrets.ANTHROPIC_API_KEY || !!oauthToken,
            },
            groq: {
              port: ports.groq,
              configured: !!secrets.GROQ_API_KEY,
            },
            openai: {
              port: ports.openai,
              configured: !!secrets.OPENAI_API_KEY,
            },
          },
        },
        'All credential proxy servers started',
      );
      return servers;
    });
  });
}

/**
 * Legacy function for backward compatibility.
 * Starts all proxy servers on the default ports.
 */
export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  // For backward compatibility, start all proxies but return only the Anthropic one
  // The legacy port parameter is used as the Anthropic port
  return startCredentialProxies(
    {
      anthropic: port,
      groq: port + 1,
      openai: port + 2,
    },
    host,
  ).then((servers) => servers.anthropic!);
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
