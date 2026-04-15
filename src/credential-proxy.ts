/**
 * コンテナを分離するための認証情報プロキシ。
 * コンテナは Anthropic API に直接接続する代わりに、ここを介して接続します。
 * プロキシが実際の認証情報を注入するため、コンテナがそれらを知ることはありません。
 *
 * 2 つの認証モード:
 *   API キー: プロキシがすべてのリクエストに x-api-key を注入します。
 *   OAuth:   コンテナ CLI が /api/oauth/claude_cli/create_api_key を介して、
 *            プレースホルダー・トークンを一時的な API キーに交換します。
 *            プロキシはその交換リクエストに実際の OAuth トークンを注入します。
 *            その後のリクエストは一時的なキーをそのまま使用します。
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

        // プロキシによって転送してはならないホップバイホップ・ヘッダーを削除
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          // API キーモード: すべてのリクエストに x-api-key を注入
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth モード: コンテナが実際に Authorization ヘッダーを送信したときのみ、
          // プレースホルダーの Bearer トークンを本物のトークンに置き換える
          // （交換リクエスト + 認証プローブ）。交換後のリクエストは x-api-key のみを
          // 使用するため、トークン注入なしでそのまま通過する。
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
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** ホストに設定されている認証モードを検出します。 */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
