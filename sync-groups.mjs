import makeWASocket, { useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers, DisconnectReason } from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

const logger = pino({ level: 'warn' });
const authDir = path.join('store', 'auth');
const dbPath = path.join('store', 'messages.db');

if (!fs.existsSync(authDir)) {
  console.error('NO_AUTH');
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec('CREATE TABLE IF NOT EXISTS chats (jid TEXT PRIMARY KEY, name TEXT, last_message_time TEXT)');

const upsert = db.prepare(
  'INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?) ON CONFLICT(jid) DO UPDATE SET name = excluded.name'
);

let attempts = 0;
const maxAttempts = 3;

async function connect() {
  attempts++;
  console.error(`Connection attempt ${attempts}/${maxAttempts}...`);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    printQRInTerminal: false,
    logger,
    browser: Browsers.macOS('Chrome'),
  });

  const timeout = setTimeout(() => {
    console.error('TIMEOUT');
    process.exit(1);
  }, 30000);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'open') {
      try {
        const groups = await sock.groupFetchAllParticipating();
        const now = new Date().toISOString();
        let count = 0;
        for (const [jid, metadata] of Object.entries(groups)) {
          if (metadata.subject) {
            upsert.run(jid, metadata.subject, now);
            console.log(`${jid}|${metadata.subject}`);
            count++;
          }
        }
        console.error(`SYNCED:${count}`);
      } catch (err) {
        console.error('FETCH_ERROR:' + err.message);
      } finally {
        clearTimeout(timeout);
        sock.end(undefined);
        db.close();
        process.exit(0);
      }
    } else if (connection === 'close') {
      clearTimeout(timeout);
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.error(`Connection closed with status: ${statusCode}`);

      if (statusCode === DisconnectReason.loggedOut) {
        console.error('LOGGED_OUT - need to re-authenticate');
        process.exit(1);
      }

      if (attempts < maxAttempts) {
        console.error('Retrying in 3 seconds...');
        sock.end(undefined);
        setTimeout(connect, 3000);
      } else {
        console.error('Max attempts reached');
        process.exit(1);
      }
    }
  });
}

connect();
