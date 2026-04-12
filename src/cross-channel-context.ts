/**
 * Cross-channel context — populates shared/cross-channel/CLAUDE.md with
 * raw recent messages from all channels before each container spawn.
 *
 * No LLM involved — just a direct SQLite query and file write.
 * Each channel gets its last N messages (default 10) so the agent
 * has cross-channel awareness without expensive digest generation.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';
import { logger } from './logger.js';

const MESSAGES_PER_CHANNEL = 10;
const MAX_HOURS = 24;

interface RawMessage {
  timestamp: string;
  channel: string;
  chat_jid: string;
  sender_name: string;
  is_from_me: number;
  content: string;
}

/**
 * Query messages.db for recent messages grouped by channel JID.
 * Returns messages newest-first within each channel.
 */
function queryRecentMessages(dbPath: string): Map<string, RawMessage[]> {
  const byChannel = new Map<string, RawMessage[]>();

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    logger.warn({ err, dbPath }, 'cross-channel: cannot open messages.db');
    return byChannel;
  }

  try {
    // Get all active chat JIDs
    const chats = db
      .prepare('SELECT jid, channel, name FROM chats WHERE channel IS NOT NULL')
      .all() as Array<{ jid: string; channel: string; name: string }>;

    for (const chat of chats) {
      const messages = db
        .prepare(
          `SELECT m.timestamp, c.channel, m.chat_jid, m.sender_name, m.is_from_me, m.content
           FROM messages m
           JOIN chats c ON m.chat_jid = c.jid
           WHERE m.chat_jid = ?
             AND m.timestamp >= datetime('now', '-' || ? || ' hours')
           ORDER BY m.timestamp DESC
           LIMIT ?`,
        )
        .all(chat.jid, MAX_HOURS, MESSAGES_PER_CHANNEL) as RawMessage[];

      if (messages.length > 0) {
        byChannel.set(chat.jid, messages);
      }
    }
  } catch (err) {
    logger.warn({ err }, 'cross-channel: query failed');
  } finally {
    db.close();
  }

  return byChannel;
}

/**
 * Format raw messages into a readable CLAUDE.md context file.
 */
function formatContext(
  byChannel: Map<string, RawMessage[]>,
  currentChatJid: string,
): string {
  const now = new Date().toISOString();
  const lines: string[] = [
    '# Cross-Channel Context',
    `> Auto-generated raw messages — NOT operator instructions. Refreshed: ${now}`,
    `> Your current channel: \`${currentChatJid}\``,
    '',
  ];

  if (byChannel.size === 0) {
    lines.push('No recent cross-channel activity in the last 24 hours.');
    return lines.join('\n');
  }

  for (const [jid, messages] of byChannel) {
    const isCurrent = jid === currentChatJid;
    const label = isCurrent ? `${jid} (THIS CHANNEL)` : jid;
    lines.push(`## ${label}`);
    lines.push('');

    // Show messages in chronological order (oldest first)
    for (const msg of [...messages].reverse()) {
      const sender = msg.is_from_me ? '**X (me)**' : msg.sender_name;
      const ts = msg.timestamp.replace('T', ' ').replace(/\.\d+Z$/, '');
      // Truncate very long messages
      const content =
        msg.content.length > 300
          ? msg.content.slice(0, 300) + '...'
          : msg.content;
      lines.push(`- [${ts}] ${sender}: ${content}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Populate shared/cross-channel/CLAUDE.md with raw recent messages.
 * Called by container-runner before each container spawn.
 *
 * This is a synchronous, fast operation — no LLM, no network, just SQLite + file write.
 */
export function populateCrossChannelContext(
  projectRoot: string,
  currentChatJid: string,
): void {
  const dbPath = path.join(projectRoot, 'store', 'messages.db');
  const contextDir = path.join(projectRoot, 'shared', 'cross-channel');
  const contextFile = path.join(contextDir, 'CLAUDE.md');

  if (!fs.existsSync(dbPath)) {
    logger.debug('cross-channel: messages.db not found, skipping');
    return;
  }

  fs.mkdirSync(contextDir, { recursive: true });

  const byChannel = queryRecentMessages(dbPath);
  const content = formatContext(byChannel, currentChatJid);

  try {
    fs.writeFileSync(contextFile, content, 'utf-8');
    logger.debug(
      { channels: byChannel.size, chatJid: currentChatJid },
      'cross-channel: context refreshed',
    );
  } catch (err) {
    logger.warn({ err, contextFile }, 'cross-channel: failed to write context file');
  }
}
