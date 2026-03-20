/**
 * OAS (OpenAeroStruct) MCP proxy for container isolation.
 * Containers connect here instead of directly to the OAS MCP server.
 * The proxy handles Keycloak ROPC authentication and injects Bearer tokens.
 *
 * Credentials are read from .env and never leave this module.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

interface TokenCache {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let tokenCache: TokenCache | null = null;

let secrets: ReturnType<typeof readEnvFile>;

function loadSecrets(): void {
  secrets = readEnvFile([
    'OAS_MCP_URL',
    'OAS_KEYCLOAK_TOKEN_URL',
    'OAS_CLIENT_ID',
    'OAS_CLIENT_SECRET',
    'OAS_USERNAME',
    'OAS_PASSWORD',
  ]);
}

async function fetchOasToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }

  const tokenUrl = new URL(secrets.OAS_KEYCLOAK_TOKEN_URL!);
  const params: Record<string, string> = {
    grant_type: 'password',
    client_id: secrets.OAS_CLIENT_ID || 'nanoclaw',
    username: secrets.OAS_USERNAME!,
    password: secrets.OAS_PASSWORD!,
    scope: 'openid mcp:tools',
  };
  if (secrets.OAS_CLIENT_SECRET) {
    params.client_secret = secrets.OAS_CLIENT_SECRET;
  }
  const body = new URLSearchParams(params).toString();

  const isHttps = tokenUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = makeRequest(
      {
        hostname: tokenUrl.hostname,
        port: tokenUrl.port || (isHttps ? 443 : 80),
        path: tokenUrl.pathname + tokenUrl.search,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
        },
      } as RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString();
          logger.debug(
            { statusCode: res.statusCode, bodyLength: raw.length },
            'Keycloak token response',
          );
          try {
            const data = JSON.parse(raw);
            if (!data.access_token) {
              reject(
                new Error(
                  `Keycloak token response missing access_token: ${JSON.stringify(data)}`,
                ),
              );
              return;
            }
            const expiresIn = (data.expires_in || 300) as number;
            tokenCache = {
              accessToken: data.access_token,
              expiresAt: Date.now() + (expiresIn - 60) * 1000, // 60s safety margin
            };
            logger.debug({ expiresIn }, 'OAS token fetched');
            resolve(tokenCache.accessToken);
          } catch (err) {
            reject(new Error(`Failed to parse Keycloak response: ${err}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export function startOasProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  loadSecrets();

  const upstreamUrl = new URL(secrets.OAS_MCP_URL!);
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);

        let token: string;
        try {
          token = await fetchOasToken();
        } catch (err) {
          logger.error({ err }, 'OAS proxy: failed to fetch token');
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Failed to obtain OAS token');
          }
          return;
        }

        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
            authorization: `Bearer ${token}`,
          };

        // Strip hop-by-hop headers
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: upstreamUrl.pathname,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            // On 401, invalidate cache and retry once
            if (upRes.statusCode === 401 && tokenCache) {
              tokenCache = null;
              logger.warn('OAS proxy: upstream 401, retrying with fresh token');
              // Drain the response before retrying
              upRes.resume();
              fetchOasToken()
                .then((freshToken) => {
                  headers.authorization = `Bearer ${freshToken}`;
                  const retry = makeRequest(
                    {
                      hostname: upstreamUrl.hostname,
                      port: upstreamUrl.port || (isHttps ? 443 : 80),
                      path: upstreamUrl.pathname,
                      method: req.method,
                      headers,
                    } as RequestOptions,
                    (retryRes) => {
                      res.writeHead(retryRes.statusCode!, retryRes.headers);
                      retryRes.pipe(res);
                    },
                  );
                  retry.on('error', (err) => {
                    logger.error({ err }, 'OAS proxy retry upstream error');
                    if (!res.headersSent) {
                      res.writeHead(502);
                      res.end('Bad Gateway');
                    }
                  });
                  retry.write(body);
                  retry.end();
                })
                .catch((err) => {
                  logger.error({ err }, 'OAS proxy: retry token fetch failed');
                  if (!res.headersSent) {
                    res.writeHead(502);
                    res.end('Failed to refresh OAS token');
                  }
                });
              return;
            }

            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          logger.error({ err, url: req.url }, 'OAS proxy upstream error');
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
      logger.info({ port, host }, 'OAS MCP proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}
