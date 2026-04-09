#!/usr/bin/env node
/**
 * Google OAuth re-auth for headless/mobile use.
 * Consolidated credentials — one file per account with all scopes.
 * No SSH tunnel needed — paste the code from the redirect URL.
 *
 * Credentials are stored at ~/.config/gws/{account}.json in the
 * gws authorized_user format (type, client_id, client_secret, refresh_token).
 *
 * Usage:
 *   node scripts/reauth-google.mjs primary
 *   node scripts/reauth-google.mjs sunday
 *   node scripts/reauth-google.mjs all          # re-auth everything that's expired
 *   node scripts/reauth-google.mjs list         # show accounts and status
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

const HOME = os.homedir();
const GWS_CREDS_DIR = path.join(HOME, '.config', 'gws', 'accounts');
const OAUTH_KEYS_PATH = path.join(HOME, '.gmail-mcp', 'gcp-oauth.keys.json');
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

// Combined scopes — one auth flow covers Gmail, Calendar, Drive, Docs, Sheets, Slides
const ALL_SCOPES = [
  // Gmail
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
  // Calendar
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
  // Drive
  'https://www.googleapis.com/auth/drive',
  // Docs
  'https://www.googleapis.com/auth/documents',
  // Sheets
  'https://www.googleapis.com/auth/spreadsheets',
  // Slides
  'https://www.googleapis.com/auth/presentations',
];

// Account registry: label → email (used as login_hint)
const ACCOUNTS = {
  primary: 'david.kim6@gmail.com',
  personal2: 'dave.kim917@gmail.com',
  sunday: 'david.kim@getsunday.com',
  illysium: 'dave@illysium.ai',
  numberdrinks: 'dave@numberdrinks.com',
  'madison-reed': 'dave.kim@madison-reed.com',
};

function readOAuthKeys() {
  const raw = JSON.parse(fs.readFileSync(OAUTH_KEYS_PATH, 'utf-8'));
  const keys = raw.installed || raw.web;
  return { clientId: keys.client_id, clientSecret: keys.client_secret };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

function generateAuthUrl(clientId, loginHint) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: ALL_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${AUTH_ENDPOINT}?${params}`;
}

function extractCode(input) {
  const match = input.match(/[?&]code=([^&]+)/);
  if (match) return decodeURIComponent(match[1]);
  return input;
}

async function exchangeCode(code, clientId, clientSecret) {
  const resp = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${body}`);
  }
  return resp.json();
}

function credPath(account) {
  return path.join(GWS_CREDS_DIR, `${account}.json`);
}

function readCred(account) {
  try {
    return JSON.parse(fs.readFileSync(credPath(account), 'utf-8'));
  } catch {
    return null;
  }
}

async function checkToken(cred, oauthKeys) {
  // Refresh to get a fresh access_token, then check its scopes via tokeninfo.
  // Returns { valid: false } if refresh fails, or { valid: true, scopes: [...] }.
  if (!cred?.refresh_token) return { valid: false, scopes: [] };
  try {
    const resp = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: oauthKeys.clientId,
        client_secret: oauthKeys.clientSecret,
        refresh_token: cred.refresh_token,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return { valid: false, scopes: [] };
    const tokens = await resp.json();
    // Check scopes via tokeninfo
    const infoResp = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${tokens.access_token}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!infoResp.ok) return { valid: true, scopes: [] }; // can't check scopes but token works
    const info = await infoResp.json();
    const scopes = (info.scope || '').split(' ').filter(Boolean);
    return { valid: true, scopes };
  } catch {
    return { valid: false, scopes: [] };
  }
}

function missingScopes(currentScopes) {
  // Check which required scopes are missing. Uses base scope names
  // (e.g. 'gmail.modify' matches if current has the full URL).
  return ALL_SCOPES.filter(required => !currentScopes.includes(required));
}

async function reauthAccount(account, oauthKeys) {
  const email = ACCOUNTS[account];
  if (!email) {
    console.error(`Unknown account "${account}". Available: ${Object.keys(ACCOUNTS).join(', ')}`);
    process.exit(1);
  }

  const url = generateAuthUrl(oauthKeys.clientId, email);
  console.log(`\n=== ${account} (${email}) ===`);
  console.log(`Open this URL:\n${url}\n`);
  console.log('After authorizing, the browser will show "can\'t connect".');
  console.log('Copy the FULL URL from the address bar and paste it here.\n');

  const input = await ask('Paste URL or code: ');
  const code = extractCode(input);
  const tokens = await exchangeCode(code, oauthKeys.clientId, oauthKeys.clientSecret);

  fs.mkdirSync(GWS_CREDS_DIR, { recursive: true });
  const cred = {
    type: 'authorized_user',
    client_id: oauthKeys.clientId,
    client_secret: oauthKeys.clientSecret,
    refresh_token: tokens.refresh_token,
  };
  fs.writeFileSync(credPath(account), JSON.stringify(cred, null, 2) + '\n');

  // Also update legacy credential files so the Gmail channel (host-side) keeps working.
  // Gmail channel reads from ~/.gmail-mcp*/credentials.json directly.
  const legacyDir = account === 'primary'
    ? path.join(HOME, '.gmail-mcp')
    : path.join(HOME, `.gmail-mcp-${account}`);
  if (fs.existsSync(legacyDir)) {
    const legacyCred = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      scope: ALL_SCOPES.join(' '),
      token_type: tokens.token_type || 'Bearer',
      expiry_date: Date.now() + (tokens.expires_in || 3600) * 1000,
    };
    fs.writeFileSync(path.join(legacyDir, 'credentials.json'), JSON.stringify(legacyCred, null, 2) + '\n');
    // gws-credentials.json (legacy entrypoint conversion format)
    fs.writeFileSync(path.join(legacyDir, 'gws-credentials.json'), JSON.stringify(cred, null, 2) + '\n');
  }

  console.log(`✓ ${account} (${email}) re-authed with all scopes`);
}

async function main() {
  const [, , command] = process.argv;
  const oauthKeys = readOAuthKeys();

  if (command === 'list' || !command) {
    console.log('Google accounts:\n');
    for (const [account, email] of Object.entries(ACCOUNTS)) {
      const cred = readCred(account);
      const status = cred?.refresh_token ? 'configured' : 'not configured';
      const file = fs.existsSync(credPath(account)) ? credPath(account) : '(missing)';
      console.log(`  ${account.padEnd(14)} ${email.padEnd(30)} ${status.padEnd(16)} ${file}`);
    }
    console.log(`\nCredentials dir: ${GWS_CREDS_DIR}`);
    console.log('Scopes: gmail, calendar, drive, docs, sheets, slides');
    console.log('\nUsage:');
    console.log('  node scripts/reauth-google.mjs <account>   # re-auth one account');
    console.log('  node scripts/reauth-google.mjs all         # re-auth all invalid/missing');
    return;
  }

  const force = process.argv.includes('--force');

  if (command === 'all') {
    for (const account of Object.keys(ACCOUNTS)) {
      if (!force) {
        const cred = readCred(account);
        if (cred) {
          const { valid, scopes } = await checkToken(cred, oauthKeys);
          if (valid) {
            const missing = missingScopes(scopes);
            if (missing.length === 0) {
              console.log(`${account}: valid with all scopes ✓`);
              continue;
            }
            const short = missing.map(s => s.split('/auth/')[1] || s);
            console.log(`${account}: valid but missing scopes: ${short.join(', ')}`);
          } else {
            console.log(`${account}: token invalid or expired`);
          }
        } else {
          console.log(`${account}: no credentials found`);
        }
      }
      await reauthAccount(account, oauthKeys);
    }
    return;
  }

  await reauthAccount(command, oauthKeys);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
