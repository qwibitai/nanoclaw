#!/usr/bin/env node
/**
 * gws-auth: OAuth helper for @googleworkspace/cli credentials.
 *
 * Runs an HTTP server on port 3000 (matching the registered redirect URI),
 * performs the OAuth flow for Google Calendar (+ openid + email), and
 * saves credentials in gws authorized_user format.
 *
 * Usage (with SSH tunnel active: ssh -L 3000:localhost:3000 server):
 *   node scripts/gws-auth.mjs
 */

import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLIENT_SECRET_PATH = path.join(process.env.HOME, '.gmail-mcp', 'gcp-oauth.keys.json');
const GWS_CREDENTIALS_PATH = path.join(process.env.HOME, '.config', 'gws', 'credentials.json');
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');

// Read OAuth client credentials
const secret = JSON.parse(fs.readFileSync(CLIENT_SECRET_PATH, 'utf-8'));
const clientConfig = secret.web || secret.installed;
const { client_id, client_secret } = clientConfig;

// Build auth URL
const authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
authUrl.searchParams.set('client_id', client_id);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('scope', SCOPES);
authUrl.searchParams.set('access_type', 'offline');
authUrl.searchParams.set('prompt', 'select_account consent');

console.log('\nVisit this URL in your browser (with SSH tunnel active on port 3000):\n');
console.log(authUrl.toString());
console.log('\nWaiting for OAuth callback on port 3000...\n');

// Start HTTP server on port 3000
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3000');
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h2>Auth failed: ${error}</h2><p>You can close this tab.</p>`);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<h2>No code received</h2><p>You can close this tab.</p>');
    server.close();
    process.exit(1);
  }

  // Exchange code for tokens
  const body = new URLSearchParams({
    code,
    client_id,
    client_secret,
    redirect_uri: REDIRECT_URI,
    grant_type: 'authorization_code',
  }).toString();

  try {
    const tokens = await exchangeCode(body);

    if (!tokens.refresh_token) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h2>No refresh token returned</h2><p>Try revoking access at myaccount.google.com/permissions and re-running.</p>');
      server.close();
      process.exit(1);
    }

    // Save in gws authorized_user format
    const credentials = {
      type: 'authorized_user',
      client_id,
      client_secret,
      refresh_token: tokens.refresh_token,
    };

    fs.mkdirSync(path.dirname(GWS_CREDENTIALS_PATH), { recursive: true });
    fs.writeFileSync(GWS_CREDENTIALS_PATH, JSON.stringify(credentials, null, 2) + '\n');

    console.log(`\nCredentials saved to: ${GWS_CREDENTIALS_PATH}`);
    console.log('Authentication successful!\n');

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h2>Authentication successful!</h2><p>You can close this tab and return to the terminal.</p>');
    server.close();
  } catch (err) {
    console.error('Token exchange failed:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<h2>Token exchange failed</h2><pre>${err.message}</pre><p>You can close this tab.</p>`);
    server.close();
    process.exit(1);
  }
});

function exchangeCode(body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path: '/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) reject(new Error(`${parsed.error}: ${parsed.error_description}`));
          else resolve(parsed);
        } catch (e) {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

server.listen(3000, 'localhost', () => {
  // server is ready, URL already printed above
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port 3000 is in use. Run: fuser -k 3000/tcp');
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});
