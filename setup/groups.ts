/**
 * Step: groups — Connect to WhatsApp, fetch group metadata, write to DB.
 * Replaces 05-sync-groups.sh + 05b-list-groups.sh
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): { list: boolean; limit: number } {
  let list = false;
  let limit = 30;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--list') list = true;
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    }
  }
  return { list, limit };
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { list, limit } = parseArgs(args);

  if (list) {
    await listGroups(limit);
    return;
  }

  await syncGroups(projectRoot);
}

async function listGroups(limit: number): Promise<void> {
  const { initDatabase, getAllChats, closeDatabase } = await import(
    '../src/db/index.js'
  );
  await initDatabase();
  try {
    const chats = await getAllChats();
    const groups = chats
      .filter(
        (c) =>
          c.jid.endsWith('@g.us') &&
          c.jid !== '__group_sync__' &&
          c.name !== c.jid,
      )
      .sort(
        (a, b) =>
          new Date(b.last_message_time).getTime() -
          new Date(a.last_message_time).getTime(),
      )
      .slice(0, limit);
    for (const g of groups) {
      console.log(`${g.jid}|${g.name}`);
    }
  } finally {
    await closeDatabase();
  }
}

async function syncGroups(projectRoot: string): Promise<void> {
  // Build TypeScript first
  logger.info('Building TypeScript');
  let buildOk = false;
  try {
    execSync('npm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    buildOk = true;
    logger.info('Build succeeded');
  } catch {
    logger.error('Build failed');
    emitStatus('SYNC_GROUPS', {
      BUILD: 'failed',
      SYNC: 'skipped',
      GROUPS_IN_DB: 0,
      STATUS: 'failed',
      ERROR: 'build_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // Run inline sync script — fetches WhatsApp groups and outputs JSON to stdout.
  // DB writes happen in the parent process via the adapter layer.
  logger.info('Fetching group metadata');
  let syncOk = false;
  const syncedGroups: Array<{ jid: string; name: string }> = [];
  try {
    const syncScript = `
import makeWASocket, { useMultiFileAuthState, makeCacheableSignalKeyStore, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import path from 'path';
import fs from 'fs';

const logger = pino({ level: 'silent' });
const authDir = path.join('store', 'auth');

if (!fs.existsSync(authDir)) {
  console.error('NO_AUTH');
  process.exit(1);
}

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
  if (update.connection === 'open') {
    try {
      const groups = await sock.groupFetchAllParticipating();
      const results = [];
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          results.push({ jid, name: metadata.subject });
        }
      }
      console.log(JSON.stringify(results));
    } catch (err) {
      console.error('FETCH_ERROR:' + err.message);
    } finally {
      clearTimeout(timeout);
      sock.end(undefined);
      process.exit(0);
    }
  } else if (update.connection === 'close') {
    clearTimeout(timeout);
    console.error('CONNECTION_CLOSED');
    process.exit(1);
  }
});
`;

    const output = execSync(
      `node --input-type=module -e ${JSON.stringify(syncScript)}`,
      {
        cwd: projectRoot,
        encoding: 'utf-8',
        timeout: 45000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const trimmed = output.trim();
    if (trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed) as Array<{
        jid: string;
        name: string;
      }>;
      syncedGroups.push(...parsed);
      syncOk = true;
    }
    logger.info({ groupCount: syncedGroups.length }, 'Sync output');
  } catch (err) {
    logger.error({ err }, 'Sync failed');
  }

  const { initDatabase, storeChatMetadata, getAllChats, closeDatabase } =
    await import('../src/db/index.js');
  await initDatabase();
  let groupsInDb = 0;
  try {
    if (syncOk) {
      const now = new Date().toISOString();
      for (const g of syncedGroups) {
        await storeChatMetadata(g.jid, now, g.name);
      }
      logger.info({ count: syncedGroups.length }, 'Wrote groups to database');
    }

    const chats = await getAllChats();
    groupsInDb = chats.filter(
      (c) => c.jid.endsWith('@g.us') && c.jid !== '__group_sync__',
    ).length;
  } finally {
    await closeDatabase();
  }

  const status = syncOk ? 'success' : 'failed';

  emitStatus('SYNC_GROUPS', {
    BUILD: buildOk ? 'success' : 'failed',
    SYNC: syncOk ? 'success' : 'failed',
    GROUPS_IN_DB: groupsInDb,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
