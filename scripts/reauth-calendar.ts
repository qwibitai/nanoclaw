#!/usr/bin/env npx tsx
/**
 * Re-authorize Google OAuth with calendar.events scope for RSVP support.
 * Opens a browser for consent, exchanges the code, and updates credentials.json.
 *
 * Usage: npx tsx scripts/reauth-calendar.ts [cred-dir]
 *   cred-dir defaults to ~/.gmail-mcp (personal account)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import { google } from 'googleapis';

const credDir = process.argv[2] || path.join(os.homedir(), '.gmail-mcp');
const credsPath = path.join(credDir, 'credentials.json');
const keysPath = path.join(credDir, 'gcp-oauth.keys.json');

if (!fs.existsSync(keysPath)) {
  console.error(`OAuth keys not found at ${keysPath}`);
  process.exit(1);
}

const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
const { client_id, client_secret, redirect_uris } = keys.installed;
const redirectUri = redirect_uris[0] || 'http://localhost:4100/code';
const port = new URL(redirectUri).port || '4100';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  'https://www.googleapis.com/auth/calendar.events', // upgraded from calendar.readonly
];

const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirectUri);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent', // force re-consent to get new refresh token with broader scope
});

console.log('\n🔑 Opening browser for Google OAuth consent...\n');
console.log(`If browser doesn't open, visit:\n${authUrl}\n`);

// Open browser
import('child_process').then(({ exec }) => {
  exec(`open "${authUrl}"`);
});

// Start local server to receive the callback
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:${port}`);
  if (url.pathname !== '/code') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400);
    res.end('No code parameter');
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);

    // Read existing creds to preserve any fields
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(credsPath)) {
      existing = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
    }

    const updated = {
      ...existing,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || existing.refresh_token,
      scope: tokens.scope,
      token_type: tokens.token_type,
      expiry_date: tokens.expiry_date,
    };

    fs.writeFileSync(credsPath, JSON.stringify(updated, null, 2));

    console.log('\n✅ Credentials updated successfully!');
    console.log(`   Scope: ${tokens.scope}`);
    console.log(`   Saved to: ${credsPath}\n`);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>✅ Authorization complete!</h1><p>You can close this tab.</p>');

    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 1000);
  } catch (err) {
    console.error('Token exchange failed:', err);
    res.writeHead(500);
    res.end('Token exchange failed');
    server.close();
    process.exit(1);
  }
});

server.listen(Number(port), () => {
  console.log(`Waiting for OAuth callback on port ${port}...`);
});
