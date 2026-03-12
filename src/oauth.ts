/**
 * OAuth token lifecycle management for Claude Max.
 *
 * Reads credentials from oauth-credentials.json, refreshes the access
 * token automatically when near expiry, and persists updated credentials
 * atomically.  Falls back to .env for migration.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

// --- Constants -----------------------------------------------------------

export const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Refresh when the token expires within this window. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/** Fallback lifetime when the server omits `expires_in`. */
const DEFAULT_LIFETIME_MS = 15 * 60 * 60 * 1000; // 15 hours

// --- Types ---------------------------------------------------------------

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch milliseconds
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number; // seconds
  token_type: string;
  scope?: string;
}

// --- Credentials file I/O ------------------------------------------------

function credentialsPath(): string {
  return path.join(process.cwd(), 'oauth-credentials.json');
}

export function readCredentials(): OAuthCredentials | null {
  try {
    const raw = fs.readFileSync(credentialsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.accessToken || !parsed.refreshToken || !parsed.expiresAt) {
      logger.warn('oauth-credentials.json missing required fields');
      return null;
    }
    return parsed as OAuthCredentials;
  } catch {
    return null;
  }
}

export function writeCredentials(creds: OAuthCredentials): void {
  const filePath = credentialsPath();
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2) + '\n', {
    mode: 0o600,
  });
  fs.renameSync(tmp, filePath);
  logger.info(
    { expiresAt: new Date(creds.expiresAt).toISOString() },
    'OAuth credentials persisted',
  );
}

// --- Token refresh -------------------------------------------------------

export async function refreshOAuthToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
}> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  logger.info('Refreshing OAuth access token');

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    logger.error(
      { status: response.status, body: text },
      'OAuth token refresh failed',
    );
    throw new Error(`OAuth refresh failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as TokenResponse;

  logger.info(
    {
      hasNewRefreshToken: !!data.refresh_token,
      expiresIn: data.expires_in,
    },
    'OAuth token refreshed successfully',
  );

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

// --- Main entry point ----------------------------------------------------

/** Module-level promise to deduplicate concurrent refresh calls. */
let refreshPromise: Promise<OAuthCredentials> | null = null;

/**
 * Return a valid OAuth access token, refreshing automatically if near
 * expiry.  Falls back to CLAUDE_CODE_OAUTH_TOKEN from .env when no
 * credentials file exists (migration path).
 */
export async function getValidToken(): Promise<string> {
  const creds = readCredentials();

  if (!creds) {
    // Migration fallback — read static token from .env
    const env = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN']);
    const token = env.CLAUDE_CODE_OAUTH_TOKEN;
    if (token) {
      logger.debug('Using OAuth token from .env (no credentials file)');
    } else {
      logger.warn('No OAuth token found in credentials file or .env');
    }
    return token || '';
  }

  // Fast path — token still valid
  if (creds.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
    const remaining = Math.round(
      (creds.expiresAt - Date.now()) / 1000 / 60,
    );
    logger.debug({ remainingMinutes: remaining }, 'OAuth token still valid');
    return creds.accessToken;
  }

  // Token near expiry — refresh (deduplicate concurrent calls)
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const result = await refreshOAuthToken(creds.refreshToken);
        const newCreds: OAuthCredentials = {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken || creds.refreshToken,
          expiresAt: result.expiresIn
            ? Date.now() + result.expiresIn * 1000
            : Date.now() + DEFAULT_LIFETIME_MS,
        };
        writeCredentials(newCreds);
        return newCreds;
      } finally {
        refreshPromise = null;
      }
    })();
  }

  try {
    const newCreds = await refreshPromise;
    return newCreds.accessToken;
  } catch (err) {
    logger.error(
      { error: err },
      'CRITICAL: OAuth refresh failed — using stale token as fallback',
    );
    return creds.accessToken;
  }
}
