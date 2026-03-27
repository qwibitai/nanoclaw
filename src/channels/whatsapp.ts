/**
 * WhatsApp channel implementation using @whiskeysockets/baileys.
 *
 * Self-registers when this module is imported.
 * Credentials must exist in store/auth/ (run whatsapp-auth setup to create them).
 */
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  DisconnectReason,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
import pino from 'pino';

import { STORE_DIR } from '../config.js';
import {
  getAllChats,
  getLastGroupSync,
  setLastGroupSync,
  storeChatMetadata,
  updateChatName,
} from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const AUTH_DIR = path.join(STORE_DIR, 'auth');
const ONE_SECOND = 1000;
const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * ONE_SECOND;

// Quiet baileys logger — it's very chatty
const baileysLogger = pino({ level: 'silent' });

class WhatsAppChannel implements Channel {
  readonly name = 'whatsapp';

  private sock: ReturnType<typeof makeWASocket> | null = null;
  private connected = false;
  private shuttingDown = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  // LID to phone number mapping (WhatsApp now sends LID JIDs for self-chats)
  private lidToPhoneMap: Record<string, string> = {};

  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;

  constructor(opts: ChannelOpts) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
  }

  private reconnectDelay = 5 * ONE_SECOND;
  private readonly MAX_RECONNECT_DELAY = 5 * 60 * ONE_SECOND; // cap at 5 min
  private connGen = 0; // monotonically increasing generation to drop stale events

  async connect(): Promise<void> {
    await this.connectInternal();
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // WhatsApp owns all standard JIDs — group (@g.us) and individual (@s.whatsapp.net)
    return (
      jid.endsWith('@g.us') ||
      jid.endsWith('@s.whatsapp.net') ||
      jid.endsWith('@lid')
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected || !this.sock) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, length: text.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text });
      logger.info({ jid, length: text.length }, 'Message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected || !this.sock) return;
    try {
      if (isTyping) {
        await this.sock.sendPresenceUpdate('composing', jid);
      } else {
        await this.sock.sendPresenceUpdate('paused', jid);
      }
    } catch {
      // typing indicators are best-effort
    }
  }

  async syncGroups(force = false): Promise<void> {
    if (!this.connected || !this.sock) return;
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync — synced recently');
          return;
        }
      }
    }
    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();
      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          // Also fire onChatMetadata so the system knows about the group
          this.onChatMetadata(
            jid,
            new Date().toISOString(),
            metadata.subject,
            'whatsapp',
            true,
          );
          count++;
        }
      }
      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    if (this.sock) {
      try {
        await this.sock.logout();
      } catch {
        // Best-effort logout
      }
      this.sock = null;
    }
  }

  // ---- private ----

  private translateJid(jid: string): string {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];
    const phoneJid = this.lidToPhoneMap[lidUser];
    if (phoneJid) {
      logger.debug({ lidJid: jid, phoneJid }, 'Translated LID to phone JID');
      return phoneJid;
    }
    return jid;
  }

  private extractMessageContent(msg: proto.IWebMessageInfo): string | null {
    const m = msg.message;
    if (!m) return null;
    return (
      m.conversation ||
      m.extendedTextMessage?.text ||
      m.imageMessage?.caption ||
      m.videoMessage?.caption ||
      m.documentMessage?.caption ||
      m.buttonsResponseMessage?.selectedDisplayText ||
      m.listResponseMessage?.title ||
      m.ephemeralMessage?.message?.conversation ||
      m.ephemeralMessage?.message?.extendedTextMessage?.text ||
      null
    );
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.sendMessage(item.jid, item.text);
      }
    } finally {
      this.flushing = false;
    }
  }

  private async connectInternal(): Promise<void> {
    if (!fs.existsSync(AUTH_DIR)) {
      logger.warn(
        { authDir: AUTH_DIR },
        'WhatsApp auth directory missing — channel skipped. Run whatsapp-auth setup.',
      );
      return;
    }

    const myGen = ++this.connGen; // capture generation at connection start
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    const sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger),
      },
      printQRInTerminal: false,
      logger: baileysLogger,
      browser: ['NanoClaw', 'Chrome', '1.0.0'],
    });
    this.sock = sock;

    sock.ev.on('connection.update', (update) => {
      if (myGen !== this.connGen) return; // stale socket — ignore
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.error(
          'WhatsApp QR code required — re-run whatsapp-auth setup to re-authenticate.',
        );
        return;
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as
            | { output?: { statusCode?: number } }
            | undefined
        )?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info(
          {
            reason,
            shouldReconnect,
            queuedMessages: this.outgoingQueue.length,
          },
          'WA connection closed',
        );

        if (shouldReconnect && !this.shuttingDown) {
          logger.info({ reconnectIn: this.reconnectDelay }, 'Reconnecting to WhatsApp...');
          setTimeout(() => {
            if (this.sock) {
              try { this.sock.end(undefined); } catch { /* best-effort */ }
              this.sock = null;
            }
            this.connectInternal().catch((err) =>
              logger.error({ err }, 'Failed to reconnect to WhatsApp'),
            );
          }, this.reconnectDelay);
          // Exponential backoff, capped at MAX_RECONNECT_DELAY
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.MAX_RECONNECT_DELAY);
        } else if (!this.shuttingDown) {
          logger.error(
            'WhatsApp session logged out — run whatsapp-auth setup to re-authenticate.',
          );
        }
      } else if (connection === 'open') {
        this.connected = true;
        this.reconnectDelay = 5 * ONE_SECOND; // reset backoff on success
        logger.info('Connected to WhatsApp');

        // Build LID → phone mapping from auth state for self-chat translation
        if (sock.user) {
          const phoneUser = sock.user.id.split(':')[0];
          const lidUser = sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any queued outgoing messages
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroups().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );

        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroups().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Deliver stored chats as metadata (so available_groups.json is populated)
        const storedChats = getAllChats();
        for (const chat of storedChats) {
          if (chat.jid.endsWith('@g.us')) {
            this.onChatMetadata(
              chat.jid,
              chat.last_message_time ?? new Date().toISOString(),
              chat.name ?? undefined,
              'whatsapp',
              true,
            );
          }
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', ({ messages }) => {
      if (myGen !== this.connGen) return; // stale socket — ignore
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        const chatJid = this.translateJid(rawJid);
        const timestamp = new Date(
          Number(msg.messageTimestamp) * ONE_SECOND,
        ).toISOString();

        // Always fire metadata so new groups show up in discovery
        storeChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'whatsapp',
          chatJid.endsWith('@g.us'),
        );
        this.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'whatsapp',
          chatJid.endsWith('@g.us'),
        );

        // Deliver message to core orchestrator
        const content = this.extractMessageContent(msg);
        if (content === null) continue;

        const senderJid =
          (chatJid.endsWith('@g.us')
            ? msg.key.participant
            : msg.key.remoteJid) ?? '';
        const translatedSender = this.translateJid(senderJid);

        const newMsg: NewMessage = {
          id: msg.key.id ?? `${chatJid}-${timestamp}`,
          chat_jid: chatJid,
          sender: translatedSender,
          sender_name: msg.pushName ?? translatedSender.split('@')[0],
          content,
          timestamp,
          is_from_me: msg.key.fromMe ?? false,
        };

        this.onMessage(chatJid, newMsg);
      }
    });
  }
}

// Self-registration: returning null tells the registry to skip this channel
// when credentials are absent (handled inside WhatsAppChannel.connect()).
registerChannel('whatsapp', (opts: ChannelOpts) => {
  if (!fs.existsSync(AUTH_DIR)) {
    return null;
  }
  // Check that there are actual credential files (not just an empty dir)
  const files = fs.readdirSync(AUTH_DIR);
  if (files.length === 0) {
    return null;
  }
  return new WhatsAppChannel(opts);
});
