import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { log } from './log.js';

const REFRESH_WINDOW_MS = 10 * 60 * 1000;

interface GoogleCredentials {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
}

async function refreshOne(credPath: string, clientId: string, clientSecret: string): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(credPath, 'utf8');
  } catch {
    return;
  }
  let creds: GoogleCredentials;
  try {
    creds = JSON.parse(raw);
  } catch (err) {
    log.warn('google-oauth-refresh: invalid credentials JSON', {
      credPath,
      err: String(err),
    });
    return;
  }

  const now = Date.now();
  if (creds.expiry_date && creds.expiry_date - now > REFRESH_WINDOW_MS) {
    return;
  }
  if (!creds.refresh_token) {
    return;
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: creds.refresh_token,
    grant_type: 'refresh_token',
  });

  let res: Response;
  try {
    res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch (err) {
    log.warn('google-oauth-refresh: network error', {
      credPath,
      err: String(err),
    });
    return;
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    log.warn('google-oauth-refresh: refresh failed', {
      credPath,
      status: res.status,
      errText,
    });
    return;
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
    token_type?: string;
  };
  creds.access_token = data.access_token;
  creds.expiry_date = Date.now() + data.expires_in * 1000;
  if (data.token_type) creds.token_type = data.token_type;
  await fs.writeFile(credPath, JSON.stringify(creds, null, 2));
  log.info('google-oauth-refresh: refreshed', { credPath });
}

export async function refreshGoogleTokens(): Promise<void> {
  const home = os.homedir();
  const gmailKeysPath = path.join(home, '.gmail-mcp', 'gcp-oauth.keys.json');
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  try {
    const keys = JSON.parse(await fs.readFile(gmailKeysPath, 'utf8'));
    const inner = keys.installed || keys.web;
    clientId = inner?.client_id;
    clientSecret = inner?.client_secret;
  } catch {
    return;
  }
  if (!clientId || !clientSecret) return;

  await Promise.all([
    refreshOne(path.join(home, '.gmail-mcp', 'credentials.json'), clientId, clientSecret),
    refreshOne(path.join(home, '.calendar-mcp', 'credentials.json'), clientId, clientSecret),
  ]);
}
