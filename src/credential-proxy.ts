import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';
import fs from 'node:fs';
import path from 'node:path';
import { readEnvFile } from './env.js';
import { refreshMiniMaxToken } from './minimax-oauth.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth' | 'minimax-oauth';
export interface ProxyConfig {
  authMode: AuthMode;
}

function upsertEnvFile(key: string, val: string): void {
  const p = path.join(process.cwd(), '.env');
  let s = '';
  try {
    s = fs.readFileSync(p, 'utf8');
  } catch {}
  const re = new RegExp('^' + key + '=.*$', 'm');
  const line = key + '=' + val;
  s = re.test(s) ? s.replace(re, line) : s + '\n' + line;
  fs.writeFileSync(p, s.trimStart());
}

export async function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'MINIMAX_OAUTH_ACCESS',
    'MINIMAX_OAUTH_REFRESH',
    'MINIMAX_OAUTH_EXPIRES',
    'MINIMAX_BASE_URL',
  ]);
  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY
    ? 'api-key'
    : secrets.MINIMAX_OAUTH_ACCESS
      ? 'minimax-oauth'
      : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;
  let minimaxAccess = secrets.MINIMAX_OAUTH_ACCESS;
  const minimaxRefresh = secrets.MINIMAX_OAUTH_REFRESH;
  let minimaxExpires = Number(secrets.MINIMAX_OAUTH_EXPIRES || '0');
  const minimaxRegion: any = (secrets.MINIMAX_BASE_URL || '').includes(
    'minimaxi.com',
  )
    ? 'cn'
    : 'global';
  const upstreamStr =
    authMode === 'minimax-oauth'
      ? secrets.MINIMAX_BASE_URL || 'https://api.minimax.io/anthropic'
      : secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const upstreamUrl = new URL(upstreamStr);
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, any> = {
          ...(req.headers as Record<string, string>),
          host: upstreamUrl.host,
          'content-length': body.length,
        };
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (
          authMode === 'minimax-oauth' &&
          req.url &&
          req.url.startsWith('/v1/models')
        ) {
          const m = JSON.stringify({
            data: [{ id: 'MiniMax-M2.5', type: 'model' }],
          });
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(m),
          });
          res.end(m);
          return;
        }
        let finalBody = body;
        if (authMode === 'minimax-oauth' && body.length > 0) {
          try {
            const p = JSON.parse(body.toString());
            p.model = 'MiniMax-M2.5';
            delete p.betas;
            finalBody = Buffer.from(JSON.stringify(p));
            headers['content-length'] = finalBody.length;
          } catch {}
        }
        if (authMode === 'minimax-oauth') delete headers['anthropic-beta'];
        if (authMode === 'api-key') {
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else if (authMode === 'minimax-oauth') {
          if (minimaxRefresh && Date.now() > minimaxExpires - 60000) {
            try {
              const t = await refreshMiniMaxToken({
                refreshToken: minimaxRefresh,
                region: minimaxRegion,
              });
              minimaxAccess = t.access;
              minimaxExpires = t.expires;
              upsertEnvFile('MINIMAX_OAUTH_ACCESS', t.access);
              upsertEnvFile('MINIMAX_OAUTH_REFRESH', t.refresh);
              upsertEnvFile('MINIMAX_OAUTH_EXPIRES', String(t.expires));
              logger.info('MiniMax token refreshed');
            } catch (e) {
              logger.error({ err: e }, 'MiniMax token refresh failed');
            }
          }
          delete headers['authorization'];
          if (minimaxAccess)
            headers['authorization'] = 'Bearer ' + minimaxAccess;
        } else {
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) headers['authorization'] = 'Bearer ' + oauthToken;
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path:
              authMode === 'minimax-oauth'
                ? upstreamUrl.pathname.replace(/\/$/, '') + (req.url || '/')
                : req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );
        upstream.on('error', (err) => {
          logger.error({ err, url: req.url }, 'Proxy upstream error');
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });
        upstream.write(finalBody ?? body);
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

export function detectAuthMode(): AuthMode {
  const s = readEnvFile(['ANTHROPIC_API_KEY', 'MINIMAX_OAUTH_ACCESS']);
  return s.ANTHROPIC_API_KEY
    ? 'api-key'
    : s.MINIMAX_OAUTH_ACCESS
      ? 'minimax-oauth'
      : 'oauth';
}
