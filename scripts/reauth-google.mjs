#!/usr/bin/env node
/**
 * Manual Google OAuth re-auth for headless/mobile use.
 * No SSH tunnel needed — paste the code from the redirect URL.
 *
 * Usage:
 *   node scripts/reauth-google.mjs gmail illysium
 *   node scripts/reauth-google.mjs gmail sunday
 *   node scripts/reauth-google.mjs calendar normal
 *   node scripts/reauth-google.mjs calendar illysium
 *   node scripts/reauth-google.mjs all          # re-auth everything that's expired
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

const HOME = os.homedir();
const OAUTH_KEYS_PATH = path.join(HOME, '.gmail-mcp', 'gcp-oauth.keys.json');
const CALENDAR_TOKENS_PATH = path.join(HOME, '.config', 'google-calendar-mcp', 'tokens.json');
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
// Use a localhost redirect — Google still allows it for "installed" apps.
// The browser will fail to connect, but the code is in the URL bar.
const REDIRECT_URI = 'http://localhost:3000/oauth2callback';

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.settings.basic',
];
const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
];

function readOAuthKeys() {
  const raw = JSON.parse(fs.readFileSync(OAUTH_KEYS_PATH, 'utf-8'));
  const keys = raw.installed || raw.web;
  return { clientId: keys.client_id, clientSecret: keys.client_secret };
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

function generateAuthUrl(clientId, scopes, loginHint) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent', // force new refresh token
  });
  if (loginHint) params.set('login_hint', loginHint);
  return `${AUTH_ENDPOINT}?${params}`;
}

function extractCode(input) {
  // Accept either a bare code or a full URL containing ?code=...
  const match = input.match(/[?&]code=([^&]+)/);
  if (match) return decodeURIComponent(match[1]);
  return input; // assume bare code
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

// --- Gmail ---

function discoverGmailAccounts() {
  const accounts = [];
  if (fs.existsSync(path.join(HOME, '.gmail-mcp', 'credentials.json'))) {
    accounts.push({ label: 'primary', dir: path.join(HOME, '.gmail-mcp') });
  }
  for (const entry of fs.readdirSync(HOME)) {
    if (!entry.startsWith('.gmail-mcp-')) continue;
    const dir = path.join(HOME, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (!fs.existsSync(path.join(dir, 'credentials.json'))) continue;
    accounts.push({ label: entry.replace('.gmail-mcp-', ''), dir });
  }
  return accounts;
}

const GMAIL_LOGIN_HINTS = {
  primary: 'david.kim6@gmail.com',
  illysium: 'dave@illysium.ai',
  sunday: 'david.kim@getsunday.com',
  personal2: 'dave.kim917@gmail.com',
  numberdrinks: 'dave@numberdrinks.com',
};

async function reauthGmail(account, oauthKeys) {
  const loginHint = GMAIL_LOGIN_HINTS[account.label];
  const url = generateAuthUrl(oauthKeys.clientId, GMAIL_SCOPES, loginHint);

  console.log(`\n=== Gmail: ${account.label} (${loginHint || 'unknown'}) ===`);
  console.log(`Open this URL:\n${url}\n`);
  console.log('After authorizing, the browser will show "can\'t connect".');
  console.log('Copy the FULL URL from the address bar and paste it here.\n');

  const input = await ask('Paste URL or code: ');
  const code = extractCode(input);
  const tokens = await exchangeCode(code, oauthKeys.clientId, oauthKeys.clientSecret);

  const credPath = path.join(account.dir, 'credentials.json');
  const creds = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    scope: GMAIL_SCOPES.join(' '),
    token_type: tokens.token_type || 'Bearer',
    expiry_date: Date.now() + (tokens.expires_in || 3600) * 1000,
  };
  fs.writeFileSync(credPath, JSON.stringify(creds, null, 2) + '\n');
  console.log(`✓ Gmail ${account.label} re-authed successfully`);
}

// --- Calendar ---

function discoverCalendarAccounts() {
  try {
    const tokens = JSON.parse(fs.readFileSync(CALENDAR_TOKENS_PATH, 'utf-8'));
    return Object.keys(tokens);
  } catch {
    return [];
  }
}

const CALENDAR_LOGIN_HINTS = {
  normal: 'david.kim6@gmail.com',
  sunday: 'david.kim@getsunday.com',
  personal2: 'dave.kim917@gmail.com',
  illysium: 'dave@illysium.ai',
  numberdrinks: 'dave@numberdrinks.com',
};

async function reauthCalendar(accountId, oauthKeys) {
  const loginHint = CALENDAR_LOGIN_HINTS[accountId];
  const url = generateAuthUrl(oauthKeys.clientId, CALENDAR_SCOPES, loginHint);

  console.log(`\n=== Calendar: ${accountId} (${loginHint || 'unknown'}) ===`);
  console.log(`Open this URL:\n${url}\n`);
  console.log('After authorizing, copy the FULL URL from the address bar.\n');

  const input = await ask('Paste URL or code: ');
  const code = extractCode(input);
  const tokens = await exchangeCode(code, oauthKeys.clientId, oauthKeys.clientSecret);

  // Read existing tokens file, update just this account
  let allTokens = {};
  try {
    allTokens = JSON.parse(fs.readFileSync(CALENDAR_TOKENS_PATH, 'utf-8'));
  } catch { /* fresh file */ }

  allTokens[accountId] = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    scope: CALENDAR_SCOPES.join(' '),
    token_type: tokens.token_type || 'Bearer',
    expiry_date: Date.now() + (tokens.expires_in || 3600) * 1000,
  };
  fs.writeFileSync(CALENDAR_TOKENS_PATH, JSON.stringify(allTokens, null, 2) + '\n');
  console.log(`✓ Calendar ${accountId} re-authed successfully`);
}

// --- Main ---

async function main() {
  const [, , type, account] = process.argv;
  const oauthKeys = readOAuthKeys();

  if (type === 'all') {
    // Re-auth everything with expired tokens
    const gmailAccounts = discoverGmailAccounts();
    for (const acct of gmailAccounts) {
      const credPath = path.join(acct.dir, 'credentials.json');
      try {
        const creds = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
        if (creds.expiry_date && Date.now() < creds.expiry_date - 5 * 60 * 1000) {
          console.log(`Gmail ${acct.label}: still valid, skipping`);
          continue;
        }
      } catch { /* re-auth if unreadable */ }
      await reauthGmail(acct, oauthKeys);
    }

    const calAccounts = discoverCalendarAccounts();
    for (const acctId of calAccounts) {
      try {
        const tokens = JSON.parse(fs.readFileSync(CALENDAR_TOKENS_PATH, 'utf-8'));
        const entry = tokens[acctId];
        if (entry?.expiry_date && Date.now() < entry.expiry_date - 5 * 60 * 1000) {
          console.log(`Calendar ${acctId}: still valid, skipping`);
          continue;
        }
      } catch { /* re-auth */ }
      await reauthCalendar(acctId, oauthKeys);
    }
    return;
  }

  if (type === 'gmail') {
    const gmailAccounts = discoverGmailAccounts();
    const acct = gmailAccounts.find((a) => a.label === account);
    if (!acct) {
      console.error(`Gmail account "${account}" not found. Available: ${gmailAccounts.map((a) => a.label).join(', ')}`);
      process.exit(1);
    }
    await reauthGmail(acct, oauthKeys);
  } else if (type === 'calendar') {
    const calAccounts = discoverCalendarAccounts();
    if (!calAccounts.includes(account)) {
      console.error(`Calendar account "${account}" not found. Available: ${calAccounts.join(', ')}`);
      process.exit(1);
    }
    await reauthCalendar(account, oauthKeys);
  } else {
    console.log('Usage:');
    console.log('  node scripts/reauth-google.mjs gmail <account>');
    console.log('  node scripts/reauth-google.mjs calendar <account>');
    console.log('  node scripts/reauth-google.mjs all    # re-auth all expired tokens');
    console.log('\nGmail accounts:', discoverGmailAccounts().map((a) => a.label).join(', '));
    console.log('Calendar accounts:', discoverCalendarAccounts().join(', '));
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
