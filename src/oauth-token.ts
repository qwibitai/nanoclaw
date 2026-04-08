/**
 * OAuth token management for Claude Code credentials.
 *
 * Reads OAuth tokens from ~/.claude/.credentials.json, refreshes them
 * when expired, and keeps the OneCLI secret in sync so newly launched
 * containers always get a valid token.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { request as httpsRequest } from 'https';
import { promisify } from 'util';

import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const BUFFER_MS = 5 * 60 * 1000; // refresh 5 minutes before expiry

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes: string[];
    subscriptionType: string | null;
  };
}

interface RefreshResponse {
  access_token: string;
  expires_in: number;
  expires_at?: number;
}

async function callRefreshEndpoint(
  refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
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
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(`OAuth refresh failed: ${res.statusCode} ${data}`),
            );
            return;
          }
          try {
            const response: RefreshResponse = JSON.parse(data);
            resolve({
              accessToken: response.access_token,
              expiresAt:
                response.expires_at ??
                Date.now() + response.expires_in * 1000,
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

async function syncOneCLISecret(
  secretId: string,
  token: string,
  onecliPath: string,
): Promise<void> {
  try {
    await execFileAsync(onecliPath, [
      'secrets',
      'update',
      '--id',
      secretId,
      '--value',
      token,
    ]);
    logger.info({ secretId }, 'OneCLI secret updated with fresh OAuth token');
  } catch (err) {
    logger.warn(
      { err, secretId },
      'Failed to update OneCLI secret — container may use stale token',
    );
  }
}

/**
 * Ensures the OAuth token in ~/.claude/.credentials.json is fresh.
 * If the token is within 5 minutes of expiry (or already expired),
 * refreshes it via the OAuth endpoint and writes the new token back.
 * Also syncs the OneCLI secret if secretId + onecliPath are provided.
 *
 * No-op when ANTHROPIC_API_KEY is set (API key mode needs no OAuth refresh).
 */
export async function ensureFreshOAuthToken(opts: {
  secretId?: string;
  onecliPath?: string;
}): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) return;

  let credentials: ClaudeCredentials;
  try {
    credentials = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
  } catch {
    logger.debug('Credentials file not readable, skipping OAuth refresh');
    return;
  }

  const oauth = credentials.claudeAiOauth;
  if (!oauth?.refreshToken) {
    logger.debug('No OAuth credentials in credentials file');
    return;
  }

  if (oauth.expiresAt > Date.now() + BUFFER_MS) {
    logger.debug('OAuth token still valid, syncing to OneCLI');
    if (opts.secretId && opts.onecliPath) {
      await syncOneCLISecret(opts.secretId, oauth.accessToken, opts.onecliPath);
    }
    return;
  }

  logger.info('OAuth token expired or near expiry, refreshing...');
  try {
    const { accessToken, expiresAt } = await callRefreshEndpoint(
      oauth.refreshToken,
    );

    credentials.claudeAiOauth = { ...oauth, accessToken, expiresAt };
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2));
    logger.info('OAuth token refreshed and credentials.json updated');

    if (opts.secretId && opts.onecliPath) {
      await syncOneCLISecret(opts.secretId, accessToken, opts.onecliPath);
    }
  } catch (err) {
    logger.error({ err }, 'OAuth token refresh failed — container may get 401');
  }
}
