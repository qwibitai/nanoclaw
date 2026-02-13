import {
  MatrixClient,
  SimpleFsStorageProvider,
} from 'matrix-bot-sdk';

import {
  MATRIX_ACCESS_TOKEN,
  MATRIX_HOMESERVER,
  MATRIX_USER_ID,
  STORE_DIR,
} from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface MatrixChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

function toJid(roomId: string): string {
  return `matrix:${roomId}`;
}

function toRoomId(jid: string): string {
  return jid.slice('matrix:'.length);
}

export class MatrixChannel implements Channel {
  name = 'matrix';
  prefixAssistantName = false; // Bot display name shows in Matrix

  private client: MatrixClient | null = null;
  private _connected = false;
  private opts: MatrixChannelOpts;

  constructor(opts: MatrixChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (!MATRIX_HOMESERVER || !MATRIX_ACCESS_TOKEN) {
      logger.debug('Matrix not configured, channel dormant');
      return;
    }

    const storage = new SimpleFsStorageProvider(`${STORE_DIR}/matrix-bot.json`);
    this.client = new MatrixClient(MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN, storage);

    // Auto-join rooms when invited (with error handling)
    this.client.on('room.invite', async (roomId: string) => {
      try {
        await this.client!.joinRoom(roomId);
        logger.info({ roomId }, 'Auto-joined Matrix room');
      } catch (err) {
        logger.warn({ roomId, err }, 'Failed to auto-join Matrix room');
      }
    });

    // Listen for messages
    this.client.on('room.message', async (roomId: string, event: Record<string, unknown>) => {
      logger.debug({ roomId, sender: event.sender }, 'Matrix room.message event');
      if (!event.content) return;
      const content = event.content as Record<string, unknown>;
      if (content.msgtype !== 'm.text') return;

      // Ignore own messages
      if (event.sender === MATRIX_USER_ID) return;

      const matrixJid = toJid(roomId);
      const timestamp = new Date(event.origin_server_ts as number).toISOString();
      const senderName = await this.getSenderName(event.sender as string);

      // Notify metadata for room discovery
      const roomName = await this.getRoomName(roomId);
      this.opts.onChatMetadata(matrixJid, timestamp, roomName);

      // Only deliver full messages for registered rooms
      const groups = this.opts.registeredGroups();
      if (!groups[matrixJid]) {
        logger.debug({ matrixJid, registeredJids: Object.keys(groups) }, 'Matrix message from unregistered room');
        return;
      }

      const msg: NewMessage = {
        id: event.event_id as string,
        chat_jid: matrixJid,
        sender: event.sender as string,
        sender_name: senderName,
        content: content.body as string,
        timestamp,
      };

      logger.debug({ matrixJid, content: content.body }, 'Matrix message delivered to onMessage');
      this.opts.onMessage(matrixJid, msg);
    });

    try {
      await this.client.start();
      this._connected = true;
      logger.info('Connected to Matrix');
    } catch (err) {
      logger.error({ err }, 'Failed to connect to Matrix');
      // Matrix is explicitly configured; fail fast so startup does not
      // continue in a degraded "no channel" state.
      throw err;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client || !this._connected) return;
    const roomId = toRoomId(jid);
    try {
      await this.client.sendText(roomId, text);
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to send Matrix message');
    }
  }

  isConnected(): boolean {
    return this._connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('matrix:');
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this.client?.stop();
  }

  async sendImage(jid: string, buffer: Buffer, filename: string, mimetype: string, caption?: string): Promise<void> {
    if (!this.client || !this._connected) return;
    const roomId = toRoomId(jid);
    try {
      logger.info({ filename, mimetype, size: buffer.length }, 'Uploading image to Matrix');
      const mxcUrl = await this.client.uploadContent(buffer, mimetype, filename);
      logger.info({ mxcUrl, filename }, 'Image uploaded, sending to room');
      const content: Record<string, unknown> = {
        msgtype: 'm.image',
        body: caption || filename,
        url: mxcUrl,
        info: {
          mimetype,
          size: buffer.length,
        },
      };
      await this.client.sendMessage(roomId, content);
      logger.info({ roomId, filename }, 'Image message sent');
    } catch (err) {
      logger.warn({ jid, filename, err }, 'Failed to send Matrix image');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !this._connected) return;
    const roomId = toRoomId(jid);
    try {
      await this.client.setTyping(roomId, isTyping, 30000);
    } catch {
      // Non-critical
    }
  }

  private async getSenderName(userId: string): Promise<string> {
    if (!this.client) return userId;
    try {
      const profile = await this.client.getUserProfile(userId);
      return profile.displayname || userId.split(':')[0].slice(1);
    } catch {
      return userId.split(':')[0].slice(1);
    }
  }

  private async getRoomName(roomId: string): Promise<string> {
    if (!this.client) return roomId;
    try {
      const state = await this.client.getRoomStateEvent(roomId, 'm.room.name', '');
      return state.name || roomId;
    } catch {
      return roomId;
    }
  }
}
