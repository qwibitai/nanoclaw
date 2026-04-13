import https from 'https';

import { readEnvFile } from './env.js';
import { getRouterState, setRouterState } from './db.js';
import { logger } from './logger.js';
import {
  parseOpsCommand,
  executeOpsCommand,
  isNotificationMuted,
} from './ops-commands.js';

const OPS_CHAT_ID = '6451555289';
const ALLOWED_USER_ID = 6451555289;
const MAX_LENGTH = 4096;
const POLL_TIMEOUT = 30;

let cachedToken: string | null = null;

function getToken(): string | null {
  if (cachedToken) return cachedToken;
  const env = readEnvFile(['TELEGRAM_OPS_BOT_TOKEN']);
  cachedToken = env.TELEGRAM_OPS_BOT_TOKEN || null;
  return cachedToken;
}

// --- Send ---

export function sendOpsNotification(text: string): Promise<boolean> {
  const token = getToken();
  if (!token) {
    logger.warn(
      'No TELEGRAM_OPS_BOT_TOKEN configured, skipping ops notification',
    );
    return Promise.resolve(false);
  }

  if (isNotificationMuted(text)) {
    logger.debug({ textSnippet: text.slice(0, 80) }, 'Ops notification muted');
    return Promise.resolve(true);
  }

  const truncated = text.length > MAX_LENGTH ? text.slice(0, MAX_LENGTH) : text;
  return sendRaw(token, truncated, true);
}

function sendRaw(
  token: string,
  text: string,
  markdown: boolean,
): Promise<boolean> {
  return new Promise((resolve) => {
    const body: Record<string, string> = { chat_id: OPS_CHAT_ID, text };
    if (markdown) body.parse_mode = 'Markdown';
    const payload = JSON.stringify(body);

    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(true);
          } else {
            const respBody = Buffer.concat(chunks).toString();
            if (
              markdown &&
              res.statusCode === 400 &&
              respBody.includes('parse')
            ) {
              sendRaw(token, text, false).then(resolve);
            } else {
              logger.warn(
                { status: res.statusCode, body: respBody.slice(0, 200) },
                'Ops bot send failed',
              );
              resolve(false);
            }
          }
        });
      },
    );

    req.on('error', (err) => {
      logger.warn({ err }, 'Ops bot network error');
      resolve(false);
    });
    req.setTimeout(10000, () => {
      req.destroy();
      resolve(false);
    });
    req.write(payload);
    req.end();
  });
}

// --- Polling for incoming commands ---

function getOffset(): number {
  const raw = getRouterState('ops_poll_offset');
  return raw ? parseInt(raw) : 0;
}

function setOffset(offset: number): void {
  setRouterState('ops_poll_offset', String(offset));
}

function getUpdates(
  token: string,
  offset: number,
): Promise<{ ok: boolean; result: any[] }> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${token}/getUpdates?offset=${offset}&timeout=${POLL_TIMEOUT}&allowed_updates=["message"]`,
        method: 'GET',
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()));
          } catch {
            resolve({ ok: false, result: [] });
          }
        });
      },
    );

    req.on('error', () => resolve({ ok: false, result: [] }));
    req.setTimeout((POLL_TIMEOUT + 10) * 1000, () => {
      req.destroy();
      resolve({ ok: false, result: [] });
    });
    req.end();
  });
}

async function pollLoop(): Promise<void> {
  const token = getToken();
  if (!token) {
    logger.warn('Ops bot polling disabled: no token');
    return;
  }

  let offset = getOffset();
  let polling = false;
  logger.info({ offset }, 'Ops bot polling started');

  const tick = async () => {
    if (polling) return;
    polling = true;
    try {
      const response = await getUpdates(token, offset);
      if (response.ok && response.result.length > 0) {
        for (const update of response.result) {
          offset = update.update_id + 1;
          setOffset(offset);

          const msg = update.message;
          if (!msg?.text) continue;
          if (msg.from?.id !== ALLOWED_USER_ID) continue;
          if (String(msg.chat.id) !== OPS_CHAT_ID) continue;

          const text = msg.text.trim();
          if (text === '/start') continue;

          const cmd = parseOpsCommand(text);
          if (cmd) {
            const result = await executeOpsCommand(cmd);
            await sendRaw(token, result, false);
          } else {
            await sendRaw(
              token,
              'Send that to @GMRNanoBot — I only handle quick ops commands.\n\nTry: close #N, mute <keyword>, unmute <keyword>, mutes, status, ack',
              false,
            );
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Ops bot poll error');
    } finally {
      polling = false;
    }

    setTimeout(tick, 1000);
  };

  tick();
}

export function startOpsPolling(): void {
  pollLoop();
}
