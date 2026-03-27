#!/usr/bin/env node
/**
 * check-token-expiry.mjs
 * Checks Claude Code OAuth token expiry and sends a Telegram warning if it
 * expires within WARN_THRESHOLD_MS. Run on a schedule via launchd.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';

const WARN_THRESHOLD_MS = 90 * 60 * 1000; // warn when < 90 min remaining
const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');
const ENV_FILE = path.join(import.meta.dirname, '..', '.env');

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
    process.exit(0);
  }

  const botToken = readEnv('TELEGRAM_BOT_TOKEN');
  const chatId = readEnv('TELEGRAM_CHAT_ID');

  if (!botToken || !chatId) {
    console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
    process.exit(1);
  }

  const msg = msRemaining <= 0
    ? `⚠️ Claude Code token 已過期。請執行 /login 重新登入，Anlovely 才能繼續運作。`
    : `⚠️ Claude Code token 將在 ${minRemaining} 分鐘後過期。請執行 /login 重新登入。`;

  console.log(msg);
  await sendTelegram(botToken, chatId, msg);
}

main();
