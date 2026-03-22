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
 *
 * Auto-refresh (OAuth mode):
 *   Reads access + refresh tokens from ~/.claude/.credentials.json.
 *   When upstream returns 401, automatically refreshes using the refresh
 *   token (standard OAuth2 flow), updates the credentials file, and
 *   retries the request. Only alerts CEO if the refresh token itself fails.
 *   Access token expiration never causes downtime.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, IncomingMessage, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

// Credentials file path (where Claude Code stores OAuth tokens)
const CREDENTIALS_PATH = path.join(
  os.homedir(),
  '.claude',
  '.credentials.json',
);

// Anthropic OAuth endpoints
const OAUTH_BASE = 'https://claude.ai';
const TOKEN_ENDPOINT = '/api/oauth/token';

// Rate-limit refresh attempts to prevent loops
let lastRefreshAttempt = 0;
const REFRESH_COOLDOWN_MS = 30_000; // 30 seconds between attempts

// Outage tracking — self-healing when Anthropic API goes down and comes back
let isInOutage = false;
let outageAlertSent = false;
let outageStartedAt = 0;
let healthCheckTimer: ReturnType<typeof setTimeout> | null = null;
const HEALTH_CHECK_BACKOFF_MS = [30_000, 60_000, 120_000, 300_000]; // 30s → 1m → 2m → 5m cap
const OUTAGE_STATUS_CODES = new Set([500, 502, 503, 529]); // Anthropic outage indicators

interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

/**
 * Read OAuth credentials from ~/.claude/.credentials.json.
 * Falls back to .env CLAUDE_CODE_OAUTH_TOKEN if file doesn't exist.
 */
function loadCredentials(envFallback?: string): {
  accessToken: string;
  refreshToken: string | null;
} {
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const data = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
      const oauth: OAuthCredentials = data.claudeAiOauth;
      if (oauth?.accessToken) {
        return {
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken || null,
        };
      }
    }
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read credentials.json, falling back to .env',
    );
  }

  // Fallback to .env token (no refresh capability)
  return {
    accessToken: envFallback || '',
    refreshToken: null,
  };
}

/**
 * Save refreshed credentials back to ~/.claude/.credentials.json.
 */
function saveCredentials(
  newAccessToken: string,
  newRefreshToken: string,
  expiresIn: number,
): void {
  try {
    let data: Record<string, unknown> = {};
    if (fs.existsSync(CREDENTIALS_PATH)) {
      data = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    }

    const existing = (data.claudeAiOauth || {}) as Record<string, unknown>;
    data.claudeAiOauth = {
      ...existing,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    };

    const dir = path.dirname(CREDENTIALS_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(data, null, 2));
    fs.chmodSync(CREDENTIALS_PATH, 0o600);

    logger.info('OAuth credentials refreshed and saved');
  } catch (err) {
    logger.error({ err }, 'Failed to save refreshed credentials');
  }
}

/**
 * Typed refresh result — distinguishes network errors (outage) from token errors (real auth issue).
 */
type RefreshResult =
  | { ok: true; accessToken: string; refreshToken: string; expiresIn: number }
  | { ok: false; reason: 'network_error' | 'token_invalid' | 'server_error' };

/**
 * Use the refresh token to obtain a new access token.
 * Standard OAuth2 refresh_token grant.
 * Returns typed result so callers can distinguish outage from real auth failure.
 */
function refreshAccessToken(refreshToken: string): Promise<RefreshResult> {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', // Claude Code public client ID
    });

    const req = httpsRequest(
      {
        hostname: 'claude.ai',
        port: 443,
        path: TOKEN_ENDPOINT,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 15_000, // 15s timeout to detect unreachable API quickly
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            if (res.statusCode === 200 && body.access_token) {
              resolve({
                ok: true,
                accessToken: body.access_token,
                refreshToken: body.refresh_token || refreshToken,
                expiresIn: body.expires_in || 3600,
              });
            } else if (OUTAGE_STATUS_CODES.has(res.statusCode!)) {
              // Server error = outage, not a token problem
              logger.warn(
                { statusCode: res.statusCode },
                'OAuth refresh got server error — likely outage',
              );
              resolve({ ok: false, reason: 'server_error' });
            } else {
              // 400/401/403 = token itself is bad
              logger.error(
                { statusCode: res.statusCode, error: body.error },
                'OAuth refresh failed — token may be invalid',
              );
              resolve({ ok: false, reason: 'token_invalid' });
            }
          } catch (err) {
            logger.error({ err }, 'Failed to parse refresh response');
            resolve({ ok: false, reason: 'server_error' });
          }
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      logger.warn('OAuth refresh request timed out — API unreachable');
      resolve({ ok: false, reason: 'network_error' });
    });

    req.on('error', (err) => {
      logger.error({ err }, 'OAuth refresh request error — network issue');
      resolve({ ok: false, reason: 'network_error' });
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Enter outage mode and start background health-check recovery loop.
 * Polls with exponential backoff. When API comes back, refreshes tokens
 * and resumes service automatically — no CEO intervention needed.
 */
function startOutageRecovery(creds: {
  accessToken: string;
  refreshToken: string | null;
}): void {
  if (healthCheckTimer) return; // already recovering

  if (!isInOutage) {
    isInOutage = true;
    outageStartedAt = Date.now();
  }

  // Alert CEO once, not every 30 seconds
  if (!outageAlertSent) {
    outageAlertSent = true;
    sendTelegramAlert(
      '*Anthropic API Outage Detected*\n\n' +
        'Atlas credential proxy cannot reach the API. ' +
        'Auto-recovery is active — will restore service automatically when the outage ends.\n\n' +
        'No action needed unless this persists for hours.',
    );
  }

  let attempt = 0;

  const tryRecover = async (): Promise<void> => {
    if (!creds.refreshToken) {
      logger.error('No refresh token available for outage recovery');
      return;
    }

    const result = await refreshAccessToken(creds.refreshToken);

    if (result.ok) {
      // API is back — save tokens, restore service
      saveCredentials(
        result.accessToken,
        result.refreshToken,
        result.expiresIn,
      );
      creds.accessToken = result.accessToken;
      creds.refreshToken = result.refreshToken;

      isInOutage = false;
      outageAlertSent = false;
      healthCheckTimer = null;

      const downtimeMin = Math.round((Date.now() - outageStartedAt) / 60_000);
      logger.info(
        { downtimeMinutes: downtimeMin },
        'Outage resolved — auto-recovered',
      );
      sendTelegramAlert(
        '*API Recovered*\n\n' +
          `Atlas auto-recovered after ~${downtimeMin} minute(s). ` +
          'Tokens refreshed, service fully restored.',
      );
    } else if (!result.ok) {
      // Still down — schedule next check with backoff
      const delay =
        HEALTH_CHECK_BACKOFF_MS[
          Math.min(attempt, HEALTH_CHECK_BACKOFF_MS.length - 1)
        ];
      attempt++;
      logger.info(
        {
          attempt,
          nextCheckSec: Math.round(delay / 1000),
          reason: result.reason,
        },
        'Outage persists — scheduling next health check',
      );
      healthCheckTimer = setTimeout(tryRecover, delay);
    }
  };

  // First check after 30 seconds
  healthCheckTimer = setTimeout(tryRecover, HEALTH_CHECK_BACKOFF_MS[0]);
}

/**
 * Send a Telegram alert via NanoClaw IPC (best effort).
 */
function sendTelegramAlert(message: string): void {
  try {
    const ipcDir = path.join(
      process.cwd(),
      'data',
      'ipc',
      'atlas_main',
      'messages',
    );
    fs.mkdirSync(ipcDir, { recursive: true });

    // Read main group JID
    const Database = require('better-sqlite3');
    const dbPath = path.join(process.cwd(), 'store', 'messages.db');
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare('SELECT jid FROM registered_groups WHERE is_main = 1 LIMIT 1')
      .get() as { jid: string } | undefined;
    db.close();

    if (!row) return;

    const alertFile = path.join(ipcDir, `auth-alert-${Date.now()}.json`);
    fs.writeFileSync(
      alertFile,
      JSON.stringify({
        type: 'message',
        chatJid: row.jid,
        text: message,
      }),
    );
  } catch {
    // Best effort — don't crash the proxy over an alert
  }
}

/**
 * Forward a request to upstream, collecting the full response.
 */
function forwardRequest(
  makeReq: typeof httpsRequest,
  options: RequestOptions,
  body: Buffer,
): Promise<{
  statusCode: number;
  headers: IncomingMessage['headers'];
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const upstream = makeReq(options, (upRes) => {
      const chunks: Buffer[] = [];
      upRes.on('data', (c) => chunks.push(c));
      upRes.on('end', () => {
        resolve({
          statusCode: upRes.statusCode!,
          headers: upRes.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    upstream.on('error', reject);
    upstream.write(body);
    upstream.end();
  });
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
  const envOauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  // Mutable token state — updated on refresh
  let currentCreds = loadCredentials(envOauthToken);

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  // Proactive refresh: check token expiry every 5 minutes
  if (authMode === 'oauth') {
    setInterval(() => {
      try {
        if (!fs.existsSync(CREDENTIALS_PATH)) return;
        const data = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
        const oauth: OAuthCredentials = data.claudeAiOauth;
        if (!oauth?.expiresAt || !oauth?.refreshToken) return;

        const timeToExpiry = oauth.expiresAt - Date.now();
        // Refresh when expired OR expiring within 10 minutes
        // The <= 0 case is critical: after an outage, the token may have
        // expired while API was unreachable. This ensures recovery.
        if (timeToExpiry < 600_000) {
          const label =
            timeToExpiry <= 0
              ? `expired ${Math.round(-timeToExpiry / 60000)}m ago`
              : `expiring in ${Math.round(timeToExpiry / 60000)}m`;
          logger.info(label, 'Proactively refreshing token');

          refreshAccessToken(oauth.refreshToken).then((result) => {
            if (result.ok) {
              saveCredentials(
                result.accessToken,
                result.refreshToken,
                result.expiresIn,
              );
              currentCreds = {
                accessToken: result.accessToken,
                refreshToken: result.refreshToken,
              };
              // If we were in outage mode, clear it — we just recovered
              if (isInOutage) {
                const downtimeMin = Math.round(
                  (Date.now() - outageStartedAt) / 60_000,
                );
                isInOutage = false;
                outageAlertSent = false;
                if (healthCheckTimer) {
                  clearTimeout(healthCheckTimer);
                  healthCheckTimer = null;
                }
                sendTelegramAlert(
                  '*API Recovered*\n\n' +
                    `Atlas auto-recovered after ~${downtimeMin} minute(s). ` +
                    'Tokens refreshed via proactive check.',
                );
              }
              logger.info('Proactive token refresh succeeded');
            } else if (
              !result.ok &&
              (result.reason === 'network_error' ||
                result.reason === 'server_error')
            ) {
              // API is down — enter outage recovery mode
              startOutageRecovery(currentCreds);
            }
            // token_invalid: proactive refresh can't fix a bad token, skip
          });
        }

        // Also reload from file if it was updated externally (e.g., manual scp)
        if (oauth.accessToken !== currentCreds.accessToken) {
          currentCreds = {
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken,
          };
          logger.info(
            'Credentials reloaded from file (external update detected)',
          );
        }
      } catch {
        /* non-fatal */
      }
    }, 300_000); // Every 5 minutes
  }

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);

        function buildHeaders(): Record<
          string,
          string | number | string[] | undefined
        > {
          const headers: Record<
            string,
            string | number | string[] | undefined
          > = {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };
          delete headers['connection'];
          delete headers['keep-alive'];
          delete headers['transfer-encoding'];

          if (authMode === 'api-key') {
            delete headers['x-api-key'];
            headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
          } else {
            if (headers['authorization']) {
              delete headers['authorization'];
              if (currentCreds.accessToken) {
                headers['authorization'] = `Bearer ${currentCreds.accessToken}`;
              }
            }
          }
          return headers;
        }

        const options: RequestOptions = {
          hostname: upstreamUrl.hostname,
          port: upstreamUrl.port || (isHttps ? 443 : 80),
          path: req.url,
          method: req.method,
        };

        try {
          let upstreamRes = await forwardRequest(
            makeRequest,
            { ...options, headers: buildHeaders() },
            body,
          );

          // Auto-refresh on 401 in OAuth mode
          if (
            upstreamRes.statusCode === 401 &&
            authMode === 'oauth' &&
            currentCreds.refreshToken &&
            Date.now() - lastRefreshAttempt > REFRESH_COOLDOWN_MS
          ) {
            lastRefreshAttempt = Date.now();
            logger.info(
              'Got 401 from upstream — attempting OAuth token refresh',
            );

            const refreshResult = await refreshAccessToken(
              currentCreds.refreshToken,
            );

            if (refreshResult.ok) {
              // Save new tokens and retry the request
              saveCredentials(
                refreshResult.accessToken,
                refreshResult.refreshToken,
                refreshResult.expiresIn,
              );
              currentCreds = {
                accessToken: refreshResult.accessToken,
                refreshToken: refreshResult.refreshToken,
              };
              // Clear outage state if we were in one
              if (isInOutage) {
                isInOutage = false;
                outageAlertSent = false;
                if (healthCheckTimer) {
                  clearTimeout(healthCheckTimer);
                  healthCheckTimer = null;
                }
              }
              logger.info('Token refreshed successfully, retrying request');

              // Retry with new token
              upstreamRes = await forwardRequest(
                makeRequest,
                { ...options, headers: buildHeaders() },
                body,
              );
            } else if (
              !refreshResult.ok &&
              (refreshResult.reason === 'network_error' ||
                refreshResult.reason === 'server_error')
            ) {
              // API is down — this is an outage, not a token problem
              // Start background recovery loop instead of alerting for manual intervention
              logger.warn(
                'Cannot refresh token — API unreachable. Entering outage recovery mode.',
              );
              startOutageRecovery(currentCreds);
            } else {
              // token_invalid — refresh token itself is broken, CEO must re-auth
              logger.error(
                'OAuth refresh token is invalid — manual intervention required',
              );
              sendTelegramAlert(
                '*OAuth Refresh Token Failed*\n\n' +
                  'The refresh token is invalid or expired. This is NOT an outage — the token needs replacing.\n\n' +
                  'From your laptop, run:\n' +
                  '`scp ~/.claude/.credentials.json root@5.78.190.56:/home/atlas/.claude/.credentials.json`\n\n' +
                  'Then: `ssh root@5.78.190.56 systemctl restart nanoclaw`',
              );
            }
          }

          // Detect outage via upstream server errors (even without 401)
          if (
            OUTAGE_STATUS_CODES.has(upstreamRes.statusCode) &&
            !isInOutage &&
            authMode === 'oauth'
          ) {
            logger.warn(
              { statusCode: upstreamRes.statusCode },
              'Upstream returned server error — possible outage',
            );
            startOutageRecovery(currentCreds);
          }

          // Send response to client
          res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
          res.end(upstreamRes.body);
        } catch (err) {
          logger.error(
            { err, url: req.url },
            'Credential proxy upstream error',
          );
          // Connection failure to upstream = likely outage
          if (!isInOutage && authMode === 'oauth') {
            startOutageRecovery(currentCreds);
          }
          if (!res.headersSent) {
            res.writeHead(isInOutage ? 503 : 502);
            res.end(
              isInOutage
                ? 'Service Temporarily Unavailable — outage recovery in progress'
                : 'Bad Gateway',
            );
          }
        }
      });
    });

    server.listen(port, host, () => {
      logger.info(
        { port, host, authMode, hasRefreshToken: !!currentCreds.refreshToken },
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
