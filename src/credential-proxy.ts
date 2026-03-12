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
 * Routing is determined by the Host header in incoming requests.
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

/** Service configuration for routing */
interface ServiceConfig {
  hostname: string;
  baseUrl: string;
  port: number;
  isHttps: boolean;
}

/** Service types that the proxy can route to */
type ServiceType = 'anthropic' | 'groq' | 'openai';

/** Determine service type from the Host header */
function detectServiceType(hostHeader: string | undefined): ServiceType {
  if (!hostHeader) return 'anthropic';

  const host = hostHeader.split(':')[0].toLowerCase();

  // Route by hostname patterns
  if (host === 'api.anthropic.com' || host.endsWith('.api.anthropic.com')) {
    return 'anthropic';
  }
  if (host === 'api.groq.com' || host.endsWith('.api.groq.com')) {
    return 'groq';
  }
  if (host === 'api.openai.com' || host.endsWith('.api.openai.com')) {
    return 'openai';
  }

  // Default to Anthropic for backward compatibility
  return 'anthropic';
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
    case 'groq':
      return {
        hostname: 'api.groq.com',
        baseUrl: 'https://api.groq.com',
        port: 443,
        isHttps: true,
      };
    case 'openai':
      return {
        hostname: 'api.openai.com',
        baseUrl: 'https://api.openai.com',
        port: 443,
        isHttps: true,
      };
  }
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
    'GROQ_API_KEY',
    'OPENAI_API_KEY',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        // Determine the target service from the Host header
        const serviceType = detectServiceType(req.headers.host);
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
    });

    server.listen(port, host, () => {
      logger.info(
        {
          port,
          host,
          authMode,
          services: {
            anthropic: !!secrets.ANTHROPIC_API_KEY || !!oauthToken,
            groq: !!secrets.GROQ_API_KEY,
            openai: !!secrets.OPENAI_API_KEY,
          },
        },
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
