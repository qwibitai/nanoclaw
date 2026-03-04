/**
 * OAuth token management for Claude Code subscription tokens.
 *
 * Reads access tokens from Claude Code's credential store
 * (~/.claude/.credentials.json) and refreshes them when near expiry
 * by invoking `claude auth status`, which triggers Claude Code's
 * built-in refresh flow.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

// Refresh when less than 2 hours remain (tokens seem to last ~8 hours)
const REFRESH_BUFFER_MS = 2 * 60 * 60 * 1000;

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  };
}

function readCredentials(): ClaudeCredentials | null {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function triggerRefresh(): boolean {
  try {
    const output = execSync('claude auth status', {
      encoding: 'utf-8',
      timeout: 15_000,
      env: { ...process.env, CLAUDECODE: '' },
    });
    logger.info('Claude auth refresh triggered');
    logger.debug({ output: output.trim() }, 'claude auth status output');
    return true;
  } catch (err) {
    logger.warn({ err }, 'Failed to trigger Claude token refresh via auth status');
    return false;
  }
}

/**
 * Get a valid Claude OAuth access token.
 * Returns null if no credentials are available or refresh fails.
 */
export function getClaudeOAuthToken(): string | null {
  const creds = readCredentials();
  if (!creds?.claudeAiOauth?.accessToken) return null;

  const { accessToken, expiresAt } = creds.claudeAiOauth;
  const msRemaining = expiresAt - Date.now();
  const hoursRemaining = msRemaining / (1000 * 60 * 60);

  if (msRemaining > REFRESH_BUFFER_MS) {
    logger.debug(
      { expiresIn: `${hoursRemaining.toFixed(1)}h` },
      'Claude OAuth token valid',
    );
    return accessToken;
  }

  const expired = msRemaining <= 0;
  logger.info(
    { expiresIn: `${hoursRemaining.toFixed(1)}h`, expired },
    'Claude OAuth token needs refresh',
  );

  if (!triggerRefresh()) {
    if (expired) return null; // don't return a known-expired token
    return accessToken;
  }

  // Re-read after refresh
  const refreshed = readCredentials();
  const newToken = refreshed?.claudeAiOauth?.accessToken;
  const newExpiry = refreshed?.claudeAiOauth?.expiresAt;

  if (newToken && newToken !== accessToken) {
    logger.info(
      { newExpiresAt: newExpiry ? new Date(newExpiry).toISOString() : 'unknown' },
      'Claude OAuth token refreshed successfully',
    );
    return newToken;
  }

  if (newToken && newExpiry && newExpiry > Date.now()) {
    // Same token but still valid
    return newToken;
  }

  logger.warn('Claude OAuth token refresh did not produce a new token');
  return expired ? null : accessToken;
}
