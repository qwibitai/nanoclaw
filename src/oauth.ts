import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

export const AUTH_ERROR_PATTERN = /401|unauthorized|authentication|token.*expired|invalid.*token|expired.*token/i;

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Ensure the OAuth token is fresh before spawning a container.
 * If the token is expired or within 5 minutes of expiry, refresh it.
 * Returns true if a valid token is available, false if refresh failed.
 */
export async function ensureTokenFresh(): Promise<boolean> {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const creds = JSON.parse(raw);
    const expiresAt: number | undefined = creds?.claudeAiOauth?.expiresAt;

    if (!expiresAt) {
      logger.debug('No expiresAt in credentials, skipping pre-flight check');
      return true;
    }

    const nowMs = Date.now();
    const remainingMs = expiresAt - nowMs;

    if (remainingMs > REFRESH_BUFFER_MS) {
      return true; // Token still fresh
    }

    logger.warn(
      { remainingMs, expiresAt: new Date(expiresAt).toISOString() },
      'Token expired or expiring soon, refreshing before container spawn',
    );
    return await refreshOAuthToken();
  } catch (err) {
    // If we can't read credentials, don't block — let the container try anyway
    logger.debug({ err }, 'Could not check token freshness');
    return true;
  }
}

export function refreshOAuthToken(): Promise<boolean> {
  const script = path.join(process.cwd(), 'scripts', 'oauth', 'refresh.sh');
  return new Promise((resolve) => {
    execFile(script, (err) => {
      if (err) {
        logger.error({ err }, 'OAuth refresh script failed');
        resolve(false);
      } else {
        logger.info('OAuth token refreshed after auth error');
        resolve(true);
      }
    });
  });
}
