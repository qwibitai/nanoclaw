/**
 * Auth mode switching for NanoClaw.
 * Toggles between API key and OAuth by editing .env comments.
 *
 * API key mode: ANTHROPIC_API_KEY is uncommented in .env
 * OAuth mode: ANTHROPIC_API_KEY is commented out; the credential proxy
 *   reads the OAuth token from ~/.claude/.credentials.json (managed by
 *   Claude CLI, auto-refreshed).
 */
import fs from 'fs';
import path from 'path';

import { log } from './log.js';

export type AuthMode = 'api-key' | 'oauth';

const ENV_PATH = path.join(process.cwd(), '.env');

const CLAUDE_CREDENTIALS_PATH = path.join(process.env.HOME || '/home/node', '.claude', '.credentials.json');

/**
 * Detect current auth mode from .env file.
 * If ANTHROPIC_API_KEY is uncommented, we're in api-key mode.
 * Otherwise, oauth mode (proxy reads from Claude CLI credentials).
 */
export function getCurrentAuthMode(): AuthMode {
  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('ANTHROPIC_API_KEY=')) return 'api-key';
  }
  return 'oauth';
}

/**
 * Check if Claude CLI OAuth credentials exist and are valid.
 */
export function hasValidOAuthCredentials(): boolean {
  try {
    if (!fs.existsSync(CLAUDE_CREDENTIALS_PATH)) return false;
    const creds = JSON.parse(fs.readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf-8'));
    const oauth = creds.claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.refreshToken) return false;
    // Check if token hasn't expired (with 1 hour buffer)
    if (oauth.expiresAt && oauth.expiresAt < Date.now() + 3600000) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Switch auth mode by commenting/uncommenting the API key line in .env.
 */
export function switchAuthMode(target: AuthMode): AuthMode {
  const content = fs.readFileSync(ENV_PATH, 'utf-8');
  const lines = content.split('\n');
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (target === 'oauth') {
      // Comment out API key — proxy will fall back to Claude CLI credentials
      if (trimmed.startsWith('ANTHROPIC_API_KEY=')) {
        result.push('#' + line);
      } else {
        result.push(line);
      }
    } else {
      // Uncomment API key
      if (trimmed.startsWith('#ANTHROPIC_API_KEY=') || trimmed.startsWith('# ANTHROPIC_API_KEY=')) {
        result.push(line.replace(/^(\s*)#\s?/, '$1'));
      } else {
        result.push(line);
      }
    }
  }

  fs.writeFileSync(ENV_PATH, result.join('\n'));
  log.info('Auth mode switched', { target });
  return target;
}
