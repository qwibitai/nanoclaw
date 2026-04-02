#!/usr/bin/env node
/**
 * refresh-token.mjs
 * Silently refreshes the Claude Code OAuth token using the refreshToken
 * stored in ~/.claude/.credentials.json. No user interaction needed.
 *
 * Exit codes:
 *   0 — token refreshed (or was already valid and skipped)
 *   1 — refresh failed (credentials file missing, no refreshToken, or API error)
 *
 * Run via launchd on a schedule, e.g. every 4 hours.
 */
import fs from 'fs';
import os from 'os';
import https from 'https';

const CREDENTIALS_FILE =
  process.env.CLAUDE_CREDENTIALS_FILE ||
  `${os.homedir()}/.claude/.credentials.json`;

const REFRESH_BEFORE_EXPIRY_MS = 30 * 60 * 1000; // refresh when <30min remaining
const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 30 * 1000; // 30s between retries
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const TOKEN_ENDPOINT = 'platform.claude.com';
const TOKEN_PATH = '/v1/oauth/token';

function readCreds() {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function writeCreds(creds) {
  const tmp = `${CREDENTIALS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(creds, null, 2), 'utf-8');
  fs.renameSync(tmp, CREDENTIALS_FILE);
}

function postForm(data) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(data).toString();
    const req = https.request(
      {
        hostname: TOKEN_ENDPOINT,
        path: TOKEN_PATH,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode, body: raw });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const creds = readCreds();
  if (!creds) {
    console.error('Could not read credentials file:', CREDENTIALS_FILE);
    process.exit(1);
  }

  const oauth = creds.claudeAiOauth;
  if (!oauth?.refreshToken) {
    console.error('No refreshToken found in credentials file');
    process.exit(1);
  }

  const msRemaining = (oauth.expiresAt ?? 0) - Date.now();
  if (msRemaining > REFRESH_BEFORE_EXPIRY_MS) {
    console.log(
      `Token still valid for ${Math.round(msRemaining / 60000)} min — skipping refresh`,
    );
    process.exit(0);
  }

  console.log('Refreshing OAuth token...');
  let resp;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      resp = await postForm({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: CLIENT_ID,
      });
      // 4xx = auth error (refreshToken revoked/expired) — no point retrying
      if (resp.status >= 400 && resp.status < 500) break;
      if (resp.status === 200 && resp.body?.access_token) break;
    } catch (err) {
      console.error(`Network error (attempt ${attempt}/${RETRY_ATTEMPTS}):`, err.message);
      resp = null;
    }
    if (attempt < RETRY_ATTEMPTS) {
      console.log(`Retrying in ${RETRY_DELAY_MS / 1000}s...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }

  if (!resp || resp.status !== 200 || !resp.body?.access_token) {
    const detail = resp
      ? `HTTP ${resp.status}: ${typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)}`
      : 'network failure after all retries';
    console.error(`Token refresh failed — ${detail}`);
    // 4xx means refreshToken itself is invalid — user must /login
    if (resp?.status >= 400 && resp?.status < 500) {
      console.error('RefreshToken is invalid or expired. Manual /login required.');
    }
    process.exit(1);
  }

  const { access_token, refresh_token, expires_in } = resp.body;
  creds.claudeAiOauth.accessToken = access_token;
  if (refresh_token) creds.claudeAiOauth.refreshToken = refresh_token;
  if (expires_in)
    creds.claudeAiOauth.expiresAt = Date.now() + expires_in * 1000;

  writeCreds(creds);
  const newExpiry = new Date(creds.claudeAiOauth.expiresAt).toISOString();
  console.log(`Token refreshed — new expiry: ${newExpiry}`);
}

main();
