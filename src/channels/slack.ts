import fs from 'fs';
import path from 'path';

import { App, LogLevel } from '@slack/bolt';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/**
 * Convert standard markdown to Slack mrkdwn format.
 */
export function toSlackMarkdown(text: string): string {
  return (
    text
      // Links: [label](url) → <url|label>
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>')
      // Bold: **text** → *text*
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      // Strikethrough: ~~text~~ → ~text~
      .replace(/~~(.+?)~~/g, '~$1~')
      // Headers: ### Heading → *Heading* (bold)
      .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
      // Unordered lists: * item → • item (only at line start)
      .replace(/^\* /gm, '• ')
  );
}

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';

  private app: App | null = null;
  private opts: SlackChannelOpts;
  private botToken: string;
  private appToken: string;
  private allowedUserId: string | null;
  private _isConnected = false;
  private pendingPlaceholders = new Map<string, string>();

  /**
   * Download a file from Slack using the Web API client.
   *
   * Raw fetch against url_private_download returns HTML login pages due to
   * cross-origin redirects stripping the Authorization header. Instead, we
   * call files.info to get the url_private URL and use the Slack WebClient's
   * authenticated HTTP to fetch the actual binary.
   * See: https://github.com/slackapi/bolt-js/issues/2585
   */
  private async downloadImages(
    files: { id: string; name?: string | null; mimetype?: string }[],
    groupFolder: string,
  ): Promise<string[]> {
    const prefixes: string[] = [];
    if (!this.app) return prefixes;

    for (const file of files) {
      if (!file.mimetype?.startsWith('image/')) continue;
      try {
        // Get fresh file info with authenticated URL
        const info = await this.app.client.files.info({ file: file.id });
        const url = info.file?.url_private;
        if (!url) throw new Error('No url_private in files.info response');

        const ext = file.name?.split('.').pop() || 'jpg';
        const mediaDir = path.join(GROUPS_DIR, groupFolder, 'media');
        fs.mkdirSync(mediaDir, { recursive: true });
        const filename = `${file.id}.${ext}`;

        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${this.botToken}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());

        // Sanity-check: HTML error pages start with '<'
        if (buf.length > 0 && buf[0] === 0x3c) {
          throw new Error('Response is HTML, not an image (auth/redirect issue)');
        }

        fs.writeFileSync(path.join(mediaDir, filename), buf);
        prefixes.push(`[Photo: /workspace/group/media/${filename}]`);
        logger.info({ fileId: file.id, filename }, 'Slack image downloaded');
      } catch (err) {
        prefixes.push('[Photo]');
        logger.warn({ fileId: file.id, err }, 'Failed to download Slack image');
      }
    }
    return prefixes;
  }

  constructor(
    botToken: string,
    appToken: string,
    opts: SlackChannelOpts,
    allowedUserId?: string,
  ) {
    this.botToken = botToken;
    this.appToken = appToken;
    this.opts = opts;
    this.allowedUserId = allowedUserId || null;
  }

  async connect(): Promise<void> {
    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    // Handle all messages (DMs filtered by allowed user)
    this.app.message(async ({ message }) => {
      // Skip bot messages, edits, deletions, etc. (allow file_share)
      if (message.subtype && message.subtype !== 'file_share') return;
      if (!('user' in message) || !message.user) return;

      const hasText = 'text' in message && !!message.text;
      const hasFiles = 'files' in message && Array.isArray((message as any).files) && (message as any).files.length > 0;
      if (!hasText && !hasFiles) return;

      const isDM = (message as any).channel_type === 'im';

      // DMs: only accept from allowed user
      if (isDM) {
        if (this.allowedUserId && message.user !== this.allowedUserId) {
          logger.debug(
            { user: message.user },
            'Ignoring Slack DM from non-allowed user',
          );
          return;
        }
      }

      const chatJid = `slack:${message.channel}`;
      const timestamp = new Date(parseFloat(message.ts) * 1000).toISOString();

      let content = ('text' in message && message.text) || '';

      // DMs always trigger — prepend assistant name if not present
      if (isDM && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      // Store chat metadata
      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'slack', !isDM);

      // Only deliver to registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid }, 'Message from unregistered Slack chat');
        return;
      }

      // Download images if present
      const files: any[] = ('files' in message ? (message as any).files : []) || [];
      const imagePrefixes = await this.downloadImages(files, group.folder);
      if (imagePrefixes.length > 0) {
        content = `${imagePrefixes.join(' ')}${content ? ` ${content}` : ''}`;
      }

      this.opts.onMessage(chatJid, {
        id: message.ts,
        chat_jid: chatJid,
        sender: message.user,
        sender_name: message.user,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, sender: message.user },
        'Slack message stored',
      );
    });

    // Handle @mentions in channels
    this.app.event('app_mention', async ({ event }) => {
      const chatJid = `slack:${event.channel}`;
      const timestamp = new Date(parseFloat(event.ts) * 1000).toISOString();

      let content = event.text || '';

      // Prepend trigger if not already present
      if (!TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }

      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'slack', true);

      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug({ chatJid }, 'Mention from unregistered Slack channel');
        return;
      }

      // Download images if present
      const files: any[] = (event as any).files || [];
      const imagePrefixes = await this.downloadImages(files, group.folder);
      if (imagePrefixes.length > 0) {
        content = `${imagePrefixes.join(' ')}${content ? ` ${content}` : ''}`;
      }

      this.opts.onMessage(chatJid, {
        id: event.ts,
        chat_jid: chatJid,
        sender: event.user || '',
        sender_name: event.user || 'Unknown',
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, sender: event.user },
        'Slack mention stored',
      );
    });

    await this.app.start();
    this._isConnected = true;

    logger.info('Slack bot connected via Socket Mode');
    console.log('\n  Slack bot: connected (Socket Mode)');
    console.log(
      '  Send a DM to the bot, then register with the logged JID\n',
    );
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.app) return;

    const channelId = jid.replace(/^slack:/, '');

    if (isTyping) {
      try {
        const result = await this.app.client.chat.postMessage({
          channel: channelId,
          text: '_Thinking..._',
        });
        if (result.ts) {
          this.pendingPlaceholders.set(jid, result.ts);
        }
      } catch (err) {
        logger.error({ jid, err }, 'Failed to post Slack thinking placeholder');
      }
    } else {
      const ts = this.pendingPlaceholders.get(jid);
      if (ts) {
        this.pendingPlaceholders.delete(jid);
        try {
          await this.app.client.chat.delete({ channel: channelId, ts });
        } catch (err) {
          logger.error({ jid, err }, 'Failed to delete Slack thinking placeholder');
        }
      }
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.app) {
      logger.warn('Slack app not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^slack:/, '');
      const placeholderTs = this.pendingPlaceholders.get(jid);
      text = toSlackMarkdown(text);

      // Slack has a ~3000 char practical limit for readable messages
      const MAX_LENGTH = 3000;

      if (placeholderTs) {
        // Replace the "Thinking..." placeholder with the first chunk
        this.pendingPlaceholders.delete(jid);
        const firstChunk = text.slice(0, MAX_LENGTH);
        await this.app.client.chat.update({
          channel: channelId,
          ts: placeholderTs,
          text: firstChunk,
        });
        // Send remaining chunks as new messages
        for (let i = MAX_LENGTH; i < text.length; i += MAX_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_LENGTH),
          });
        }
      } else if (text.length <= MAX_LENGTH) {
        await this.app.client.chat.postMessage({
          channel: channelId,
          text,
        });
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await this.app.client.chat.postMessage({
            channel: channelId,
            text: text.slice(i, i + MAX_LENGTH),
          });
        }
      }
      logger.info({ jid, length: text.length }, 'Slack message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Slack message');
    }
  }

  isConnected(): boolean {
    return this._isConnected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
      this._isConnected = false;
      logger.info('Slack bot stopped');
    }
  }
}
