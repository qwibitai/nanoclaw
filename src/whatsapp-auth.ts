/**
 * WhatsApp Authentication Script
 *
 * Run this during setup to authenticate with WhatsApp.
 * Displays QR code, waits for scan, saves credentials, then exits.
 *
 * Usage: npx tsx src/whatsapp-auth.ts
 */
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

const AUTH_DIR = './store/auth';
const MAX_RESTARTS = 5;

const logger = pino({
  level: 'warn', // Quiet logging - only show errors
});

async function authenticate(restartCount = 0): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  let restarting = false;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (state.creds.registered) {
    console.log('✓ Already authenticated with WhatsApp');
    console.log(
      '  To re-authenticate, delete the store/auth folder and run again.',
    );
    process.exit(0);
  }

  console.log('Starting WhatsApp authentication...\n');

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: ['NanoClaw', 'Chrome', '1.0.0'],
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('Scan this QR code with WhatsApp:\n');
      console.log('  1. Open WhatsApp on your phone');
      console.log('  2. Tap Settings → Linked Devices → Link a Device');
      console.log('  3. Point your camera at the QR code below\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        console.log('\n✗ Logged out. Delete store/auth and try again.');
        process.exit(1);
      } else if (reason === DisconnectReason.restartRequired) {
        if (restarting) {
          return;
        }
        if (restartCount >= MAX_RESTARTS) {
          console.log(`\n✗ Restart limit reached (${MAX_RESTARTS}). Please try again later.`);
          process.exit(1);
        }
        restarting = true;
        // Server requested restart (515) - reconnect automatically
        console.log('\n⚠ Server requested restart, reconnecting...');
        sock.ev.removeAllListeners('connection.update');
        sock.ev.removeAllListeners('creds.update');
        sock.end?.(undefined);
        return authenticate(restartCount + 1);
      } else {
        console.log('\n✗ Connection failed. Please try again.');
        process.exit(1);
      }
    }

    if (connection === 'open') {
      console.log('\n✓ Successfully authenticated with WhatsApp!');
      console.log('  Credentials saved to store/auth/');
      console.log('  You can now start the NanoClaw service.\n');

      // Give it a moment to save credentials, then exit
      setTimeout(() => process.exit(0), 1000);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  process.exit(1);
});
