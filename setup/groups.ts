/**
 * Step: groups — List groups/chats stored in the DB.
 *
 * With the WhatsApp Cloud API, group discovery is not needed — individual
 * contacts are registered manually. This step now only lists what is in the DB.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
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
  const { list, limit } = parseArgs(args);

  if (list) {
    await listChats(limit);
    return;
  }

  // With Cloud API there is nothing to sync — chats are discovered at runtime
  // when Meta delivers the first webhook from each contact.
  const dbPath = path.join(STORE_DIR, 'messages.db');
  let chatsInDb = 0;
  if (fs.existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db
        .prepare("SELECT COUNT(*) as count FROM chats WHERE jid LIKE '%@s.whatsapp.net'")
        .get() as { count: number };
      chatsInDb = row.count;
      db.close();
    } catch {
      // DB may not exist yet
    }
  }

  emitStatus('SYNC_GROUPS', {
    STATUS: 'success',
    SYNC: 'skipped',
    CHATS_IN_DB: chatsInDb,
    REASON: 'whatsapp_cloud_api_no_sync_needed',
    LOG: 'logs/setup.log',
  });
}

async function listChats(limit: number): Promise<void> {
  const dbPath = path.join(STORE_DIR, 'messages.db');

  if (!fs.existsSync(dbPath)) {
    console.error('ERROR: database not found');
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      `SELECT jid, name FROM chats
       WHERE name <> jid
       ORDER BY last_message_time DESC
       LIMIT ?`,
    )
    .all(limit) as Array<{ jid: string; name: string }>;
  db.close();

  for (const row of rows) {
    console.log(`${row.jid}|${row.name}`);
  }
}
