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

import {
  AgentBackend,
  CredentialAuthMode,
  getAgentBackendConfig,
} from './agent-backend.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = CredentialAuthMode;

export interface ProxyConfig {
  backend: AgentBackend;
  authMode: AuthMode;
  upstreamUrl: URL;
  openAIApiKey?: string;
  anthropicApiKey?: string;
  oauthToken?: string;
}

function getProxyConfig(): ProxyConfig {
  const backendConfig = getAgentBackendConfig();

  if (backendConfig.backend === 'openai') {
    const secrets = readEnvFile(['OPENAI_API_KEY']);
    return {
      backend: 'openai',
      authMode: 'api-key',
      upstreamUrl: new URL(backendConfig.upstreamBaseUrl),
      openAIApiKey: process.env.OPENAI_API_KEY || secrets.OPENAI_API_KEY,
    };
  }

  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
  ]);

  return {
    backend: 'claude',
    authMode: backendConfig.authMode,
    upstreamUrl: new URL(backendConfig.upstreamBaseUrl),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || secrets.ANTHROPIC_API_KEY,
    oauthToken:
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      process.env.ANTHROPIC_AUTH_TOKEN ||
      secrets.CLAUDE_CODE_OAUTH_TOKEN ||
      secrets.ANTHROPIC_AUTH_TOKEN,
  };
}

function buildUpstreamPath(
  upstreamUrl: URL,
  requestPath: string | undefined,
): string {
  const basePath =
    upstreamUrl.pathname && upstreamUrl.pathname !== '/'
      ? upstreamUrl.pathname.replace(/\/$/, '')
      : '';
  const normalizedRequestPath = requestPath?.startsWith('/')
    ? requestPath
    : `/${requestPath || ''}`;
  return `${basePath}${normalizedRequestPath}`;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const config = getProxyConfig();
  const { authMode, backend, upstreamUrl } = config;
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

        if (backend === 'openai') {
          delete headers['authorization'];
          headers['authorization'] = `Bearer ${config.openAIApiKey || ''}`;
        } else if (authMode === 'api-key') {
          delete headers['x-api-key'];
          headers['x-api-key'] = config.anthropicApiKey;
        } else {
          if (headers['authorization']) {
            delete headers['authorization'];
            if (config.oauthToken) {
              headers['authorization'] = `Bearer ${config.oauthToken}`;
            }
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: buildUpstreamPath(upstreamUrl, req.url),
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
        { port, host, authMode, backend },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  return getProxyConfig().authMode;
}
