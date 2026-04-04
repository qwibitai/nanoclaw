import crypto from 'crypto';

import { type Socket, io } from 'socket.io-client';

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const BB_PREFIX = 'bb:';
const CHAT_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function toJid(chatGuid: string): string {
  return `${BB_PREFIX}${chatGuid}`;
}

function fromJid(jid: string): string {
  return jid.slice(BB_PREFIX.length);
}

interface BBHandle {
  address: string;
  displayName?: string;
}

interface BBChat {
  guid: string;
  displayName?: string;
  participants?: BBHandle[];
}

interface BBMessage {
  guid: string;
  text?: string | null;
  isFromMe: boolean;
  dateCreated: number;
  handle?: BBHandle | null;
  chats?: BBChat[];
}

export class BlueBubblesChannel implements Channel {
  name = 'bluebubbles';

  private socket: Socket | null = null;
  private connected = false;
  private chatSyncTimerStarted = false;

  private opts: ChannelOpts;
  private serverUrl: string;
  private password: string;

  constructor(opts: ChannelOpts, serverUrl: string, password: string) {
    this.opts = opts;
    this.serverUrl = serverUrl;
    this.password = password;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.socket = io(this.serverUrl, {
        query: { password: this.password },
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 5000,
        reconnectionAttempts: Infinity,
      });

      let resolved = false;

      this.socket.on('connect', () => {
        this.connected = true;
        logger.info({ serverUrl: this.serverUrl }, 'Connected to BlueBubbles');

        this.syncChats().catch((err) =>
          logger.error({ err }, 'Initial BlueBubbles chat sync failed'),
        );

        if (!this.chatSyncTimerStarted) {
          this.chatSyncTimerStarted = true;
          setInterval(() => {
            this.syncChats().catch((err) =>
              logger.error({ err }, 'Periodic BlueBubbles chat sync failed'),
            );
          }, CHAT_SYNC_INTERVAL_MS);
        }

        if (!resolved) {
          resolved = true;
          resolve();
        }
      });

      this.socket.on('disconnect', (reason) => {
        this.connected = false;
        logger.info({ reason }, 'Disconnected from BlueBubbles');
      });

      this.socket.on('connect_error', (err) => {
        logger.error({ err: String(err) }, 'BlueBubbles connection error');
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      this.socket.on(
        'new-message',
        (payload: { data: BBMessage } | BBMessage) => {
          // Server versions differ on whether the event wraps in { data: ... }
          const msg = 'data' in payload ? payload.data : payload;
          this.handleMessage(msg).catch((err) =>
            logger.error({ err }, 'Error handling BlueBubbles message'),
          );
        },
      );
    });
  }

  private async handleMessage(msg: BBMessage): Promise<void> {
    const text = msg.text;
    if (!text) return; // attachment-only or protocol message

    const chatGuid = msg.chats?.[0]?.guid;
    if (!chatGuid) return;

    const jid = toJid(chatGuid);
    const timestamp = new Date(msg.dateCreated).toISOString();
    const isGroup = chatGuid.includes(';+;');
    const chatName = msg.chats?.[0]?.displayName;

    this.opts.onChatMetadata(jid, timestamp, chatName, 'bluebubbles', isGroup);

    const groups = this.opts.registeredGroups();
    if (!groups[jid]) return;

    const sender = msg.handle?.address ?? (msg.isFromMe ? 'me' : 'unknown');
    const senderName = msg.handle?.displayName ?? sender;

    this.opts.onMessage(jid, {
      id: msg.guid,
      chat_jid: jid,
      sender,
      sender_name: senderName,
      content: text,
      timestamp,
      is_from_me: msg.isFromMe,
      is_bot_message: msg.isFromMe,
    });
  }

  private apiUrl(path: string): string {
    return `${this.serverUrl}${path}?password=${encodeURIComponent(this.password)}`;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatGuid = fromJid(jid);
    const url = this.apiUrl('/api/v1/message/text');

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatGuid,
        message: text,
        tempGuid: crypto.randomUUID(),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `BlueBubbles sendMessage failed: HTTP ${response.status} ${body}`,
      );
    }

    logger.info({ jid, length: text.length }, 'BlueBubbles message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(BB_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.socket?.disconnect();
    this.socket = null;
  }

  async syncGroups(_force: boolean): Promise<void> {
    return this.syncChats();
  }

  private async syncChats(): Promise<void> {
    try {
      const url = this.apiUrl('/api/v1/chat/query');
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 100, offset: 0 }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const body = (await response.json()) as { data: BBChat[] };
      const chats = body.data ?? [];
      const now = new Date().toISOString();

      for (const chat of chats) {
        const jid = toJid(chat.guid);
        const isGroup = chat.guid.includes(';+;');
        const name = chat.displayName ?? chat.participants?.[0]?.address;
        this.opts.onChatMetadata(jid, now, name, 'bluebubbles', isGroup);
      }

      logger.info({ count: chats.length }, 'BlueBubbles chats synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync BlueBubbles chats');
    }
  }
}

registerChannel('bluebubbles', (opts: ChannelOpts) => {
  const env = readEnvFile(['BLUEBUBBLES_SERVER_URL', 'BLUEBUBBLES_PASSWORD']);
  const serverUrl =
    process.env.BLUEBUBBLES_SERVER_URL ?? env.BLUEBUBBLES_SERVER_URL;
  const password = process.env.BLUEBUBBLES_PASSWORD ?? env.BLUEBUBBLES_PASSWORD;

  if (!serverUrl || !password) return null;
  return new BlueBubblesChannel(opts, serverUrl, password);
});
