/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to upstream APIs.
 * The proxy injects real credentials so containers never see them.
 *
 * Routes by URL path prefix:
 *   /openai/*      → OpenAI API (strip prefix, inject Authorization)
 *   /googleapis/*  → Google APIs (strip prefix, inject OAuth Bearer
 *                    refreshed from ~/.config/gws/credentials.json)
 *   everything else → Anthropic API (default)
 *
 * Anthropic auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 *
 * Anthropic OAuth source (in order of priority):
 *   1. CLAUDE_CODE_OAUTH_TOKEN in .env (static, user-managed)
 *   2. ~/.claude/.credentials.json (file written by Claude Code CLI)
 *   3. macOS keychain ("Claude Code-credentials" generic password) — only
 *      consulted on darwin when the file is absent
 *
 * Anthropic OAuth tokens expire (~1 hour). The proxy proactively refreshes
 * them via platform.claude.com/v1/oauth/token before expiry, persists the
 * refreshed token back to the credentials file (so process restarts pick
 * up the latest), and treats unknown expiry (keychain path) as "needs
 * refresh now" so the proxy learns the real expiry time. This makes the
 * proxy self-sufficient — it does NOT rely on Claude CLI running on the
 * same host to keep the file fresh, which is the common case on a Linux
 * server running NanoClaw as a long-lived service.
 *
 * Google OAuth source: ~/.config/gws/credentials.json (authorized_user
 * format with refresh_token). Proxy refreshes the access token on
 * demand and caches it in memory until ~5 min before expiry.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { log } from './log.js';

/**
 * OAuth client id used by Claude Code CLI for the refresh-token grant.
 * Matches the value Claude Code itself uses; not a secret.
 */
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  };
}

const CLAUDE_CREDENTIALS_PATH = path.join(process.env.HOME || '/home/node', '.claude', '.credentials.json');
const GWS_CREDENTIALS_PATH = path.join(process.env.HOME || '/home/node', '.config', 'gws', 'credentials.json');

// Buffer: refresh 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

let cachedOAuthToken: string | null = null;
let cachedExpiresAt = 0;

/** Google OAuth — cached access token + expiry. Refreshed on demand. */
let cachedGoogleAccessToken: string | null = null;
let cachedGoogleExpiresAt = 0;

interface GwsCredentials {
  type: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  access_token?: string;
  expiry_date?: number;
}

function readGwsCredentials(): GwsCredentials | null {
  try {
    if (!fs.existsSync(GWS_CREDENTIALS_PATH)) return null;
    const raw = fs.readFileSync(GWS_CREDENTIALS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<GwsCredentials>;
    if (!parsed.client_id || !parsed.client_secret || !parsed.refresh_token) return null;
    return parsed as GwsCredentials;
  } catch (err) {
    log.warn('Failed to read GWS credentials', { err: String(err) });
    return null;
  }
}

/**
 * Get a fresh Google OAuth access token. Returns null if no credentials
 * are configured. Caches the token until 5 minutes before its expiry.
 *
 * Refresh flow: POST to oauth2.googleapis.com/token with grant_type=
 * refresh_token. Standard Google OAuth — no library needed.
 */
async function getGoogleAccessToken(): Promise<string | null> {
  if (cachedGoogleAccessToken && Date.now() < cachedGoogleExpiresAt - REFRESH_BUFFER_MS) {
    return cachedGoogleAccessToken;
  }

  const creds = readGwsCredentials();
  if (!creds) return null;

  // First-time path: if credentials.json has a fresh access_token + expiry, use it.
  if (creds.access_token && creds.expiry_date && creds.expiry_date > Date.now() + REFRESH_BUFFER_MS) {
    cachedGoogleAccessToken = creds.access_token;
    cachedGoogleExpiresAt = creds.expiry_date;
    return cachedGoogleAccessToken;
  }

  // Refresh: exchange refresh_token for a new access_token.
  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
  }).toString();

  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        hostname: 'oauth2.googleapis.com',
        port: 443,
        path: '/token',
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            log.error('GWS OAuth refresh failed', {
              status: res.statusCode,
              body: Buffer.concat(chunks).toString('utf-8').slice(0, 500),
            });
            resolve(null);
            return;
          }
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
              access_token: string;
              expires_in: number;
            };
            cachedGoogleAccessToken = json.access_token;
            cachedGoogleExpiresAt = Date.now() + json.expires_in * 1000;
            log.debug('GWS OAuth refresh OK', { expiresInMin: Math.round(json.expires_in / 60) });
            resolve(cachedGoogleAccessToken);
          } catch (err) {
            log.error('GWS OAuth refresh parse failed', { err: String(err) });
            resolve(null);
          }
        });
      },
    );
    req.on('error', (err) => {
      log.error('GWS OAuth refresh request error', { err: String(err) });
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Read the full OAuth credential object (accessToken + refreshToken +
 * expiresAt) from `~/.claude/.credentials.json`, falling back to the
 * macOS keychain when the file is absent.
 *
 * Keychain path is gated by `process.platform === 'darwin'`; on Linux
 * the fallback is a no-op. The keychain entry stores only the access
 * token shape — `expiresAt` is undefined there, which the caller treats
 * as "refresh now" so we learn the real expiry on the first API call.
 */
function readFullOAuthCredentials(): ClaudeCredentials['claudeAiOauth'] | null {
  // Primary: credentials file written by Claude Code CLI
  try {
    if (fs.existsSync(CLAUDE_CREDENTIALS_PATH)) {
      const data = JSON.parse(fs.readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8')) as ClaudeCredentials;
      if (data.claudeAiOauth?.accessToken) return data.claudeAiOauth;
    }
  } catch (err) {
    log.warn('Failed to read Claude credentials file', { err: String(err) });
  }

  // Fallback: macOS keychain. No-op on Linux.
  if (process.platform !== 'darwin') return null;
  try {
    const raw = execSync('security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const data = JSON.parse(raw) as ClaudeCredentials;
    if (data.claudeAiOauth?.accessToken) return data.claudeAiOauth;
  } catch {
    // keychain not available or no entry — silent fallthrough
  }
  return null;
}

/**
 * Persist refreshed OAuth credentials back to the credentials file so the
 * next process restart picks up the latest token. Best-effort: failure is
 * logged but does not propagate; the in-memory cache is the source of
 * truth for the running process.
 */
function saveOAuthCredentials(updated: { accessToken: string; refreshToken: string; expiresAt: number }): void {
  try {
    let root: Record<string, unknown> = {};
    if (fs.existsSync(CLAUDE_CREDENTIALS_PATH)) {
      try {
        root = JSON.parse(fs.readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8')) as Record<string, unknown>;
      } catch {
        // file unreadable — start fresh; we own the claudeAiOauth field anyway
      }
    } else {
      // Ensure parent dir exists (rare — /home/<user>/.claude is created
      // by the Claude CLI on first run; if it isn't here, create it 0700).
      fs.mkdirSync(path.dirname(CLAUDE_CREDENTIALS_PATH), { recursive: true, mode: 0o700 });
    }
    root.claudeAiOauth = {
      ...((root.claudeAiOauth as object | undefined) ?? {}),
      ...updated,
    };
    const tmp = `${CLAUDE_CREDENTIALS_PATH}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(root, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, CLAUDE_CREDENTIALS_PATH);
  } catch (err) {
    log.warn('Failed to persist refreshed OAuth credentials', { err: String(err) });
  }
}

/**
 * Exchange a refresh token for a new access token via Anthropic's OAuth
 * endpoint. Returns the updated credentials, or null on failure.
 */
function refreshAnthropicOAuthToken(
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number } | null> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  }).toString();

  return new Promise((resolve) => {
    const req = httpsRequest(
      {
        hostname: 'platform.claude.com',
        port: 443,
        path: '/v1/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          if (res.statusCode !== 200) {
            log.error('Anthropic OAuth refresh failed', {
              status: res.statusCode,
              body: text.slice(0, 500),
            });
            resolve(null);
            return;
          }
          try {
            const json = JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number };
            if (!json.access_token) {
              log.error('Anthropic OAuth refresh: no access_token in response');
              resolve(null);
              return;
            }
            const expiresAt = json.expires_in ? Date.now() + json.expires_in * 1000 : Date.now() + 60 * 60 * 1000;
            resolve({
              accessToken: json.access_token,
              refreshToken: json.refresh_token ?? refreshToken,
              expiresAt,
            });
          } catch (err) {
            log.error('Anthropic OAuth refresh parse failed', { err: String(err) });
            resolve(null);
          }
        });
      },
    );
    req.on('error', (err) => {
      log.error('Anthropic OAuth refresh request error', { err: String(err) });
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

/**
 * Single-flight refresh guard — multiple concurrent requests that hit a
 * near-expiry condition share one in-flight refresh instead of stampeding
 * the OAuth server.
 */
let refreshInFlight: Promise<void> | null = null;

/**
 * Read the OAuth access token, proactively refreshing when expired or
 * near-expiry. Returns null if no credentials are configured at all.
 *
 * Order of preference:
 *   1. Static `envToken` (CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN
 *      from .env) — never refreshed; user manages it.
 *   2. Cached token if not near-expiry.
 *   3. Refreshed token (file → keychain → POST /v1/oauth/token), saved
 *      back to file and cache.
 */
async function getOAuthToken(envToken?: string): Promise<string | null> {
  // Static token from .env always wins.
  if (envToken) return envToken;

  // Cached token still has comfortable headroom — return immediately.
  if (cachedOAuthToken && Date.now() < cachedExpiresAt - REFRESH_BUFFER_MS) {
    return cachedOAuthToken;
  }

  const oauth = readFullOAuthCredentials();
  if (!oauth) return null;

  // Token has time left — adopt it as the cache and return.
  // expiresAt is undefined on the keychain path; treat that as "refresh now"
  // so we learn the real expiry from Anthropic's response.
  if (oauth.expiresAt !== undefined && Date.now() < oauth.expiresAt - REFRESH_BUFFER_MS) {
    cachedOAuthToken = oauth.accessToken;
    cachedExpiresAt = oauth.expiresAt;
    return cachedOAuthToken;
  }

  // Need to refresh. Coalesce concurrent callers behind one in-flight refresh.
  if (!refreshInFlight && oauth.refreshToken) {
    const refreshToken = oauth.refreshToken;
    refreshInFlight = (async () => {
      try {
        const updated = await refreshAnthropicOAuthToken(refreshToken);
        if (updated) {
          cachedOAuthToken = updated.accessToken;
          cachedExpiresAt = updated.expiresAt;
          saveOAuthCredentials(updated);
          log.info('Anthropic OAuth token refreshed', {
            expiresInMin: Math.round((updated.expiresAt - Date.now()) / 60_000),
          });
        }
      } finally {
        refreshInFlight = null;
      }
    })();
  }

  if (refreshInFlight) {
    await refreshInFlight;
  }

  // After refresh attempt: prefer the freshly-cached token; fall back to the
  // pre-refresh access token from the file/keychain (better than null even
  // if it's near-expiry — Anthropic may still accept it for a few minutes).
  return cachedOAuthToken ?? oauth.accessToken ?? null;
}

export function startCredentialProxy(port: number, host = '127.0.0.1'): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const envOAuthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const anthropicUpstream = new URL(secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
  const openaiUpstream = new URL(secrets.OPENAI_BASE_URL || 'https://api.openai.com');
  const googleUpstream = new URL('https://www.googleapis.com');

  const requestFor = (isHttps: boolean) => (isHttps ? httpsRequest : httpRequest);

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const body = Buffer.concat(chunks);

        // Route by path prefix:
        //   /openai/*       → OpenAI (strip prefix, inject Authorization)
        //   /googleapis/*   → Google APIs (strip prefix, inject OAuth Bearer)
        //   everything else → Anthropic (existing behaviour)
        const rawUrl = req.url || '/';
        const isOpenAI = rawUrl.startsWith('/openai/') || rawUrl === '/openai';
        const isGoogle = rawUrl.startsWith('/googleapis/') || rawUrl === '/googleapis';

        const upstreamUrl = isGoogle ? googleUpstream : isOpenAI ? openaiUpstream : anthropicUpstream;
        const upstreamPath = isGoogle
          ? rawUrl.replace(/^\/googleapis/, '') || '/'
          : isOpenAI
            ? rawUrl.replace(/^\/openai/, '') || '/'
            : rawUrl;
        const isHttps = upstreamUrl.protocol === 'https:';
        const makeRequest = requestFor(isHttps);

        const headers: Record<string, string | number | string[] | undefined> = {
          ...(req.headers as Record<string, string>),
          host: upstreamUrl.host,
          'content-length': body.length,
        };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (isGoogle) {
          // Google APIs: refresh access token if needed, inject as Bearer.
          // Returns 502 with an actionable message if no creds configured.
          const token = await getGoogleAccessToken();
          if (!token) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  message:
                    'Google OAuth not configured. Authorize via /add-gmail-tool / /add-gcal-tool (or any flow that writes ~/.config/gws/credentials.json).',
                  type: 'proxy_misconfiguration',
                },
              }),
            );
            return;
          }
          delete headers['authorization'];
          delete headers['x-goog-api-key'];
          headers['authorization'] = `Bearer ${token}`;
        } else if (isOpenAI) {
          // OpenAI mode: replace any placeholder Authorization with the
          // real key. If OPENAI_API_KEY isn't set on the host, 502 with
          // a clear message so the container-side error is actionable.
          if (!secrets.OPENAI_API_KEY) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  message: 'OPENAI_API_KEY is not set on the host. Add it to .env and restart nanoclaw.',
                  type: 'proxy_misconfiguration',
                },
              }),
            );
            return;
          }
          delete headers['authorization'];
          delete headers['x-api-key'];
          headers['authorization'] = `Bearer ${secrets.OPENAI_API_KEY}`;
        } else if (authMode === 'api-key') {
          // Anthropic API key mode: inject x-api-key on every request
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // Anthropic OAuth mode: replace placeholder Bearer token with
          // the real one only when the container actually sends an
          // Authorization header (exchange request + auth probes).
          // Post-exchange requests use x-api-key only, so they pass
          // through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            const token = await getOAuthToken(envOAuthToken);
            if (token) {
              headers['authorization'] = `Bearer ${token}`;
            }
          }
        }

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
          log.error('Credential proxy upstream error', {
            err,
            url: req.url,
            route: isGoogle ? 'google' : isOpenAI ? 'openai' : 'anthropic',
          });
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
      log.info('Credential proxy started', { port, host, authMode });
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
