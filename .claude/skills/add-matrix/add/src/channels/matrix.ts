import {
  AutojoinRoomsMixin,
  MatrixClient,
  RustSdkCryptoStorageProvider,
  RustSdkCryptoStoreType,
  SimpleFsStorageProvider,
} from 'matrix-bot-sdk';
import path from 'path';

import { ASSISTANT_NAME, STORE_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel } from '../types.js';
import { ChannelOpts, registerChannel } from './registry.js';

/** Minimal type for Matrix room message events */
interface MatrixRoomEvent {
  content?: {
    msgtype?: string;
    body?: string;
  };
  sender?: string;
  event_id?: string;
  origin_server_ts?: number;
  type?: string;
}

const MAX_MESSAGE_LENGTH = 60_000; // Below Matrix's ~65KB event limit (in bytes)

export class MatrixChannel implements Channel {
  name = 'matrix';

  private client: MatrixClient | null = null;
  private opts: ChannelOpts;
  private homeserverUrl: string;
  private accessToken: string;
  private botUserId: string | null = null;
  private roomNameCache: Map<string, { name: string; ts: number }> = new Map();
  private static ROOM_NAME_CACHE_TTL = 300_000; // 5 minutes
  private static ROOM_NAME_CACHE_MAX = 500;

  constructor(
    homeserverUrl: string,
    accessToken: string,
    opts: ChannelOpts,
    private enableE2ee: boolean = true,
  ) {
    this.homeserverUrl = homeserverUrl;
    this.accessToken = accessToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    try {
      const storagePath = path.join(STORE_DIR, 'matrix-state.json');
      const storage = new SimpleFsStorageProvider(storagePath);

      // Initialize E2EE crypto store if enabled
      let cryptoStore: RustSdkCryptoStorageProvider | undefined;
      if (this.enableE2ee) {
        try {
          const cryptoStorePath = path.join(STORE_DIR, 'matrix-crypto');
          cryptoStore = new RustSdkCryptoStorageProvider(
            cryptoStorePath,
            RustSdkCryptoStoreType.Sqlite,
          );
        } catch (err) {
          logger.warn(
            { err },
            'Failed to initialize Matrix E2EE crypto store — continuing without encryption',
          );
        }
      }

      this.client = new MatrixClient(
        this.homeserverUrl,
        this.accessToken,
        storage,
        cryptoStore,
      );
      AutojoinRoomsMixin.setupOnClient(this.client);

      // Cache bot user ID for own-message filtering
      this.botUserId = await this.client.getUserId();

      // Deduplicate events — the SDK may emit both room.message and
      // room.decrypted_event for the same decrypted message
      const handledEventIds = new Set<string>();
      const messageHandler = async (roomId: string, event: MatrixRoomEvent) => {
        const eventId = event?.event_id;
        if (eventId && handledEventIds.has(eventId)) return;
        if (eventId) {
          handledEventIds.add(eventId);
          if (handledEventIds.size > 500) {
            const first = handledEventIds.values().next().value;
            if (first) handledEventIds.delete(first);
          }
        }
        try {
          await this.handleRoomMessage(roomId, event);
        } catch (err) {
          logger.error({ err, roomId }, 'Error handling Matrix room message');
        }
      };

      this.client.on('room.message', messageHandler);

      // Handle decrypted E2EE messages — the SDK emits room.decrypted_event
      // after successful decryption, but may not always emit room.message for them
      this.client.on(
        'room.decrypted_event',
        async (roomId: string, event: any) => {
          if (event?.type === 'm.room.message') {
            await messageHandler(roomId, event);
          }
        },
      );

      // Log decryption failures so we can diagnose E2EE issues
      this.client.on(
        'room.failed_decryption',
        async (roomId: string, event: any, err: Error) => {
          logger.warn(
            { roomId, eventId: event?.event_id, err: err?.message },
            'Matrix failed to decrypt message',
          );
        },
      );

      await this.client.start();

      logger.info(
        {
          homeserver: this.homeserverUrl,
          userId: this.botUserId,
          e2ee: !!this.client.crypto?.isReady,
        },
        'Matrix bot connected',
      );
      console.log(`\n  Matrix bot: ${this.botUserId}`);
      console.log(
        `  E2EE: ${this.client.crypto?.isReady ? 'enabled' : 'disabled'}`,
      );
      console.log(`  Send !chatid in a room to get its registration ID\n`);
    } catch (err) {
      logger.error(
        { homeserver: this.homeserverUrl, err },
        'Failed to connect Matrix bot',
      );
      this.client = null;
      this.botUserId = null;
    }
  }

  private async handleRoomMessage(
    roomId: string,
    event: MatrixRoomEvent,
  ): Promise<void> {
    // Skip events without content (redacted, etc.)
    if (!event?.content) return;

    // Skip non-text messages
    if (event.content.msgtype !== 'm.text') return;

    // Skip bot's own messages
    if (event.sender === this.botUserId) return;

    const chatJid = `mx:${roomId}`;
    let content: string = event.content.body || '';
    const timestamp = event.origin_server_ts
      ? new Date(event.origin_server_ts).toISOString()
      : new Date().toISOString();
    const sender = event.sender || '';
    // Extract display name portion from Matrix user ID (@user:server → user)
    const senderName = sender.startsWith('@')
      ? sender.slice(1).split(':')[0]
      : sender;
    const msgId = event.event_id || '';

    // Handle commands
    if (content === '!chatid') {
      await this.client?.sendNotice(roomId, `Chat ID: ${chatJid}\nType: room`);
      return;
    }
    if (content === '!ping') {
      await this.client?.sendNotice(roomId, `${ASSISTANT_NAME} is online.`);
      return;
    }

    // Translate Matrix @mentions of the bot to trigger format
    if (this.botUserId) {
      const botLocalpart = this.botUserId.startsWith('@')
        ? this.botUserId.slice(1).split(':')[0]
        : this.botUserId;
      const mentionPatterns = [
        this.botUserId.toLowerCase(),
        `@${botLocalpart}`.toLowerCase(),
      ];
      const contentLower = content.toLowerCase();
      const hasBotMention = mentionPatterns.some((p) =>
        contentLower.includes(p),
      );
      if (hasBotMention && !TRIGGER_PATTERN.test(content)) {
        content = `@${ASSISTANT_NAME} ${content}`;
      }
    }

    // Resolve room name for metadata (cached to avoid per-message API calls)
    let roomName: string | undefined;
    const cached = this.roomNameCache.get(roomId);
    if (cached && Date.now() - cached.ts < MatrixChannel.ROOM_NAME_CACHE_TTL) {
      roomName = cached.name;
    } else {
      try {
        const roomState = await this.client?.getRoomStateEvent(
          roomId,
          'm.room.name',
          '',
        );
        roomName = roomState?.name;
        if (roomName) {
          this.roomNameCache.set(roomId, { name: roomName, ts: Date.now() });
          if (this.roomNameCache.size > MatrixChannel.ROOM_NAME_CACHE_MAX) {
            const first = this.roomNameCache.keys().next().value;
            if (first) this.roomNameCache.delete(first);
          }
        }
      } catch {
        // Room may not have a name set — use JID as fallback
      }
    }

    // Store chat metadata for ALL messages (registered or not)
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      roomName || chatJid,
      'matrix',
      true,
    );

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, roomName },
        'Message from unregistered Matrix room',
      );
      return;
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, roomName, sender: senderName },
      'Matrix message stored',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn({ jid }, 'Matrix client not initialized, cannot send');
      return;
    }

    try {
      const roomId = jid.replace(/^mx:/, '');

      // Truncate based on UTF-8 byte length (safety margin below Matrix's ~65KB event limit)
      let message = text;
      if (Buffer.byteLength(text, 'utf8') > MAX_MESSAGE_LENGTH) {
        let end = text.length;
        while (
          end > 0 &&
          Buffer.byteLength(text.slice(0, end), 'utf8') > MAX_MESSAGE_LENGTH
        ) {
          end = Math.floor(end * 0.9);
        }
        message =
          text.slice(0, end) + '\n\n[Message truncated due to size limit]';
      }

      await this.client.sendText(roomId, message);
      logger.info({ jid, length: text.length }, 'Matrix message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Matrix message');
    }
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('mx:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.stop();
      this.client = null;
      this.botUserId = null;
      logger.info('Matrix bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;
    try {
      const roomId = jid.replace(/^mx:/, '');
      await this.client.setTyping(roomId, isTyping, isTyping ? 30_000 : 0);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Matrix typing indicator');
    }
  }
}

// Self-register with channel registry
registerChannel('matrix', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'MATRIX_HOMESERVER_URL',
    'MATRIX_ACCESS_TOKEN',
    'MATRIX_E2EE',
  ]);
  const homeserverUrl =
    process.env.MATRIX_HOMESERVER_URL || envVars.MATRIX_HOMESERVER_URL || '';
  const accessToken =
    process.env.MATRIX_ACCESS_TOKEN || envVars.MATRIX_ACCESS_TOKEN || '';
  if (!homeserverUrl || !accessToken) {
    logger.warn('Matrix: MATRIX_HOMESERVER_URL or MATRIX_ACCESS_TOKEN not set');
    return null;
  }
  const e2ee =
    (process.env.MATRIX_E2EE || envVars.MATRIX_E2EE || 'true') !== 'false';
  return new MatrixChannel(homeserverUrl, accessToken, opts, e2ee);
});
