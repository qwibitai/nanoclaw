/**
 * ステップ: groups — グループ情報の確認。
 * Discord はチャンネル名を実行時に解決するため、事前同期は不要です。
 */
import path from 'path';

import Database from 'better-sqlite3';

import { STORE_DIR } from '../src/config.js';
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
  const { list, limit } = parseArgs(args);

  if (list) {
    await listGroups(limit);
    return;
  }

  logger.info('Discord はグループ名を実行時に解決するため、事前同期をスキップします');
  emitStatus('SYNC_GROUPS', {
    SYNC: 'skipped',
    GROUPS_IN_DB: 0,
    REASON: 'discord_resolves_at_runtime',
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

async function listGroups(limit: number): Promise<void> {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        `SELECT jid, name FROM chats
     WHERE is_group = 1 AND jid <> '__group_sync__' AND name <> jid
     ORDER BY last_message_time DESC
     LIMIT ?`,
      )
      .all(limit) as Array<{ jid: string; name: string }>;
    for (const row of rows) {
      console.log(`${row.jid}|${row.name}`);
    }
  } finally {
    db.close();
  }
}
