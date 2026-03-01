import makeWASocket, { useMultiFileAuthState, Browsers, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import pino from 'pino';

const logger = pino({ level: 'warn' });

async function main() {
  const { state, saveCreds } = await useMultiFileAuthState('./store/auth');

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Chrome'),
    shouldSyncHistoryMessage: () => false,
    fireInitQueries: true,
    markOnlineOnConnect: true,
  });

  sock.ev.on('creds.update', saveCreds);

  let pairingRequested = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr } = update;
    if (connection) console.log('CONNECTION:', connection);

    if (qr && !pairingRequested) {
      pairingRequested = true;
      try {
        const code = await sock.requestPairingCode('12513884324');
        console.log('PAIRING_CODE:', code);
      } catch (err) {
        console.error('Pairing error:', err);
      }
    }

    if (connection === 'open') {
      console.log('FULLY_CONNECTED - waiting for messages...');
    }

    if (connection === 'close') {
      console.log('CONNECTION_CLOSED');
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      const content = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '[non-text]';
      const sender = msg.pushName || msg.key.participant || 'unknown';
      console.log('MSG [' + type + ']: sender=' + sender + ' jid=' + jid + ' content="' + content + '"');
    }
  });

  sock.ev.on('messaging-history.set', ({ messages, isLatest }) => {
    console.log('HISTORY:', messages.length, 'messages, isLatest=' + isLatest);
  });

  console.log('Debug started - waiting for pairing...');
  setTimeout(() => { console.log('180s timeout'); process.exit(0); }, 180000);
}

main();
