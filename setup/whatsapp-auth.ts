/**
 * Step: whatsapp-auth — standalone WhatsApp (Baileys v7) authentication.
 *
 * Forked from the channels-branch version so setup:auto's driver can render
 * the terminal UX itself (inside clack) instead of the step dumping a raw QR
 * to stdout. The browser method has been dropped — one less moving part and
 * it kept biting headless/SSH users.
 *
 * Methods:
 *   --method qr (default)          Emit each rotating QR as a status block
 *                                  with the raw QR string. Driver renders.
 *   --method pairing-code --phone  Request a pairing code. Emitted in a
 *                                  status block once the Baileys call returns.
 *
 * Block schema (parent parses these):
 *   WHATSAPP_AUTH_QR             { QR: "<raw>" }              — repeats
 *   WHATSAPP_AUTH_PAIRING_CODE   { CODE: "XXXX-XXXX" }        — one-shot
 *   WHATSAPP_AUTH                { STATUS: success }          — terminal
 *                                { STATUS: skipped, AUTH_DIR, REASON }
 *                                { STATUS: failed, ERROR: <reason> }
 *
 * STATUS values are kept in the runner's vocabulary (success/skipped/failed)
 * so `spawnStep` recognises them and sets `ok` correctly; WhatsApp-specific
 * UI text (e.g. "WhatsApp linked") lives in the driver's block handler.
 *
 * On success, credentials land in store/auth/ and the process exits 0.
 */
import fs from 'fs';
import path from 'path';
// Named import (not default) — pino's d.ts under NodeNext resolves the
// default export to `typeof pino` (namespace), which isn't callable. The
// named `pino` export resolves to the callable function.
import { pino } from 'pino';

import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import { emitStatus } from './status.js';

const AUTH_DIR = path.join(process.cwd(), 'store', 'auth');
const PAIRING_CODE_FILE = path.join(process.cwd(), 'store', 'pairing-code.txt');
const baileysLogger = pino({ level: 'silent' });

/** Fetch current WA Web version — wppconnect tracker, then Baileys sw.js scrape. */
async function resolveWaWebVersion(): Promise<[number, number, number]> {
  try {
    const res = await fetch('https://wppconnect.io/whatsapp-versions/', {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const html = await res.text();
      const match = html.match(/2\.3000\.(\d+)/);
      if (match) return [2, 3000, Number(match[1])];
    }
  } catch { /* fall through */ }
  try {
    const { version } = await fetchLatestWaWebVersion({});
    if (version) return version as [number, number, number];
  } catch { /* fall through */ }
  throw new Error('Could not fetch current WhatsApp Web version — cannot connect with stale version');
}

type AuthMethod = 'qr' | 'pairing-code';

function parseArgs(args: string[]): { method: AuthMethod; phone?: string } {
  let method: AuthMethod = 'qr';
  let phone: string | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--method': {
        const raw = args[++i];
        if (raw === 'qr' || raw === 'pairing-code') {
          method = raw;
        } else {
          console.error(`Unknown --method: ${raw} (expected 'qr' or 'pairing-code')`);
          process.exit(1);
        }
        break;
      }
      case '--phone':
        phone = args[++i];
        break;
    }
  }

  if (method === 'pairing-code' && !phone) {
    console.error('--phone is required for pairing-code method');
    process.exit(1);
  }

  return { method, phone };
}

export async function run(args: string[]): Promise<void> {
  const { method, phone } = parseArgs(args);

  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    emitStatus('WHATSAPP_AUTH', {
      STATUS: 'skipped',
      REASON: 'already-authenticated',
      AUTH_DIR,
    });
    return;
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });

  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      emitStatus('WHATSAPP_AUTH', { STATUS: 'failed', ERROR: 'timeout' });
      process.exit(1);
    }, 120_000);

    let succeeded = false;
    function succeed(): void {
      if (succeeded) return;
      succeeded = true;
      clearTimeout(timeout);
      try {
        if (fs.existsSync(PAIRING_CODE_FILE)) fs.unlinkSync(PAIRING_CODE_FILE);
      } catch {
        // ignore — the pairing code file is best-effort cleanup
      }
      emitStatus('WHATSAPP_AUTH', { STATUS: 'success' });
      resolve();
      // Give a moment for creds to flush before exiting.
      setTimeout(() => process.exit(0), 1000);
    }

    async function connectSocket(isReconnect = false): Promise<void> {
      const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
      const version = await resolveWaWebVersion();

      const sock = makeWASocket({
        version,
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
        },
        printQRInTerminal: false,
        logger: baileysLogger,
        browser: Browsers.macOS('Chrome'),
      });

      // Request pairing code only on first connect (not reconnect after 515).
      if (
        !isReconnect &&
        method === 'pairing-code' &&
        phone &&
        !state.creds.registered
      ) {
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(phone);
            fs.writeFileSync(PAIRING_CODE_FILE, code, 'utf-8');
            emitStatus('WHATSAPP_AUTH_PAIRING_CODE', { CODE: code });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            emitStatus('WHATSAPP_AUTH', { STATUS: 'failed', ERROR: message });
            process.exit(1);
          }
        }, 3000);
      }

      sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // QR method: emit each rotation as a block. Parent renders.
        if (qr && method === 'qr') {
          emitStatus('WHATSAPP_AUTH_QR', { QR: qr });
        }

        if (connection === 'open') {
          succeed();
          sock.end(undefined);
        }

        if (connection === 'close') {
          const reason = (
            lastDisconnect?.error as { output?: { statusCode?: number } }
          )?.output?.statusCode;
          if (reason === DisconnectReason.loggedOut) {
            clearTimeout(timeout);
            emitStatus('WHATSAPP_AUTH', {
              STATUS: 'failed',
              ERROR: 'logged_out',
            });
            process.exit(1);
          } else if (reason === DisconnectReason.timedOut) {
            clearTimeout(timeout);
            emitStatus('WHATSAPP_AUTH', {
              STATUS: 'failed',
              ERROR: 'qr_timeout',
            });
            process.exit(1);
          } else if (reason === 515) {
            // 515 = stream error after pairing succeeds but before registration
            // completes. Reconnect to finish the handshake.
            connectSocket(true);
          }
        }
      });

      sock.ev.on('creds.update', saveCreds);
    }

    connectSocket();
  });
}
