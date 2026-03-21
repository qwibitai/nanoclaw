/**
 * WhatsApp Authentication Script
 *
 * Run this during setup to authenticate with WhatsApp.
 * Displays QR code, waits for scan, saves credentials, then exits.
 *
 * Usage: npx tsx src/whatsapp-auth.ts
 */
import fs from 'fs';
import https from 'https';
import path from 'path';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import readline from 'readline';
import { HttpsProxyAgent } from 'https-proxy-agent';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

// Create proxy agent from environment if available
const proxyUrl =
  process.env.https_proxy ||
  process.env.HTTPS_PROXY ||
  process.env.http_proxy ||
  process.env.HTTP_PROXY;
const proxyAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

/**
 * Fetch the latest WhatsApp Web client revision from sw.js via the proxy.
 * Baileys' fetchLatestWaWebVersion uses Node's fetch which ignores HTTP_PROXY.
 */
function fetchVersionViaProxy(): Promise<[number, number, number] | undefined> {
  return new Promise((resolve) => {
    const req = https.request(
      'https://web.whatsapp.com/sw.js',
      { agent: proxyAgent },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          const match = data.match(/client_revision[^0-9]*(\d+)/);
          if (match) {
            resolve([2, 3000, parseInt(match[1], 10)]);
          } else {
            resolve(undefined);
          }
        });
      },
    );
    req.on('error', () => resolve(undefined));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(undefined);
    });
    req.end();
  });
}

async function fetchWaVersion(): Promise<[number, number, number] | undefined> {
  if (proxyAgent) {
    return fetchVersionViaProxy();
  }
  const { version } = await fetchLatestWaWebVersion({}).catch(() => ({
    version: undefined,
  }));
  return version;
}

const AUTH_DIR = './store/auth';
const QR_FILE = './store/qr-data.txt';
const STATUS_FILE = './store/auth-status.txt';

const logger = pino({
  level: 'warn', // Quiet logging - only show errors
});

// Check for --pairing-code flag and phone number
const usePairingCode = process.argv.includes('--pairing-code');
const phoneArg = process.argv.find((_, i, arr) => arr[i - 1] === '--phone');

function askQuestion(prompt: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function connectSocket(
  phoneNumber?: string,
  isReconnect = false,
): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  if (state.creds.registered && !isReconnect) {
    fs.writeFileSync(STATUS_FILE, 'already_authenticated');
    console.log('✓ Already authenticated with WhatsApp');
    console.log(
      '  To re-authenticate, delete the store/auth folder and run again.',
    );
    process.exit(0);
  }

  const version = await fetchWaVersion();
  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Chrome'),
    agent: proxyAgent,
    fetchAgent: proxyAgent,
  });

  if (usePairingCode && phoneNumber && !state.creds.me) {
    // Request pairing code after a short delay for connection to initialize
    // Only on first connect (not reconnect after 515)
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber!);
        console.log(`\n🔗 Your pairing code: ${code}\n`);
        console.log('  1. Open WhatsApp on your phone');
        console.log('  2. Tap Settings → Linked Devices → Link a Device');
        console.log('  3. Tap "Link with phone number instead"');
        console.log(`  4. Enter this code: ${code}\n`);
        fs.writeFileSync(STATUS_FILE, `pairing_code:${code}`);
      } catch (err: any) {
        console.error('Failed to request pairing code:', err.message);
        process.exit(1);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Write raw QR data to file so the setup skill can render it
      fs.writeFileSync(QR_FILE, qr);
      console.log('Scan this QR code with WhatsApp:\n');
      console.log('  1. Open WhatsApp on your phone');
      console.log('  2. Tap Settings → Linked Devices → Link a Device');
      console.log('  3. Point your camera at the QR code below\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const reason = (lastDisconnect?.error as any)?.output?.statusCode;

      if (reason === DisconnectReason.loggedOut) {
        fs.writeFileSync(STATUS_FILE, 'failed:logged_out');
        console.log('\n✗ Logged out. Delete store/auth and try again.');
        process.exit(1);
      } else if (reason === DisconnectReason.timedOut) {
        fs.writeFileSync(STATUS_FILE, 'failed:qr_timeout');
        console.log('\n✗ QR code timed out. Please try again.');
        process.exit(1);
      } else if (reason === 515) {
        // 515 = stream error, often happens after pairing succeeds but before
        // registration completes. Reconnect to finish the handshake.
        console.log('\n⟳ Stream error (515) after pairing — reconnecting...');
        connectSocket(phoneNumber, true);
      } else {
        fs.writeFileSync(STATUS_FILE, `failed:${reason || 'unknown'}`);
        console.log('\n✗ Connection failed. Please try again.');
        process.exit(1);
      }
    }

    if (connection === 'open') {
      fs.writeFileSync(STATUS_FILE, 'authenticated');
      // Clean up QR file now that we're connected
      try {
        fs.unlinkSync(QR_FILE);
      } catch {}
      console.log('\n✓ Successfully authenticated with WhatsApp!');
      console.log('  Credentials saved to store/auth/');
      console.log('  You can now start the NanoClaw service.\n');

      // Give it a moment to save credentials, then exit
      setTimeout(() => process.exit(0), 1000);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

async function authenticate(): Promise<void> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  // Clean up any stale QR/status files from previous runs
  try {
    fs.unlinkSync(QR_FILE);
  } catch {}
  try {
    fs.unlinkSync(STATUS_FILE);
  } catch {}

  let phoneNumber = phoneArg;
  if (usePairingCode && !phoneNumber) {
    phoneNumber = await askQuestion(
      'Enter your phone number (with country code, no + or spaces, e.g. 14155551234): ',
    );
  }

  console.log('Starting WhatsApp authentication...\n');

  await connectSocket(phoneNumber);
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  process.exit(1);
});
