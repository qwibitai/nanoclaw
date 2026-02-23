import fs from 'fs';
import path from 'path';

import { App, Assistant, LogLevel } from '@slack/bolt';

import { SLACK_APP_TOKEN, SLACK_BOT_TOKEN } from '../config.js';
import { logger } from '../logger.js';
import { Channel, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

export interface SlackChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SlackChannel implements Channel {
  name = 'slack';
  private app: App;
  private connected = false;
  private botUserId = '';
  private opts: SlackChannelOpts;

  // Track the active thread_ts per DM channel so replies go to the Chat tab
  private activeThreads = new Map<string, string>(); // jid -> thread_ts

  constructor(opts: SlackChannelOpts) {
    this.opts = opts;
    this.app = new App({
      token: SLACK_BOT_TOKEN,
      appToken: SLACK_APP_TOKEN,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });
  }

  async connect(): Promise<void> {
    const auth = await this.app.client.auth.test();
    this.botUserId = (auth.user_id as string) || '';
    logger.info({ botUserId: this.botUserId }, 'Slack bot identity');

    // Handle Chat tab DM messages via the Assistants API so replies
    // appear in the Chat tab thread instead of the History tab.
    const assistant = new Assistant({
      threadStarted: async ({ saveThreadContext }) => {
        await saveThreadContext();
      },
      userMessage: async ({ message, setStatus }) => {
        const msg = message as {
          channel: string;
          user?: string;
          text?: string;
          ts: string;
          thread_ts?: string;
          bot_id?: string;
        };

        const chatJid = `slack:${msg.channel}`;
        const threadTs = msg.thread_ts || msg.ts;
        const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();

        // Track thread so sendMessage can reply in the right place
        this.activeThreads.set(chatJid, threadTs);

        this.opts.onChatMetadata(chatJid, timestamp, undefined, 'slack', false);

        const groups = this.opts.registeredGroups();
        if (!groups[chatJid]) return;

        const content = msg.text || '';
        if (!content) return;

        await setStatus('thinking...');

        const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;
        const sender = msg.user || 'unknown';

        let senderName = sender;
        if (msg.user && msg.user !== this.botUserId) {
          try {
            const info = await this.app.client.users.info({ user: msg.user });
            const profile = (info.user as { profile?: { display_name?: string; real_name?: string } })?.profile;
            senderName = profile?.display_name || profile?.real_name || sender;
          } catch {
            // ignore — name resolution is best-effort
          }
        }

        this.opts.onMessage(chatJid, {
          id: msg.ts,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: isBotMessage,
          is_bot_message: isBotMessage,
        });
      },
    });

    this.app.assistant(assistant);

    // Also handle regular channel messages (non-DM, no Assistant API)
    this.app.message(async ({ message }) => {
      if ('subtype' in message && message.subtype) return;

      const msg = message as {
        channel: string;
        user?: string;
        text?: string;
        ts: string;
        channel_type?: string;
        bot_id?: string;
        thread_ts?: string;
      };

      // Skip DM channels — handled by the Assistant above
      if (msg.channel_type === 'im') return;

      const chatJid = `slack:${msg.channel}`;
      const timestamp = new Date(parseFloat(msg.ts) * 1000).toISOString();
      const isGroup = msg.channel_type === 'channel' || msg.channel_type === 'group';

      this.opts.onChatMetadata(chatJid, timestamp, undefined, 'slack', isGroup);

      const groups = this.opts.registeredGroups();
      if (!groups[chatJid]) return;

      const content = msg.text || '';
      if (!content) return;

      const isBotMessage = !!msg.bot_id || msg.user === this.botUserId;
      const sender = msg.user || msg.bot_id || 'unknown';

      let senderName = sender;
      if (msg.user && msg.user !== this.botUserId) {
        try {
          const info = await this.app.client.users.info({ user: msg.user });
          const profile = (info.user as { profile?: { display_name?: string; real_name?: string } })?.profile;
          senderName = profile?.display_name || profile?.real_name || sender;
        } catch {
          // ignore
        }
      }

      this.opts.onMessage(chatJid, {
        id: msg.ts,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isBotMessage,
        is_bot_message: isBotMessage,
      });
    });

    await this.app.start();
    this.connected = true;
    logger.info('Connected to Slack');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const threadTs = this.activeThreads.get(jid);
    try {
      await this.app.client.chat.postMessage({
        channel: channelId,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      logger.info({ jid, length: text.length, threadTs }, 'Slack message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Slack message');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('slack:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.app.stop();
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Slack doesn't support typing indicators via API; no-op
  }

  async sendFile(jid: string, filePath: string, comment?: string): Promise<void> {
    const channelId = jid.replace(/^slack:/, '');
    const threadTs = this.activeThreads.get(jid);
    const filename = path.basename(filePath);
    const fileContent = fs.readFileSync(filePath);

    try {
      // Step 1: Get upload URL
      const { upload_url, file_id } = await this.app.client.files.getUploadURLExternal({
        filename,
        length: fileContent.length,
      }) as { upload_url: string; file_id: string };

      // Step 2: Upload file content
      await fetch(upload_url, {
        method: 'POST',
        body: fileContent,
        headers: { 'Content-Type': 'application/octet-stream' },
      });

      // Step 3: Complete upload and post to channel
      await this.app.client.files.completeUploadExternal({
        files: [{ id: file_id, title: filename }],
        channel_id: channelId,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        ...(comment ? { initial_comment: comment } : {}),
      });

      logger.info({ jid, filename, threadTs }, 'Slack file sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Slack file');
      throw err;
    }
  }
}
