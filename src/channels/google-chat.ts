import fs from 'fs';
import path from 'path';

import { chat_v1, chat } from '@googleapis/chat';
import { GoogleAuth } from 'google-auth-library';

import { DATA_DIR } from '../config.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const SA_KEY_PATH = '/opt/nanoclaw/service-accounts/google-chat-sa.json';
const SCOPES = ['https://www.googleapis.com/auth/chat.bot'];

// Google Chat message limit is 4096 characters
const MAX_MESSAGE_LENGTH = 4096;

// File where trigger-writer persists the mapping from sentinel JID → actual space name.
// Written by trigger-writer.mjs, read by this adapter.
const SPACE_MAP_PATH = path.join(DATA_DIR, 'google-chat-spaces.json');

// File where trigger-writer persists the most recent thread name per JID.
// Written by trigger-writer.mjs on each inbound message. Used to reply in-thread.
const THREAD_MAP_PATH = path.join(DATA_DIR, 'google-chat-threads.json');

export class GoogleChatChannel implements Channel {
  name = 'google-chat';

  private auth!: GoogleAuth;
  private chatClient!: chat_v1.Chat;
  private connected = false;

  async connect(): Promise<void> {
    if (!fs.existsSync(SA_KEY_PATH)) {
      logger.error(
        { path: SA_KEY_PATH },
        'Google Chat service account key not found — channel disabled',
      );
      throw new Error(`Service account key not found: ${SA_KEY_PATH}`);
    }

    this.auth = new GoogleAuth({
      keyFile: SA_KEY_PATH,
      scopes: SCOPES,
    });

    this.chatClient = chat({ version: 'v1', auth: this.auth });
    this.connected = true;

    logger.info('Google Chat channel connected (stateless HTTP API)');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      logger.warn(
        { jid },
        'Google Chat channel not connected, dropping message',
      );
      return;
    }

    // Resolve the actual space name from the JID.
    // If jid starts with 'spaces/', it's already a space name (direct routing).
    // If jid starts with 'gchat:', look up the actual space from the space map file.
    let spaceName: string;
    if (jid.startsWith('spaces/')) {
      spaceName = jid;
    } else if (jid.startsWith('gchat:')) {
      spaceName = this.resolveSpace(jid);
      if (!spaceName) {
        logger.warn(
          { jid },
          'No space mapping found for Google Chat JID — cannot send message. A Google Chat message must be received first.',
        );
        return;
      }
    } else {
      logger.warn({ jid }, 'Unexpected JID format for Google Chat channel');
      return;
    }

    // Resolve thread name for in-thread replies (best-effort — falls back to new message)
    const threadName = this.resolveThread(jid);

    // Split long messages
    const chunks = this.splitMessage(text);

    for (const chunk of chunks) {
      try {
        const requestBody: chat_v1.Schema$Message = { text: chunk };
        if (threadName) {
          requestBody.thread = { name: threadName };
        }
        await this.chatClient.spaces.messages.create({
          parent: spaceName,
          messageReplyOption: threadName
            ? 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD'
            : undefined,
          requestBody,
        });
        logger.info(
          { space: spaceName, length: chunk.length, threaded: !!threadName },
          'Google Chat message sent',
        );
      } catch (err) {
        logger.error(
          { space: spaceName, err },
          'Failed to send Google Chat message',
        );
        // Don't throw — a failed message send shouldn't crash NanoClaw
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('spaces/') || jid.startsWith('gchat:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    logger.info('Google Chat channel disconnected');
  }

  /**
   * Resolve a sentinel JID (gchat:pm-agent) to an actual Google Chat space name.
   * Reads the space map file written by trigger-writer.
   */
  private resolveSpace(jid: string): string {
    try {
      if (!fs.existsSync(SPACE_MAP_PATH)) return '';
      const data = JSON.parse(fs.readFileSync(SPACE_MAP_PATH, 'utf-8'));
      return data[jid] || '';
    } catch (err) {
      logger.error({ err }, 'Failed to read Google Chat space map');
      return '';
    }
  }

  /**
   * Resolve the most recent thread name for a JID, for in-thread replies.
   * Reads the thread map file written by trigger-writer on each inbound message.
   * Returns empty string if not available (reply will create a new message instead).
   */
  private resolveThread(jid: string): string {
    try {
      if (!fs.existsSync(THREAD_MAP_PATH)) return '';
      const data = JSON.parse(fs.readFileSync(THREAD_MAP_PATH, 'utf-8'));
      return data[jid] || '';
    } catch (err) {
      logger.error({ err }, 'Failed to read Google Chat thread map');
      return '';
    }
  }

  /**
   * Split a message into chunks that fit within Google Chat's 4096-char limit.
   * Tries to split on newlines to keep formatting intact.
   */
  private splitMessage(text: string): string[] {
    if (text.length <= MAX_MESSAGE_LENGTH) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }

      // Try to split at a newline within the limit
      let splitIdx = remaining.lastIndexOf('\n', MAX_MESSAGE_LENGTH);
      if (splitIdx <= 0 || splitIdx < MAX_MESSAGE_LENGTH * 0.5) {
        // No good newline break — split at space
        splitIdx = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
      }
      if (splitIdx <= 0) {
        // No good break at all — hard split
        splitIdx = MAX_MESSAGE_LENGTH;
      }

      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx).trimStart();
    }

    return chunks;
  }
}

/**
 * Factory function. Returns null if service account key is missing,
 * signalling NanoClaw to skip this channel gracefully.
 */
function googleChatFactory(_opts: ChannelOpts): GoogleChatChannel | null {
  if (!fs.existsSync(SA_KEY_PATH)) {
    return null;
  }
  return new GoogleChatChannel();
}

registerChannel('google-chat', googleChatFactory);
