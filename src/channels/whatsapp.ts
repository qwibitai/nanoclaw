import { $ } from 'bun';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { STORE_DIR } from '../config.js';
import {
  getLastGroupSync,
  setLastGroupSync,
  updateChatName,
} from '../db.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  onReaction?: (chatJid: string, messageId: string, emoji: string) => void;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';
  prefixAssistantName = true;

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  private messageCache = new Map<string, { msg: any; ts: number }>();
  private static readonly MESSAGE_CACHE_MAX = 500;
  private static readonly MESSAGE_CACHE_TTL = 60 * 60 * 1000; // 1 hour
  // Track IDs of messages we sent so the upsert handler can ignore echoes (self-chat loop fix)
  private sentMessageIds = new Set<string>();
  private static readonly SENT_IDS_MAX = 200;

  // Store event handlers so they can be removed on reconnect
  private messageHandler: ((data: any) => Promise<void>) | null = null;
  private reactionHandler: ((data: any) => Promise<void>) | null = null;
  private connectionHandler: ((data: any) => void) | null = null;
  private credsHandler: (() => Promise<void>) | null = null;

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // Remove old event listeners before creating new socket (prevents memory leaks)
    if (this.sock?.ev) {
      if (this.connectionHandler) {
        this.sock.ev.off('connection.update', this.connectionHandler);
      }
      if (this.credsHandler) {
        this.sock.ev.off('creds.update', this.credsHandler);
      }
      if (this.messageHandler) {
        this.sock.ev.off('messages.upsert', this.messageHandler);
      }
      if (this.reactionHandler) {
        this.sock.ev.off('messages.reaction', this.reactionHandler);
      }
    }

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
      // NanoClaw has its own message DB — skip history sync to avoid 20s timeout
      shouldSyncHistoryMessage: () => false,
    });

    // Store connection handler for later removal
    this.connectionHandler = (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        $`osascript -e ${`display notification "${msg}" with title "NanoClaw" sound name "Basso"`}`.quiet().nothrow();
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info({ reason, shouldReconnect, queuedMessages: this.outgoingQueue.length }, 'Connection closed');

        if (shouldReconnect) {
          logger.info('Reconnecting...');
          this.connectInternal().catch((err) => {
            logger.error({ err }, 'Failed to reconnect, retrying in 5s');
            setTimeout(() => {
              this.connectInternal().catch((err2) => {
                logger.error({ err: err2 }, 'Reconnection retry failed');
              });
            }, 5000);
          });
        } else {
          logger.info('Logged out. Run /setup to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        this.connected = true;
        logger.info('Connected to WhatsApp');

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch(() => {});

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    };
    this.sock.ev.on('connection.update', this.connectionHandler);

    // Store creds handler for later removal
    this.credsHandler = saveCreds;
    this.sock.ev.on('creds.update', this.credsHandler);

    // Store message handler for later removal
    this.messageHandler = async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        // Skip echoes of our own sent messages (prevents self-chat loop)
        if (msg.key.id && this.sentMessageIds.has(msg.key.id)) {
          this.sentMessageIds.delete(msg.key.id);
          continue;
        }

        // Translate LID JID to phone JID if applicable
        const chatJid = await this.translateJid(rawJid);

        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();

        // Always notify about chat metadata for group discovery
        this.opts.onChatMetadata(chatJid, timestamp);

        // Only deliver full message for registered groups
        const groups = this.opts.registeredGroups();
        if (groups[chatJid]) {
          // Cache raw message for outbound quoting
          const msgId = msg.key.id || '';
          if (msgId) {
            this.messageCache.set(msgId, { msg, ts: Date.now() });
            this.pruneMessageCache();
          }

          let content =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            '';

          // Skip protocol messages with no text content (encryption keys, read receipts, etc.)
          if (!content) continue;

          const sender = msg.key.participant || msg.key.remoteJid || '';
          const senderName = msg.pushName || sender.split('@')[0];

          // Prepend reply context so the agent knows what's being replied to
          const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
          if (contextInfo?.quotedMessage) {
            const quotedText = contextInfo.quotedMessage.conversation
              || contextInfo.quotedMessage.extendedTextMessage?.text || '';
            if (quotedText) {
              const truncated = quotedText.length > 200 ? quotedText.slice(0, 200) + '…' : quotedText;
              const quotedSender = contextInfo.participant?.split('@')[0] || 'someone';
              content = `[Replying to ${quotedSender}: "${truncated}"]\n${content}`;
            }
          }

          this.opts.onMessage(chatJid, {
            id: msgId,
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: msg.key.fromMe || false,
          });
        }
      }
    };
    this.sock.ev.on('messages.upsert', this.messageHandler);

    // Store reaction handler for later removal
    this.reactionHandler = async (reactions) => {
      for (const { key, reaction } of reactions) {
        if (!reaction?.text || !key.id || !key.remoteJid) continue;
        const chatJid = await this.translateJid(key.remoteJid);
        this.opts.onReaction?.(chatJid, key.id, reaction.text);
      }
    };
    this.sock.ev.on('messages.reaction', this.reactionHandler);
  }

  async sendMessage(jid: string, text: string, replyToMessageId?: string): Promise<string | void> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info({ jid, length: text.length, queueSize: this.outgoingQueue.length }, 'WA disconnected, message queued');
      return;
    }
    try {
      const cached = replyToMessageId ? this.messageCache.get(replyToMessageId) : undefined;
      const opts = cached ? { quoted: cached.msg } : undefined;
      const sent = await this.sock.sendMessage(jid, { text }, opts);
      const sentId = sent?.key?.id;
      if (sentId) {
        this.sentMessageIds.add(sentId);
        // Prune to avoid unbounded growth
        if (this.sentMessageIds.size > WhatsAppChannel.SENT_IDS_MAX) {
          const first = this.sentMessageIds.values().next().value;
          if (first) this.sentMessageIds.delete(first);
        }
      }
      logger.info({ jid, length: text.length }, 'Message sent');
      return sentId ?? undefined;
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send, message queued');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
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
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug({ lidJid: jid, phoneJid: cached }, 'Translated LID to phone JID (cached)');
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info({ lidJid: jid, phoneJid }, 'Translated LID to phone JID (signalRepository)');
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing outgoing message queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.sendMessage(item.jid, item.text);
      }
    } finally {
      this.flushing = false;
    }
  }

  private pruneMessageCache(): void {
    const now = Date.now();
    // Evict expired entries
    for (const [id, entry] of this.messageCache) {
      if (now - entry.ts > WhatsAppChannel.MESSAGE_CACHE_TTL) {
        this.messageCache.delete(id);
      }
    }
    // Cap at max size — evict oldest
    if (this.messageCache.size > WhatsAppChannel.MESSAGE_CACHE_MAX) {
      const entries = [...this.messageCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
      const toRemove = entries.length - WhatsAppChannel.MESSAGE_CACHE_MAX;
      for (let i = 0; i < toRemove; i++) {
        this.messageCache.delete(entries[i][0]);
      }
    }
  }
}
