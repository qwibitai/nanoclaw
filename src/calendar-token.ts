/**
 * Calendar OAuth token keeper.
 * Refreshes the Google Calendar OAuth token on startup and periodically,
 * persisting the refreshed token to ~/.calendar-mcp/credentials.json.
 * This ensures the MCP server inside containers always has a valid token.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { google } from 'googleapis';

import { logger } from './logger.js';

const CRED_DIR = path.join(os.homedir(), '.calendar-mcp');
const KEYS_PATH = path.join(CRED_DIR, 'gcp-oauth.keys.json');
const TOKENS_PATH = path.join(CRED_DIR, 'credentials.json');
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function refreshCalendarToken(): Promise<void> {
  if (!fs.existsSync(KEYS_PATH) || !fs.existsSync(TOKENS_PATH)) return;

  try {
    const keys = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
    const tokens = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'));
    const { client_id, client_secret, redirect_uris } = keys.installed || keys;

    const client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris?.[0],
    );
    client.setCredentials(tokens);

    const { credentials } = await client.refreshAccessToken();
    const updated = { ...tokens, ...credentials };
    fs.writeFileSync(TOKENS_PATH, JSON.stringify(updated, null, 2));
    logger.info('Calendar OAuth token refreshed');
  } catch (err) {
    logger.warn({ err }, 'Failed to refresh Calendar OAuth token');
  }
}

/**
 * Start the calendar token keeper.
 * Refreshes immediately, then every 30 minutes.
 */
export function startCalendarTokenKeeper(): void {
  if (!fs.existsSync(KEYS_PATH)) return;

  refreshCalendarToken();
  setInterval(refreshCalendarToken, REFRESH_INTERVAL_MS);
}
