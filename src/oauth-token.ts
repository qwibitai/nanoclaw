/**
 * OAuth token management for Claude Code credentials.
 *
 * Reads OAuth tokens from ~/.claude/.credentials.json and automatically
 * refreshes them when expired.
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
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

/**
 * Get a fresh OAuth access token, refreshing if necessary.
 *
 * Reads from ~/.claude/.credentials.json:
 * - If token is expired (> 5 min buffer), refresh using refresh_token
 * - If refresh fails, falls back to .env value
 * - If API key mode (ANTHROPIC_API_KEY set), returns null
 *
 * @returns Fresh OAuth access token, or null if using API key mode
 */
export async function getFreshOAuthToken(): Promise<string | null> {
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

  // Check if token is expired (with 5 minute buffer)
  const now = Date.now();
  const expiresAt = oauth.expiresAt;
  const buffer = 5 * 60 * 1000; // 5 minutes

  if (expiresAt > now + buffer) {
    // Token is still valid
    return oauth.accessToken;
  }

  // Token is expired, refresh it
  logger.info('OAuth token expired, refreshing...');
  try {
    const newToken = await refreshOAuthToken(oauth.refreshToken);

    // Update credentials file with new token
    credentials.claudeAiOauth = {
      ...oauth,
      accessToken: newToken.accessToken,
      expiresAt: newToken.expiresAt,
    };

    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));
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
  expiresAt: number;
}> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const options = {
      hostname: 'platform.claude.com',
      port: 443,
      path: '/v1/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = httpsRequest(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`OAuth refresh failed: ${res.statusCode} ${data}`));
          return;
        }

        try {
          const response: RefreshResponse = JSON.parse(data);
          resolve({
            accessToken: response.access_token,
            expiresAt: response.expires_at || Date.now() + response.expires_in * 1000,
          });
        } catch (err) {
          reject(new Error(`Failed to parse OAuth response: ${err}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Fallback to .env token if credentials file is unavailable.
 */
function getEnvToken(): string | null {
  // Fall back to .env value (this is the current behavior)
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN;
  if (envToken) {
    logger.debug('Using OAuth token from .env (may be expired)');
    return envToken;
  }
  return null;
}
