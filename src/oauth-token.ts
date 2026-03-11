/**
 * OAuth token management for Claude Code credentials.
 *
 * Reads OAuth tokens from ~/.claude/.credentials.json and automatically
 * refreshes them when expired.
 *
 * Thread-safety: All calls are serialized through a promise chain so only
 * one refresh can run at a time. File writes are atomic (write temp + rename).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { request as httpsRequest } from 'https';

import { logger } from './logger.js';

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType: string | null;
  };
}

const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const BUFFER = 5 * 60 * 1000; // 5 minutes

// All calls chain onto this promise — serializes concurrent refresh operations.
let refreshLock: Promise<string | null> = Promise.resolve(null);

/**
 * Get a fresh OAuth access token, refreshing if necessary.
 *
 * Reads from ~/.claude/.credentials.json:
 * - If token is valid (> 5 min remaining), return it
 * - If token is expired, refresh using refresh_token
 * - If refresh fails or file is missing, falls back to .env value
 * - If API key mode (ANTHROPIC_API_KEY set), returns null
 *
 * Thread-safe: All concurrent calls are serialized so only one refresh
 * can run at a time.
 *
 * @returns Fresh OAuth access token, or null if using API key mode
 */
export function getFreshOAuthToken(): Promise<string | null> {
  // Always chain — guarantees only one _doGetToken runs at a time
  refreshLock = refreshLock.then(_doGetToken);
  return refreshLock;
}

async function _doGetToken(): Promise<string | null> {
  // If using API key mode, skip OAuth entirely
  if (process.env.ANTHROPIC_API_KEY) {
    return null;
  }

  // Try to read from credentials file
  let credentials: ClaudeCredentials;
  try {
    const content = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
    credentials = JSON.parse(content);
  } catch (err) {
    logger.debug({ err }, 'Credentials file not readable, falling back to .env');
    return getEnvToken();
  }

  const oauth = credentials.claudeAiOauth;
  if (!oauth) {
    logger.debug('No OAuth credentials found in credentials file');
    return getEnvToken();
  }

  // Token is still valid
  if (oauth.expiresAt > Date.now() + BUFFER) {
    return oauth.accessToken;
  }

  // Token is expired — refresh it
  logger.info('OAuth token expired, refreshing...');
  try {
    const newToken = await refreshOAuthToken(oauth.refreshToken);

    // Re-read credentials file before writing to handle external updates
    let updatedCredentials: ClaudeCredentials;
    try {
      const content = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
      updatedCredentials = JSON.parse(content);
    } catch {
      updatedCredentials = credentials;
    }

    updatedCredentials.claudeAiOauth = {
      ...updatedCredentials.claudeAiOauth!,
      accessToken: newToken.accessToken,
      expiresAt: newToken.expiresAt,
      // Persist rotated refresh token if the server returned one
      ...(newToken.refreshToken && { refreshToken: newToken.refreshToken }),
    };

    writeCredentialsAtomic(updatedCredentials);
    logger.info('OAuth token refreshed successfully');
    return newToken.accessToken;
  } catch (err) {
    logger.error({ err }, 'Failed to refresh OAuth token, falling back to .env');
    return getEnvToken();
  }
}

interface RefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  expires_at?: number;
}

/**
 * Refresh OAuth token using the refresh token.
 */
async function refreshOAuthToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const req = httpsRequest(
      {
        hostname: 'platform.claude.com',
        port: 443,
        path: '/v1/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`OAuth refresh failed: ${res.statusCode} ${data}`));
            return;
          }
          try {
            const response: RefreshResponse = JSON.parse(data);
            resolve({
              accessToken: response.access_token,
              refreshToken: response.refresh_token,
              expiresAt: response.expires_at ?? Date.now() + response.expires_in * 1000,
            });
          } catch (err) {
            reject(new Error(`Failed to parse OAuth response: ${err}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Write credentials file atomically to prevent corruption.
 * Writes to a temp file then renames — atomic on POSIX systems.
 */
function writeCredentialsAtomic(credentials: ClaudeCredentials): void {
  const tempFile = `${CREDENTIALS_FILE}.tmp.${Date.now()}`;
  const content = JSON.stringify(credentials, null, 2);
  try {
    fs.writeFileSync(tempFile, content, 'utf-8');
    fs.renameSync(tempFile, CREDENTIALS_FILE);
  } catch (err) {
    try { fs.unlinkSync(tempFile); } catch {}
    throw err;
  }
}

/**
 * Fallback to .env token if credentials file is unavailable.
 */
function getEnvToken(): string | null {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN;
  if (envToken) {
    logger.debug('Using OAuth token from .env (may be expired)');
    return envToken;
  }
  return null;
}
