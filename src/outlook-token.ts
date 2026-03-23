/**
 * Outlook (Microsoft Graph) token management.
 * Refreshes the access token before it expires and persists
 * the new token back to .env so subsequent spawns use it.
 */

import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';

const ENV_FILE = path.join(process.cwd(), '.env');
const OUTLOOK_KEYS = [
  'OUTLOOK_CLIENT_ID',
  'OUTLOOK_TENANT_ID',
  'OUTLOOK_CLIENT_SECRET',
  'OUTLOOK_ACCESS_TOKEN',
  'OUTLOOK_REFRESH_TOKEN',
  'OUTLOOK_TOKEN_EXPIRES_AT',
] as const;

const REFRESH_BUFFER_SECS = 300; // refresh 5 min before expiry
const GRAPH_SCOPES = 'offline_access Mail.Read Mail.Send Calendars.ReadWrite';

function writeEnvKey(key: string, value: string): void {
  let content = '';
  try {
    content = fs.readFileSync(ENV_FILE, 'utf-8');
  } catch {
    /* new file */
  }

  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`) || l.startsWith(`${key} =`));
  const newLine = `${key}=${value}`;
  if (idx >= 0) {
    lines[idx] = newLine;
  } else {
    if (lines[lines.length - 1] === '') {
      lines.splice(lines.length - 1, 0, newLine);
    } else {
      lines.push(newLine);
    }
  }
  fs.writeFileSync(ENV_FILE, lines.join('\n'));
}

/**
 * Returns a valid Outlook access token, refreshing it if needed.
 * Returns null if Outlook is not configured.
 */
export async function getOutlookAccessToken(): Promise<string | null> {
  const env = readEnvFile([...OUTLOOK_KEYS]);

  if (!env.OUTLOOK_CLIENT_ID || !env.OUTLOOK_TENANT_ID || !env.OUTLOOK_CLIENT_SECRET || !env.OUTLOOK_REFRESH_TOKEN) {
    return null; // Outlook not configured
  }

  const expiresAt = parseInt(env.OUTLOOK_TOKEN_EXPIRES_AT ?? '0', 10);
  const now = Math.floor(Date.now() / 1000);

  if (env.OUTLOOK_ACCESS_TOKEN && expiresAt > now + REFRESH_BUFFER_SECS) {
    return env.OUTLOOK_ACCESS_TOKEN; // Token still valid
  }

  // Refresh the token
  logger.debug('Refreshing Outlook access token');
  try {
    const res = await fetch(
      `https://login.microsoftonline.com/${env.OUTLOOK_TENANT_ID}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.OUTLOOK_CLIENT_ID,
          client_secret: env.OUTLOOK_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: env.OUTLOOK_REFRESH_TOKEN,
          scope: GRAPH_SCOPES,
        }).toString(),
      },
    );

    if (!res.ok) {
      const text = await res.text();
      logger.warn({ status: res.status, body: text }, 'Outlook token refresh failed');
      // Return existing token as fallback (may be expired, container will see 401)
      return env.OUTLOOK_ACCESS_TOKEN ?? null;
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    writeEnvKey('OUTLOOK_ACCESS_TOKEN', data.access_token);
    writeEnvKey('OUTLOOK_TOKEN_EXPIRES_AT', String(now + (data.expires_in ?? 3600)));
    if (data.refresh_token) {
      writeEnvKey('OUTLOOK_REFRESH_TOKEN', data.refresh_token);
    }

    logger.info('Outlook access token refreshed successfully');
    return data.access_token;
  } catch (err) {
    logger.warn({ err }, 'Outlook token refresh error');
    return env.OUTLOOK_ACCESS_TOKEN ?? null;
  }
}
