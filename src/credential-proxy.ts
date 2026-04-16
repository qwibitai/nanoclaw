/**
 * コンテナを分離するための認証情報プロキシ。
 * コンテナは対応プロバイダー API に直接接続する代わりに、ここを介して接続します。
 * プロキシが実際の認証情報を注入するため、コンテナがそれらを知ることはありません。
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { logger } from './logger.js';
import { detectActiveProviderConfig } from './provider-config.js';

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

  // OpenAI 互換 API は Authorization Bearer を使うのが標準だが、
  // x-api-key を使う実装にも対応できるよう、存在時は両方を置き換える。
  delete headers['authorization'];
  headers['authorization'] = `Bearer ${apiKey}`;

  if (headers['x-api-key'] !== undefined) {
    delete headers['x-api-key'];
    headers['x-api-key'] = apiKey;
  }
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const providerConfig = detectActiveProviderConfig();

  if (!providerConfig.usesCredentialProxy) {
    return new Promise((resolve, reject) => {
      const server = createServer((_req, res) => {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(
          `Credential proxy is disabled for provider ${providerConfig.provider}.`,
        );
      });

      server.listen(port, host, () => {
        logger.info(
          {
            port,
            host,
            provider: providerConfig.provider,
            usesCredentialProxy: false,
          },
          'Credential proxy started in disabled mode',
        );
        resolve(server);
      });

      server.on('error', reject);
    });
  }

  if (
    providerConfig.provider !== 'anthropic' &&
    providerConfig.provider !== 'openai'
  ) {
    throw new Error(
      `Credential proxy cannot route provider ${providerConfig.provider}.`,
    );
  }
  const proxiedProvider = providerConfig.provider;

  const upstreamUrl = new URL(providerConfig.upstreamBaseURL!);
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (!providerConfig.apiKey) {
          logger.error(
            { provider: providerConfig.provider },
            'API key is missing for proxied provider',
          );
          res.writeHead(500);
          res.end('Credential proxy misconfiguration');
          return;
        }

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // プロキシによって転送してはならないホップバイホップ・ヘッダーを削除
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        injectAuthHeaders(
          headers,
          proxiedProvider,
          providerConfig.apiKey,
        );

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
            // ストリーミング中の接続断を適切に処理
            upRes.on('error', (err) => {
              logger.error(
                { err, url: req.url },
                'Credential proxy upstream response error',
              );
              if (!res.destroyed) res.destroy();
            });
          },
        );

        // TCPキープアライブを有効化して長いストリーミング中の ETIMEDOUT を防ぐ。
        // 30_000 は最初の keepalive probe までの初期遅延（ms）で、以降の間隔は OS 依存。
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

        // 下流（コンテナ側）が切断したら upstream を即時中止する。
        res.on('close', () => {
          if (!res.writableEnded && !upstream.destroyed) {
            upstream.destroy();
          }
        });

        upstream.on('error', (err) => {
          logger.error(
            { err, url: req.url },
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
      logger.info(
        { port, host, provider: providerConfig.provider },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}
