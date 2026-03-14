import { execFile } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';

import {
  WN_BINARY_PATH,
  WN_SOCKET_PATH,
  WN_ACCOUNT_PUBKEY,
} from '../config.js';
// Health monitoring removed for upstream compatibility
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const execFileAsync = promisify(execFile);

export interface WhiteNoiseChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/** Convert a byte array (from serde JSON) to hex string */
function bytesToHex(arr: number[]): string {
  return arr.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function jidFromGroupId(groupIdHex: string): string {
  return `whitenoise:${groupIdHex}`;
}

/** Extract hex group ID from various serde formats */
function extractGroupIdHex(gid: unknown): string | null {
  if (typeof gid === 'string') return gid;
  if (Array.isArray(gid)) return bytesToHex(gid as number[]);
  if (
    gid &&
    typeof gid === 'object' &&
    'value' in gid &&
    (gid as { value: { vec: number[] } }).value?.vec
  ) {
    return bytesToHex((gid as { value: { vec: number[] } }).value.vec);
  }
  return null;
}

const POLL_INTERVAL = 3000; // 3 seconds

export class WhiteNoiseChannel implements Channel {
  name = 'whitenoise';

  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSeenMessageIds: Map<string, string> = new Map();
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private consecutiveErrors = 0;

  private opts: WhiteNoiseChannelOpts;

  constructor(opts: WhiteNoiseChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (!WN_ACCOUNT_PUBKEY) {
      throw new Error('WN_ACCOUNT_PUBKEY not configured');
    }
    if (!fs.existsSync(WN_BINARY_PATH)) {
      throw new Error(`wn binary not found at ${WN_BINARY_PATH}`);
    }
    if (!fs.existsSync(WN_SOCKET_PATH)) {
      throw new Error(`wnd socket not found at ${WN_SOCKET_PATH}`);
    }

    // Verify we can talk to wnd
    try {
      await this.runWn(['accounts', 'list']);
    } catch (err) {
      throw new Error(`Cannot connect to wnd: ${err}`);
    }

    this.connected = true;
    this.consecutiveErrors = 0;
    logger.info('White Noise connection restored');
    logger.info('White Noise channel connected (polling mode)');

    this.flushOutgoingQueue().catch((err) =>
      logger.error({ err }, 'Failed to flush WN outgoing queue'),
    );

    // Start polling registered WN groups for new messages
    this.pollTimer = setInterval(() => {
      this.pollAllGroups().catch((err) =>
        logger.error({ err }, 'WN poll error'),
      );
    }, POLL_INTERVAL);
  }

  private async runWn(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(WN_BINARY_PATH, [
      '--json',
      '--socket',
      WN_SOCKET_PATH,
      '--account',
      WN_ACCOUNT_PUBKEY,
      ...args,
    ]);
    return stdout;
  }

  private async pollAllGroups(): Promise<void> {
    const groups = this.opts.registeredGroups();
    const wnGroups = Object.entries(groups).filter(([jid]) =>
      jid.startsWith('whitenoise:'),
    );

    if (wnGroups.length === 0) return;

    for (const [jid, group] of wnGroups) {
      try {
        await this.pollGroup(jid, group);
        this.consecutiveErrors = 0;
        logger.info('White Noise connection restored');
      } catch (err) {
        this.consecutiveErrors++;
        if (this.consecutiveErrors >= 3) {
          logger.warn("White Noise consecutive errors detected");
        }
        logger.warn({ err, jid }, 'WN poll failed for group');
      }
    }
  }

  private async pollGroup(jid: string, group: RegisteredGroup): Promise<void> {
    const groupId = jid.slice('whitenoise:'.length);

    const stdout = await this.runWn(['messages', 'list', groupId]);
    let parsed: { result?: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return;
    }

    const messages = parsed.result;
    if (!messages || !Array.isArray(messages) || messages.length === 0) return;

    const lastSeenId = this.lastSeenMessageIds.get(jid);

    // On first poll, just record the latest message ID without processing
    if (!lastSeenId) {
      const latest = messages[messages.length - 1];
      if (latest?.id) {
        this.lastSeenMessageIds.set(jid, latest.id as string);
      }
      logger.info(
        { jid, messageCount: messages.length },
        'WN: initial poll, recording last message ID',
      );
      return;
    }

    // Find messages after the last seen ID
    const lastSeenIdx = messages.findIndex((m) => m.id === lastSeenId);
    const newMessages = lastSeenIdx >= 0 ? messages.slice(lastSeenIdx + 1) : [];

    if (newMessages.length === 0) return;

    // Update last seen
    const newest = newMessages[newMessages.length - 1];
    if (newest?.id) {
      this.lastSeenMessageIds.set(jid, newest.id as string);
    }

    for (const msg of newMessages) {
      const authorPubkey = msg.author as string;
      const content = (msg.content as string) || '';
      const displayName =
        (msg.display_name as string) || authorPubkey?.slice(0, 12);
      const createdAt = msg.created_at as number;
      const msgId = msg.id as string;

      const isFromMe = authorPubkey === WN_ACCOUNT_PUBKEY;

      const timestamp = createdAt
        ? new Date(createdAt * 1000).toISOString()
        : new Date().toISOString();

      // Update chat metadata
      this.opts.onChatMetadata(
        jid,
        timestamp,
        group.name || displayName,
        'whitenoise',
        true,
      );

      if (isFromMe) continue;

      // Download media attachments and append image paths to content
      const mediaAttachments = msg.media_attachments as
        | Array<Record<string, unknown>>
        | undefined;
      let fullContent = content;
      if (mediaAttachments && mediaAttachments.length > 0) {
        for (const attachment of mediaAttachments) {
          const mimeType = (attachment.mime_type as string) || '';
          if (!mimeType.startsWith('image/')) continue;

          const originalHashArr = attachment.original_file_hash as
            | number[]
            | undefined;
          if (!originalHashArr) continue;

          const fileHash = originalHashArr
            .map((b: number) => b.toString(16).padStart(2, '0'))
            .join('');
          const groupId = jid.slice('whitenoise:'.length);

          try {
            const downloadResult = await this.runWn([
              'media',
              'download',
              groupId,
              fileHash,
            ]);
            const parsed = JSON.parse(downloadResult);
            const filePath = parsed?.result?.file_path as string;
            if (filePath) {
              // Map host path to container path: media_cache/ is under /run/whitenoise/
              const filename = filePath.split('/').pop();
              fullContent += `\n[Image: /run/whitenoise/media_cache/${filename}]`;
              logger.info(
                { jid, fileHash, filePath },
                'WN: downloaded media attachment',
              );
            }
          } catch (err) {
            logger.warn(
              { err, jid, fileHash },
              'WN: failed to download media attachment',
            );
          }
        }
      }

      if (!fullContent) continue;

      logger.info(
        { jid, sender: displayName, msgId },
        'WN: new message received',
      );

      this.opts.onMessage(jid, {
        id: `wn-${msgId}`,
        chat_jid: jid,
        sender: authorPubkey,
        sender_name: displayName,
        content: fullContent,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      });
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      return;
    }

    const groupId = jid.startsWith('whitenoise:')
      ? jid.slice('whitenoise:'.length)
      : jid;

    try {
      await this.runWn(['messages', 'send', groupId, text]);
      logger.info({ jid, length: text.length }, 'White Noise message sent');
    } catch (err) {
      logger.error({ err, jid }, 'Failed to send WN message');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('whitenoise:');
  }

  async sendReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    if (!this.connected) return;
    const groupId = jid.startsWith('whitenoise:')
      ? jid.slice('whitenoise:'.length)
      : jid;
    // Strip the 'wn-' prefix we add to message IDs
    const rawId = messageId.startsWith('wn-') ? messageId.slice(3) : messageId;
    try {
      await this.runWn(['messages', 'react', groupId, rawId, emoji]);
      logger.info({ jid, emoji, messageId: rawId }, 'WN reaction sent');
    } catch (err) {
      logger.warn({ err, jid, messageId: rawId }, 'Failed to send WN reaction');
    }
  }

  async sendImage(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid, filePath }, 'WN disconnected, cannot send image');
      return;
    }
    const groupId = jid.startsWith('whitenoise:')
      ? jid.slice('whitenoise:'.length)
      : jid;

    try {
      const args = ['media', 'upload', groupId, filePath, '--send'];
      if (caption) {
        args.push('--message', caption);
      }
      await this.runWn(args);
      logger.info(
        { jid, filePath, hasCaption: !!caption },
        'White Noise image sent',
      );
    } catch (err) {
      logger.error({ err, jid, filePath }, 'Failed to send WN image');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      while (this.outgoingQueue.length > 0 && this.connected) {
        const msg = this.outgoingQueue.shift()!;
        await this.sendMessage(msg.jid, msg.text);
      }
    } finally {
      this.flushing = false;
    }
  }
}
