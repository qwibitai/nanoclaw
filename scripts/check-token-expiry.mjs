#!/usr/bin/env node
/**
 * check-token-expiry.mjs
 * Checks Claude Code OAuth token expiry and sends a Telegram warning if it
 * expires within WARN_THRESHOLD_MS. Run on a schedule via launchd.
 *
 * Rate-limiting: once an alert is sent, a state file records the timestamp.
 * Subsequent runs suppress the alert until RESEND_INTERVAL_MS has elapsed,
 * preventing spam when nanoclaw is left unattended overnight.
 * The state file is cleared automatically when the token is no longer expired.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';

const WARN_THRESHOLD_MS = 0; // warn only when already expired
const RESEND_INTERVAL_MS = 4 * 60 * 60 * 1000; // re-alert at most once per 4h
const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const STATE_FILE = path.join(os.tmpdir(), 'nanoclaw-token-alert.json');
const ENV_FILE = path.join(import.meta.dirname, '..', '.env');
const ASSISTANT_NAME = readEnv('ASSISTANT_NAME') || 'Anlovely';

function readEnv(key) {
  try {
    const lines = fs.readFileSync(ENV_FILE, 'utf-8').split('\n');
    for (const line of lines) {
      const [k, ...rest] = line.split('=');
      if (k.trim() === key) return rest.join('=').trim();
    }
  } catch { /* ignore */ }
  return process.env[key] || '';
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function writeState(data) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(data));
  } catch { /* ignore */ }
}

function clearState() {
  try {
    fs.unlinkSync(STATE_FILE);
  } catch { /* ignore */ }
}

function sendTelegram(botToken, chatId, text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

async function main() {
  let creds;
  try {
    creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
  } catch {
    console.error('Could not read credentials file');
    process.exit(0);
  }

  const expiresAt = creds?.claudeAiOauth?.expiresAt;
  if (!expiresAt) process.exit(0);

  const msRemaining = expiresAt - Date.now();
  const minRemaining = Math.round(msRemaining / 60000);

  if (msRemaining > WARN_THRESHOLD_MS) {
    console.log(`Token OK — expires in ${minRemaining} min`);
    clearState(); // token is valid again, reset so next expiry gets a fresh alert
    process.exit(0);
  }

  // Token is expired — try to refresh it first before alerting
  try {
    const refreshScript = path.join(import.meta.dirname, 'refresh-token.mjs');
    execFileSync(process.execPath, [refreshScript], { stdio: 'pipe', timeout: 30000 });
    // Re-read credentials to check if refresh succeeded
    const freshCreds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
    if ((freshCreds?.claudeAiOauth?.expiresAt ?? 0) > Date.now()) {
      console.log('Token refreshed automatically — no alert needed');
      clearState();
      process.exit(0);
    }
  } catch {
    // refresh failed, fall through to alert
  }

  // Token is expired — check if we already alerted recently
  const state = readState();
  const now = Date.now();
  if (state?.lastAlertAt && now - state.lastAlertAt < RESEND_INTERVAL_MS) {
    const nextIn = Math.round((RESEND_INTERVAL_MS - (now - state.lastAlertAt)) / 60000);
    console.log(`Token expired but alert suppressed — next alert in ${nextIn} min`);
    process.exit(0);
  }

  const botToken = readEnv('TELEGRAM_BOT_TOKEN');
  const chatId = readEnv('TELEGRAM_CHAT_ID');

  if (!botToken || !chatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
    process.exit(1);
  }

  const msg = `⚠️ Claude Code token 已過期。請執行 /login 重新登入，${ASSISTANT_NAME} 才能繼續運作。`;
  console.log(msg);
  const status = await sendTelegram(botToken, chatId, msg);
  if (status === 200) {
    writeState({ lastAlertAt: now });
  } else {
    console.error(`Telegram delivery failed (HTTP ${status}) — will retry next run`);
  }
}

main();
