import fs from 'fs';
import os from 'os';
import path from 'path';

import { google, chat_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

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
  onSpaceDiscovered?: (jid: string, space: SpaceInfo) => void;
  getState?: (key: string) => string | undefined;
  setState?: (key: string, value: string) => void;
}

export interface SpaceInfo {
  spaceId: string;
  displayName: string;
  spaceType: string; // DIRECT_MESSAGE, SPACE, GROUP_CHAT
  lastPollTime: string | null;
}

export class GoogleChatChannel implements Channel {
  name = 'googlechat';

  private oauth2Client: OAuth2Client | null = null;
  private chat: chat_v1.Chat | null = null;
  private opts: GoogleChatChannelOpts;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private spaces: Map<string, SpaceInfo> = new Map();
  private consecutiveErrors = 0;
  private filterSpaceId: string;
  private botUserId: string | null = null;
  private discoveryCounter = 0;
  private readonly DISCOVERY_INTERVAL = 10; // re-discover every N poll cycles

  constructor(opts: GoogleChatChannelOpts, pollIntervalMs = 15000) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;
    const envConfig = readEnvFile(['GOOGLE_CHAT_SPACE_ID']);
    this.filterSpaceId =
      process.env.GOOGLE_CHAT_SPACE_ID || envConfig.GOOGLE_CHAT_SPACE_ID || '';
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

    // Discover spaces the bot belongs to
    await this.discoverSpaces();

    if (this.spaces.size === 0) {
      logger.warn('Google Chat: no spaces discovered, channel idle');
    } else {
      logger.info(
        { spaceCount: this.spaces.size },
        'Google Chat channel connected',
      );
    }

    // Start polling with error backoff
    const schedulePoll = () => {
      const backoffMs =
        this.consecutiveErrors > 0
          ? Math.min(
              this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
              30 * 60 * 1000,
            )
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

  /** Returns all discovered spaces with their JIDs and metadata. */
  getDiscoveredSpaces(): SpaceInfo[] {
    return Array.from(this.spaces.values());
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

  private async discoverSpaces(): Promise<void> {
    if (!this.chat) return;

    try {
      let pageToken: string | undefined;
      const discovered: chat_v1.Schema$Space[] = [];

      do {
        const res = await this.chat.spaces.list({
          pageSize: 100,
          pageToken,
        });
        if (res.data.spaces) {
          discovered.push(...res.data.spaces);
        }
        pageToken = res.data.nextPageToken || undefined;
      } while (pageToken);

      for (const space of discovered) {
        const spaceId = space.name?.replace(/^spaces\//, '');
        if (!spaceId) continue;

        // If a filter is set, only include that specific space
        if (this.filterSpaceId && spaceId !== this.filterSpaceId) continue;

        const existing = this.spaces.get(spaceId);
        if (!existing) {
          const spaceType = space.spaceType || space.type || 'SPACE';
          const isDm = spaceType === 'DIRECT_MESSAGE';
          const displayName = isDm
            ? 'Google Chat DM'
            : space.displayName || `Space ${spaceId}`;

          const savedPollTime =
            this.opts.getState?.(`gchat:poll:${spaceId}`) ?? null;

          this.spaces.set(spaceId, {
            spaceId,
            displayName,
            spaceType,
            lastPollTime: savedPollTime,
          });

          const chatJid = `gchat:${spaceId}`;

          // Notify metadata callback so the space is tracked in the DB
          this.opts.onChatMetadata(
            chatJid,
            new Date().toISOString(),
            displayName,
            'googlechat',
            !isDm,
          );

          logger.info(
            { spaceId, displayName, spaceType },
            'Discovered new Google Chat space',
          );

          // Notify index.ts to register this space as a group
          this.opts.onSpaceDiscovered?.(chatJid, this.spaces.get(spaceId)!);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Failed to discover Google Chat spaces');
    }
  }

  private async pollForMessages(): Promise<void> {
    if (!this.chat) return;

    // Periodically re-discover spaces to pick up new rooms
    this.discoveryCounter++;
    if (this.discoveryCounter >= this.DISCOVERY_INTERVAL) {
      this.discoveryCounter = 0;
      await this.discoverSpaces();
    }

    try {
      for (const [spaceId, spaceInfo] of this.spaces) {
        await this.pollSpace(spaceId, spaceInfo);
      }
      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      const backoffMs = Math.min(
        this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
        30 * 60 * 1000,
      );
      logger.error(
        {
          err,
          consecutiveErrors: this.consecutiveErrors,
          nextPollMs: backoffMs,
        },
        'Google Chat poll failed',
      );
    }
  }

  private async pollSpace(
    spaceId: string,
    spaceInfo: SpaceInfo,
  ): Promise<void> {
    if (!this.chat) return;

    try {
      const filterParts: string[] = [];
      if (spaceInfo.lastPollTime) {
        filterParts.push(`createTime > "${spaceInfo.lastPollTime}"`);
      }
      const filter =
        filterParts.length > 0 ? filterParts.join(' AND ') : undefined;

      const res = await this.chat.spaces.messages.list({
        parent: `spaces/${spaceId}`,
        filter: filter || undefined,
        orderBy: 'createTime',
        pageSize: 25,
      });

      const messages = res.data.messages || [];

      for (const msg of messages) {
        // Skip bot messages (our own replies)
        if (msg.sender?.type === 'BOT') continue;

        // Track the bot's user ID from message annotations so we can strip self-mentions
        if (!this.botUserId && msg.annotations) {
          for (const ann of msg.annotations) {
            if (ann.type === 'USER_MENTION' && ann.userMention?.user?.type === 'BOT') {
              this.botUserId = ann.userMention.user.name || null;
            }
          }
        }

        await this.processMessage(msg, spaceId, spaceInfo);
      }

      // Update the last poll timestamp for this space
      const pollTime = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      spaceInfo.lastPollTime = pollTime;
      this.opts.setState?.(`gchat:poll:${spaceId}`, pollTime);
    } catch (err) {
      logger.error({ spaceId, err }, 'Failed to poll Google Chat space');
    }
  }

  private async processMessage(
    msg: chat_v1.Schema$Message,
    spaceId: string,
    spaceInfo: SpaceInfo,
  ): Promise<void> {
    let text = msg.text || '';
    if (!text) return;

    // Strip raw Google Chat mention markup (e.g. `<users/123456>`) but keep
    // the human-readable `@Name` so the trigger pattern still matches.
    if (this.botUserId) {
      text = text.replace(new RegExp(`<${this.botUserId}>\\s*`, 'g'), '').trim();
    }

    if (!text) return;

    const senderName = msg.sender?.displayName || 'Unknown';
    if (!msg.sender?.displayName) {
      logger.debug(
        { sender: msg.sender, messageName: msg.name },
        'Google Chat message has no sender displayName',
      );
    }
    const createTime = msg.createTime || new Date().toISOString();
    const messageName = msg.name || ''; // e.g. "spaces/xxx/messages/yyy"
    const messageId = messageName.split('/').pop() || messageName;

    const chatJid = `gchat:${spaceId}`;
    const isDm = spaceInfo.spaceType === 'DIRECT_MESSAGE';

    // Store chat metadata
    this.opts.onChatMetadata(
      chatJid,
      createTime,
      spaceInfo.displayName,
      'googlechat',
      !isDm,
    );

    this.opts.onMessage(chatJid, {
      id: messageId,
      chat_jid: chatJid,
      sender: senderName,
      sender_name: senderName,
      content: text,
      timestamp: createTime,
      is_from_me: false,
    });

    logger.info(
      { chatJid, from: senderName, spaceType: spaceInfo.spaceType },
      'Google Chat message delivered',
    );
  }
}
