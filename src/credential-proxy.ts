/**
 * コンテナを分離するための認証情報プロキシ。
 * コンテナは対応プロバイダー API に直接接続する代わりに、ここを介して接続します。
 * プロキシが実際の認証情報を注入するため、コンテナがそれらを知ることはありません。
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { logger } from './logger.js';
import { resolveProviderConfig } from './provider-config.js';

const PROVIDER_ROUTE_PREFIX = '/__provider/';

interface ProxyTarget {
  name: string;
  provider: 'anthropic' | 'openai';
  apiKey: string;
  upstreamBaseURL: string;
}

function buildUpstreamPath(upstreamUrl: URL, requestUrl?: string): string {
  const incomingPath = requestUrl?.startsWith('/')
    ? requestUrl
    : `/${requestUrl || ''}`;

  if (!upstreamUrl.pathname || upstreamUrl.pathname === '/') {
    return incomingPath || '/';
  }

  const basePath = upstreamUrl.pathname.endsWith('/')
    ? upstreamUrl.pathname.slice(0, -1)
    : upstreamUrl.pathname;

  if (
    incomingPath === basePath ||
    incomingPath.startsWith(`${basePath}/`) ||
    incomingPath.startsWith(`${basePath}?`)
  ) {
    return incomingPath;
  }

  return `${basePath}${incomingPath}`;
}

function injectAuthHeaders(
  headers: Record<string, string | number | string[] | undefined>,
  provider: 'anthropic' | 'openai',
  apiKey: string,
): void {
  if (provider === 'anthropic') {
    delete headers['x-api-key'];
    headers['x-api-key'] = apiKey;
    return;
  }

  delete headers['authorization'];
  headers['authorization'] = `Bearer ${apiKey}`;

  if (headers['x-api-key'] !== undefined) {
    delete headers['x-api-key'];
    headers['x-api-key'] = apiKey;
  }
}

function buildProxyTargets(): Record<string, ProxyTarget> {
  const resolvedConfig = resolveProviderConfig();
  const targets: Record<string, ProxyTarget> = {};

  for (const [name, provider] of Object.entries(resolvedConfig.providers)) {
    if (provider.provider !== 'anthropic' && provider.provider !== 'openai') {
      continue;
    }
    targets[name] = {
      name,
      provider: provider.provider,
      apiKey: provider.apiKey!,
      upstreamBaseURL: provider.upstreamBaseURL!,
    };
  }

  return targets;
}

function resolveProxyTarget(
  requestUrl: string | undefined,
  targets: Record<string, ProxyTarget>,
): { target: ProxyTarget; upstreamPath: string } | undefined {
  if (!requestUrl || !requestUrl.startsWith(PROVIDER_ROUTE_PREFIX)) {
    return undefined;
  }

  const rest = requestUrl.slice(PROVIDER_ROUTE_PREFIX.length);
  const slashIndex = rest.indexOf('/');
  const queryIndex = rest.indexOf('?');
  const endIndex =
    slashIndex === -1 && queryIndex === -1
      ? rest.length
      : slashIndex === -1
        ? queryIndex
        : queryIndex === -1
          ? slashIndex
          : Math.min(slashIndex, queryIndex);
  const namePart = rest.slice(0, endIndex);
  let providerName: string;
  try {
    providerName = decodeURIComponent(namePart);
  } catch {
    return undefined;
  }
  const target = targets[providerName];
  if (!target) return undefined;

  const suffix = rest.slice(endIndex) || '/';
  return { target, upstreamPath: suffix };
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const targets = buildProxyTargets();
      const routed = resolveProxyTarget(req.url, targets);
      
      if (!routed) {
        if (Object.keys(targets).length === 0) {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Credential proxy is disabled for the configured providers.');
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Unknown provider route');
        return;
      }

      const upstreamUrl = new URL(routed.target.upstreamBaseURL);
      const isHttps = upstreamUrl.protocol === 'https:';
      const makeRequest = isHttps ? httpsRequest : httpRequest;

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        const headers: Record<string, string | number | string[] | undefined> = {
          ...(req.headers as Record<string, string>),
          host: upstreamUrl.host,
          'content-length': body.length,
        };

        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        injectAuthHeaders(headers, routed.target.provider, routed.target.apiKey);

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: buildUpstreamPath(upstreamUrl, routed.upstreamPath),
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
            upRes.on('error', (err) => {
              logger.error(
                { err, url: req.url, provider: routed.target.name },
                'Credential proxy upstream response error',
              );
              if (!res.destroyed) res.destroy();
            });
          },
        );

        const applyKeepAlive = () => {
          if (!upstream.socket) return false;
          upstream.socket.setKeepAlive(true, 30_000);
          return true;
        };
        if (!applyKeepAlive()) {
          upstream.once('socket', () => {
            applyKeepAlive();
          });
        }

        res.on('close', () => {
          if (!res.writableEnded && !upstream.destroyed) {
            upstream.destroy();
          }
        });

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url, provider: routed.target.name },
            'Credential proxy upstream error',
          );
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          } else if (!res.destroyed) {
            res.destroy();
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      const initialTargets = buildProxyTargets();
      logger.info(
        { port, host, providers: Object.keys(initialTargets) },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}
