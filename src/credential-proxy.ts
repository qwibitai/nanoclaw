/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the AI API.
 * The proxy injects real credentials so containers never see them.
 *
 * Provider modes:
 *   anthropic   — default, Anthropic Messages API (api-key or oauth auth)
 *   openrouter  — OpenRouter gateway (Anthropic-compat), injects Authorization + extra headers
 *   openai      — OpenAI-compatible API (Ollama, Grok, Groq, etc.), injects Bearer token
 *
 * Anthropic auth modes:
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
export type ProxyProvider = 'anthropic' | 'openrouter' | 'openai';

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
    'OPENROUTER_API_KEY',
    'OPENAI_API_KEY',
    'AGENT_PROVIDER',
    'OPENROUTER_SITE_URL',
    'OPENROUTER_SITE_NAME',
  ]);

  const provider: ProxyProvider = (() => {
    const p = (secrets.AGENT_PROVIDER || 'anthropic').toLowerCase();
    if (p === 'openrouter' || p === 'openai') return p;
    return 'anthropic';
  })();

  // Determine upstream URL based on provider
  let defaultUpstream: string;
  if (provider === 'openrouter') {
    defaultUpstream = 'https://openrouter.ai/api/v1';
  } else if (provider === 'openai' && secrets.ANTHROPIC_BASE_URL) {
    // ANTHROPIC_BASE_URL used to point at custom OpenAI-compat endpoint
    defaultUpstream = secrets.ANTHROPIC_BASE_URL;
  } else if (provider === 'openai') {
    defaultUpstream = 'https://api.openai.com/v1';
  } else {
    defaultUpstream = secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  }

  const upstreamUrl = new URL(defaultUpstream);
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  // Anthropic auth
  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

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

        if (provider === 'openrouter') {
          // OpenRouter uses Bearer Authorization + required site headers
          delete headers['x-api-key'];
          delete headers['authorization'];
          if (secrets.OPENROUTER_API_KEY) {
            headers['authorization'] = `Bearer ${secrets.OPENROUTER_API_KEY}`;
          }
          // OpenRouter requires these for rate limit attribution
          headers['http-referer'] =
            secrets.OPENROUTER_SITE_URL ||
            'https://github.com/abheejit/learnclaw';
          headers['x-title'] = secrets.OPENROUTER_SITE_NAME || 'LearnClaw';
        } else if (provider === 'openai') {
          // OpenAI-compatible: Bearer token in Authorization header
          delete headers['x-api-key'];
          delete headers['authorization'];
          if (secrets.OPENAI_API_KEY) {
            headers['authorization'] = `Bearer ${secrets.OPENAI_API_KEY}`;
          }
        } else if (authMode === 'api-key') {
          // Anthropic API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // Anthropic OAuth mode: replace placeholder Bearer token with the real one
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

        // Prepend the upstream base path (e.g. /api/v1 for OpenRouter)
        const upstreamBasePath = upstreamUrl.pathname.replace(/\/$/, '');
        const upstreamPath = upstreamBasePath + (req.url || '/');

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: upstreamPath,
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
        { port, host, provider, authMode },
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

/** Detect which provider the host is configured for. */
export function detectProvider(): ProxyProvider {
  const secrets = readEnvFile(['AGENT_PROVIDER']);
  const p = (secrets.AGENT_PROVIDER || 'anthropic').toLowerCase();
  if (p === 'openrouter' || p === 'openai') return p;
  return 'anthropic';
}
