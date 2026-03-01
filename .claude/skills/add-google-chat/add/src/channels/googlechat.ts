import fs from 'fs';
import os from 'os';
import path from 'path';

import { google, chat_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import { MAIN_GROUP_FOLDER } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface GoogleChatChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class GoogleChatChannel implements Channel {
  name = 'googlechat';

  private oauth2Client: OAuth2Client | null = null;
  private chat: chat_v1.Chat | null = null;
  private opts: GoogleChatChannelOpts;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPollTime: string | null = null;
  private spaceId: string;
  private consecutiveErrors = 0;

  constructor(opts: GoogleChatChannelOpts, pollIntervalMs = 15000) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;
    const envConfig = readEnvFile(['GOOGLE_CHAT_SPACE_ID']);
    this.spaceId = process.env.GOOGLE_CHAT_SPACE_ID || envConfig.GOOGLE_CHAT_SPACE_ID || '';
  }

  async connect(): Promise<void> {
    const credDir = path.join(os.homedir(), '.google-chat-mcp');
    const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
    const tokensPath = path.join(credDir, 'credentials.json');

    if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
      logger.warn(
        'Google Chat credentials not found in ~/.google-chat-mcp/. Skipping Google Chat channel. Run /add-google-chat to set up.',
      );
      return;
    }

    if (!this.spaceId) {
      logger.warn(
        'GOOGLE_CHAT_SPACE_ID not set. Skipping Google Chat channel. Set it in .env.',
      );
      return;
    }

    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));

    const clientConfig = keys.installed || keys.web || keys;
    const { client_id, client_secret, redirect_uris } = clientConfig;
    this.oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris?.[0],
    );
    this.oauth2Client.setCredentials(tokens);

    // Persist refreshed tokens
    this.oauth2Client.on('tokens', (newTokens) => {
      try {
        const current = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
        Object.assign(current, newTokens);
        fs.writeFileSync(tokensPath, JSON.stringify(current, null, 2));
        logger.debug('Google Chat OAuth tokens refreshed');
      } catch (err) {
        logger.warn({ err }, 'Failed to persist refreshed Google Chat tokens');
      }
    });

    this.chat = google.chat({ version: 'v1', auth: this.oauth2Client });

    logger.info({ spaceId: this.spaceId }, 'Google Chat channel connected');

    // Start polling with error backoff
    const schedulePoll = () => {
      const backoffMs = this.consecutiveErrors > 0
        ? Math.min(this.pollIntervalMs * Math.pow(2, this.consecutiveErrors), 30 * 60 * 1000)
        : this.pollIntervalMs;
      this.pollTimer = setTimeout(() => {
        this.pollForMessages()
          .catch((err) => logger.error({ err }, 'Google Chat poll error'))
          .finally(() => {
            if (this.chat) schedulePoll();
          });
      }, backoffMs);
    };

    // Initial poll
    await this.pollForMessages();
    schedulePoll();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.chat) {
      logger.warn('Google Chat not initialized');
      return;
    }

    const spaceId = jid.replace(/^gchat:/, '');

    try {
      await this.chat.spaces.messages.create({
        parent: `spaces/${spaceId}`,
        requestBody: { text },
      });
      logger.info({ spaceId }, 'Google Chat message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Google Chat message');
    }
  }

  isConnected(): boolean {
    return this.chat !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gchat:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.chat = null;
    this.oauth2Client = null;
    logger.info('Google Chat channel stopped');
  }

  // --- Private ---

  private async pollForMessages(): Promise<void> {
    if (!this.chat) return;

    try {
      const filterParts: string[] = [];
      if (this.lastPollTime) {
        filterParts.push(`createTime > "${this.lastPollTime}"`);
      }
      const filter = filterParts.length > 0 ? filterParts.join(' AND ') : undefined;

      const res = await this.chat.spaces.messages.list({
        parent: `spaces/${this.spaceId}`,
        filter: filter || undefined,
        orderBy: 'createTime',
        pageSize: 25,
      });

      const messages = res.data.messages || [];

      for (const msg of messages) {
        // Skip bot messages (our own replies)
        if (msg.sender?.type === 'BOT') continue;

        await this.processMessage(msg);
      }

      // Update the last poll timestamp to now
      this.lastPollTime = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      const backoffMs = Math.min(this.pollIntervalMs * Math.pow(2, this.consecutiveErrors), 30 * 60 * 1000);
      logger.error({ err, consecutiveErrors: this.consecutiveErrors, nextPollMs: backoffMs }, 'Google Chat poll failed');
    }
  }

  private async processMessage(msg: chat_v1.Schema$Message): Promise<void> {
    const text = msg.text || '';
    if (!text) return;

    const senderName = msg.sender?.displayName || 'Unknown';
    const createTime = msg.createTime || new Date().toISOString();
    const messageName = msg.name || ''; // e.g. "spaces/xxx/messages/yyy"
    const messageId = messageName.split('/').pop() || messageName;

    const chatJid = `gchat:${this.spaceId}`;

    // Store chat metadata for group discovery
    this.opts.onChatMetadata(chatJid, createTime, `Google Chat DM`, 'googlechat', false);

    // Find the main group to deliver the message
    const groups = this.opts.registeredGroups();
    const mainEntry = Object.entries(groups).find(
      ([, g]) => g.folder === MAIN_GROUP_FOLDER,
    );

    if (!mainEntry) {
      logger.debug(
        { chatJid, text: text.slice(0, 50) },
        'No main group registered, skipping Google Chat message',
      );
      return;
    }

    const mainJid = mainEntry[0];
    const content = `[Google Chat from ${senderName}]\n\n${text}`;

    this.opts.onMessage(mainJid, {
      id: messageId,
      chat_jid: mainJid,
      sender: senderName,
      sender_name: senderName,
      content,
      timestamp: createTime,
      is_from_me: false,
    });

    logger.info(
      { mainJid, from: senderName },
      'Google Chat message delivered to main group',
    );
  }
}
