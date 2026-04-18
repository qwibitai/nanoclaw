/**
 * iMessage/SMS channel for NanoClaw.
 *
 * Receiving: polls ~/Library/Messages/chat.db every 2 seconds using a ROWID
 *            high-water mark persisted in router_state so restarts don't replay.
 * Sending:   delegates to AppleScript via osascript (Messages.app must be running).
 *
 * Prerequisites:
 *   - macOS only
 *   - Full Disk Access granted to the process
 *   - Messages.app configured with the sending account
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

import { getRouterState, setRouterState } from '../db.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { openChatDb, getNewMessages, ChatMessage } from './imessage-db.js';
import { ChannelOpts, registerChannel } from './registry.js';

import type { Database as Db } from 'better-sqlite3';

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 2000;
const ROWID_KEY = 'imessage_last_rowid';

/** Escape text for embedding inside AppleScript double-quoted strings. */
function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Build the AppleScript to send a message to a 1:1 or group chat. */
function buildSendScript(recipient: string, text: string): string {
  const escaped = escapeAppleScript(text);

  if (recipient.startsWith('chat')) {
    // Group chat — address by chat id
    return `tell application "Messages"
  set targetChat to chat id "${escapeAppleScript(recipient)}"
  send "${escaped}" to targetChat
end tell`;
  }

  // 1:1 — address by buddy handle
  return `tell application "Messages"
  set targetService to 1st service whose service type = iMessage
  set targetBuddy to buddy "${escapeAppleScript(recipient)}" of targetService
  send "${escaped}" to targetBuddy
end tell`;
}

export class IMessageChannel implements Channel {
  name = 'imessage';

  private db: Db | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastRowId = 0;
  private connected = false;
  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const db = openChatDb();
    if (!db) {
      // Graceful degradation: log already emitted in openChatDb
      return;
    }
    this.db = db;

    // Restore high-water mark from DB so we don't replay old messages on restart
    const savedRowId = getRouterState(ROWID_KEY);
    if (savedRowId) {
      this.lastRowId = parseInt(savedRowId, 10) || 0;
    } else {
      // Bootstrap: find the current max ROWID and start from there (don't replay history)
      try {
        const row = db
          .prepare('SELECT MAX(ROWID) AS max_id FROM message')
          .get() as { max_id: number | null } | undefined;
        this.lastRowId = row?.max_id ?? 0;
        setRouterState(ROWID_KEY, String(this.lastRowId));
      } catch {
        this.lastRowId = 0;
      }
    }

    this.connected = true;
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);

    logger.info({ lastRowId: this.lastRowId }, 'iMessage channel connected');
    console.log('\n  iMessage channel: polling chat.db every 2 s\n');
  }

  private poll(): void {
    if (!this.db) return;

    let messages: ChatMessage[];
    try {
      messages = getNewMessages(this.db, this.lastRowId);
    } catch (err) {
      logger.error({ err }, 'iMessage poll error');
      return;
    }

    for (const msg of messages) {
      this.lastRowId = Math.max(this.lastRowId, msg.ROWID);

      // Determine JID
      const chatJid = `im:${msg.chat_identifier}`;
      const timestamp = new Date(msg.unix_ts * 1000).toISOString();
      const senderId = msg.sender_id ?? 'me';
      const senderName = msg.is_from_me ? 'Me' : (msg.sender_id ?? 'Unknown');
      const isGroup = msg.chat_identifier.startsWith('chat');

      // Notify metadata discovery
      const chatName = msg.display_name || msg.chat_identifier;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'imessage',
        isGroup,
      );

      // Skip messages from bot itself — mark but still deliver so orchestrator can see them
      const isBotMessage = msg.is_from_me === 1;

      // Null or empty text → attachment placeholder
      const text = msg.text?.trim() || null;
      if (text === null) {
        // No text (attachment-only) — emit placeholder only to registered groups
        const group = this.opts.registeredGroups()[chatJid];
        if (!group) continue;
        this.opts.onMessage(chatJid, {
          id: String(msg.ROWID),
          chat_jid: chatJid,
          sender: senderId,
          sender_name: senderName,
          content: '[Attachment]',
          timestamp,
          is_from_me: isBotMessage,
          is_bot_message: isBotMessage,
        });
        continue;
      }

      // Only deliver to registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid, chatName }, 'iMessage from unregistered chat');
        continue;
      }

      this.opts.onMessage(chatJid, {
        id: String(msg.ROWID),
        chat_jid: chatJid,
        sender: senderId,
        sender_name: senderName,
        content: text,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
      });

      logger.info(
        { chatJid, rowId: msg.ROWID, fromMe: isBotMessage },
        'iMessage stored',
      );
    }

    // Persist high-water mark after processing the batch
    if (messages.length > 0) {
      setRouterState(ROWID_KEY, String(this.lastRowId));
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Strip the "im:" prefix to get the raw identifier / phone / email
    const recipient = jid.replace(/^im:/, '');
    const script = buildSendScript(recipient, text);

    try {
      await execFileAsync('osascript', ['-e', script]);
      logger.info({ jid, length: text.length }, 'iMessage sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send iMessage via AppleScript');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('im:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.connected = false;
    logger.info('iMessage channel disconnected');
  }
}

registerChannel('imessage', (opts: ChannelOpts) => {
  // Only activate on macOS
  if (process.platform !== 'darwin') {
    logger.debug('iMessage channel: skipped (not macOS)');
    return null;
  }
  return new IMessageChannel(opts);
});
