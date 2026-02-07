/**
 * WhatsApp Channel for NanoClaw
 *
 * Wraps the existing Baileys-based WhatsApp connection as a BaseChannel.
 * This is the primary channel, migrated from the monolithic index.ts.
 */
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  DisconnectReason,
  WASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { STORE_DIR } from '../config.js';
import { logger } from '../logger.js';
import { BaseChannel, ChannelConfig, InboundMessage } from './base.js';

export interface WhatsAppChannelConfig extends ChannelConfig {
  assistantName: string;
  authDir?: string;
}

export class WhatsAppChannel extends BaseChannel {
  private sock: WASocket | null = null;
  private whatsappConfig: WhatsAppChannelConfig;
  /** LID to phone number mapping (WhatsApp sends LID JIDs for self-chats) */
  private lidToPhoneMap = new Map<string, string>();
  private static readonly MAX_LID_MAP_SIZE = 10000;

  constructor(config: WhatsAppChannelConfig) {
    super('whatsapp', config);
    this.whatsappConfig = config;
  }

  getSocket(): WASocket | null {
    return this.sock;
  }

  async start(): Promise<void> {
    const authDir = this.whatsappConfig.authDir || path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: ['NanoClaw', 'Chrome', '1.0.0'],
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.error(
          'WhatsApp authentication required. Run /setup in Claude Code.',
        );
      }

      if (connection === 'close') {
        const reason = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info({ reason, shouldReconnect }, 'WhatsApp connection closed');

        if (shouldReconnect) {
          logger.info('Reconnecting WhatsApp...');
          this.start();
        } else {
          logger.info('WhatsApp logged out. Run /setup to re-authenticate.');
          this.emit('disconnected', 'logged_out');
        }
      } else if (connection === 'open') {
        logger.info('Connected to WhatsApp');

        // Build LID to phone mapping
        if (this.sock?.user) {
          const parts = this.sock.user.id.split(':');
          const phoneUser = parts.length > 0 ? parts[0] : undefined;
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            // Evict oldest entries if map grows too large
            if (this.lidToPhoneMap.size >= WhatsAppChannel.MAX_LID_MAP_SIZE) {
              const firstKey = this.lidToPhoneMap.keys().next().value;
              if (firstKey) this.lidToPhoneMap.delete(firstKey);
            }
            this.lidToPhoneMap.set(lidUser, `${phoneUser}@s.whatsapp.net`);
          }
        }

        this.emit('connected');
      }
    });

    this.sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        const chatJid = this.translateJid(rawJid);
        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();

        const content =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          msg.message?.imageMessage?.caption ||
          msg.message?.videoMessage?.caption ||
          '';

        const sender = msg.key.participant || msg.key.remoteJid || '';
        const senderName = msg.pushName || sender.split('@')[0];

        const inbound: InboundMessage = {
          id: msg.key.id || '',
          channel: 'whatsapp',
          chatId: chatJid,
          senderId: sender,
          senderName,
          content,
          timestamp,
          isFromMe: msg.key.fromMe || false,
          raw: msg,
        };

        this.emitMessage(inbound);
      }
    });
  }

  async stop(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.sock) {
      logger.error('WhatsApp not connected, cannot send message');
      return;
    }
    try {
      await this.sock.sendMessage(chatId, { text });
      logger.info({ chatId, length: text.length }, 'WhatsApp message sent');
    } catch (err) {
      logger.error({ chatId, err }, 'Failed to send WhatsApp message');
    }
  }

  async setTyping(chatId: string, isTyping: boolean): Promise<void> {
    if (!this.sock) return;
    try {
      await this.sock.sendPresenceUpdate(
        isTyping ? 'composing' : 'paused',
        chatId,
      );
    } catch {
      // Typing indicator failure is non-critical
    }
  }

  async fetchAllGroups(): Promise<
    Record<string, { subject: string }>
  > {
    if (!this.sock) return {};
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      // Convert to simpler type to avoid GroupMetadata index signature issues
      const result: Record<string, { subject: string }> = {};
      for (const [jid, meta] of Object.entries(groups)) {
        result[jid] = { subject: meta.subject };
      }
      return result;
    } catch (err) {
      logger.error({ err }, 'Failed to fetch WhatsApp groups');
      return {};
    }
  }

  private translateJid(jid: string): string {
    if (!jid.endsWith('@lid')) return jid;
    const parts = jid.split('@');
    if (parts.length < 2) return jid;
    const lidUser = parts[0].split(':')[0];
    return this.lidToPhoneMap.get(lidUser) || jid;
  }
}
