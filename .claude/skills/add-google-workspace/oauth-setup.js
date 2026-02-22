#!/usr/bin/env node
/**
 * Google OAuth setup for NanoClaw
 * Run once per Google account to obtain a refresh token.
 * Writes the account entry to ~/.nanoclaw/data/accounts/accounts.json
 *
 * Usage (interactive): node oauth-setup.js
 * Usage (CLI args):     node oauth-setup.js <alias> <client_id> <client_secret> <services>
 *   services: "all" or comma-separated: gmail,calendar,drive,sheets,docs
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createInterface } from 'readline';
import { exec } from 'child_process';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

const SCOPES_BY_SERVICE = {
  gmail: 'https://www.googleapis.com/auth/gmail.modify',
  calendar: 'https://www.googleapis.com/auth/calendar',
  drive: 'https://www.googleapis.com/auth/drive',
  sheets: 'https://www.googleapis.com/auth/spreadsheets',
  docs: 'https://www.googleapis.com/auth/documents',
};

const ACCOUNTS_PATH = path.join(
  process.env.HOME || os.homedir(),
  '.nanoclaw', 'data', 'accounts', 'accounts.json'
);

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

function openBrowser(url) {
  exec(`open "${url}"`);
}

async function exchangeCodeForTokens(code, clientId, clientSecret, redirectUri) {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  return res.json();
}

function waitForAuthCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization denied</h1><p>You can close this tab.</p>');
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end('Missing code');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>');
      server.close();
      resolve(code);
    });

    // Port 0 = OS assigns a free port automatically
    server.listen(0, () => {
      const { port } = server.address();
      const redirectUri = `http://localhost:${port}/callback`;
      console.log(`Waiting for OAuth callback on ${redirectUri}...`);
      resolve._redirectUri = redirectUri;
      server._redirectUri = redirectUri;
    });

    server.on('error', reject);

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error('OAuth timeout: no response within 5 minutes'));
    }, 5 * 60 * 1000);
  });
}

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveAccounts(accounts) {
  fs.mkdirSync(path.dirname(ACCOUNTS_PATH), { recursive: true });
  fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2) + '\n', { mode: 0o600 });
}

async function main() {
  const allServices = Object.keys(SCOPES_BY_SERVICE);
  let alias, clientId, clientSecret, services;

  // Accept CLI args: node oauth-setup.js <alias> <client_id> <client_secret> <services>
  if (process.argv.length >= 6) {
    [,, alias, clientId, clientSecret] = process.argv;
    const servicesArg = process.argv[5];
    services = servicesArg === 'all'
      ? allServices
      : servicesArg.split(',').map(s => s.trim()).filter(s => allServices.includes(s));
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    console.log('\nNanoClaw — Google OAuth Setup\n');

    alias = (await ask(rl, 'Account alias (e.g. "workspace", "personal"): ')).trim();
    if (!alias) { console.error('Alias cannot be empty'); process.exit(1); }

    clientId = (await ask(rl, 'Client ID: ')).trim();
    clientSecret = (await ask(rl, 'Client Secret: ')).trim();

    console.log('\nAvailable services: gmail, calendar, drive, sheets, docs');
    const servicesInput = (await ask(rl, 'Services to enable (comma-separated, or "all"): ')).trim();
    services = servicesInput === 'all'
      ? allServices
      : servicesInput.split(',').map(s => s.trim()).filter(s => allServices.includes(s));

    rl.close();
  }

  if (services.length === 0) {
    console.error('No valid services selected');
    process.exit(1);
  }

  // Start callback server first to get the dynamic port
  let redirectUri;
  const codePromise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost`);
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization denied</h1><p>You can close this tab.</p>');
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>');
      server.close();
      resolve(code);
    });

    server.listen(0, () => {
      const { port } = server.address();
      redirectUri = `http://localhost:${port}/callback`;
      console.log(`\nWaiting for OAuth callback on ${redirectUri}...`);

      const scopes = services.map(s => SCOPES_BY_SERVICE[s]).join(' ');
      const authParams = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scopes,
        access_type: 'offline',
        prompt: 'consent',
      });

      const authUrl = `${AUTH_URL}?${authParams.toString()}`;
      console.log(`\nOpening browser for Google authorization...`);
      console.log(`If the browser doesn't open, visit:\n${authUrl}\n`);
      openBrowser(authUrl);
    });

    server.on('error', reject);

    setTimeout(() => {
      server.close();
      reject(new Error('OAuth timeout: no response within 5 minutes'));
    }, 5 * 60 * 1000);
  });

  let code;
  try {
    code = await codePromise;
  } catch (err) {
    console.error(`\nFailed to get auth code: ${err.message}`);
    process.exit(1);
  }

  console.log('\nExchanging code for tokens...');
  let tokens;
  try {
    tokens = await exchangeCodeForTokens(code, clientId, clientSecret, redirectUri);
  } catch (err) {
    console.error(`\nToken exchange failed: ${err.message}`);
    process.exit(1);
  }

  if (!tokens.refresh_token) {
    console.error('\nNo refresh token received. Make sure the OAuth consent screen has "prompt=consent" and the account has not previously authorized this app (or revoke access at https://myaccount.google.com/permissions and try again).');
    process.exit(1);
  }

  const accounts = loadAccounts();
  accounts[alias] = {
    provider: 'google',
    services,
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
  };
  saveAccounts(accounts);

  console.log(`\nAccount "${alias}" saved to ${ACCOUNTS_PATH}`);
  console.log(`Services: ${services.join(', ')}`);
  console.log('\nDone. Run this script again to add another account.');
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
