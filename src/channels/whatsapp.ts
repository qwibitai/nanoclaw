import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME, GROUPS_DIR, STORE_DIR } from '../config.js';
import {
  getLastGroupSync,
  setLastGroupSync,
  updateChatName,
} from '../db.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MEDIA_DIR_MODE = 0o700;
const MEDIA_FILE_INITIAL_MODE = 0o600;
const MEDIA_FILE_FINAL_MODE = 0o400;

function normalizeMimeType(mimeType?: string | null): string | undefined {
  const normalized = mimeType?.trim().toLowerCase().split(';', 1)[0];
  return normalized || undefined;
}

function sniffMimeType(buffer: Buffer): string | undefined {
  if (buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
    return 'application/pdf';
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buffer.length >= 6) {
    const header = buffer.subarray(0, 6).toString('ascii');
    if (header === 'GIF87a' || header === 'GIF89a') return 'image/gif';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

function extensionForMimeType(mimeType: string | undefined, isDocument: boolean): string {
  switch (mimeType) {
    case 'application/pdf':
      return 'pdf';
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return isDocument ? 'bin' : 'jpg';
  }
}

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;

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

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn({ err }, 'Failed to fetch latest WA Web version, using default');
      return { version: undefined };
    });
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
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
        this.sock.sendPresenceUpdate('available').catch((err) => {
          logger.warn({ err }, 'Failed to send presence update');
        });

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
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        // Translate LID JID to phone JID if applicable
        const chatJid = await this.translateJid(rawJid);

        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();

        // Always notify about chat metadata for group discovery
        const isGroup = chatJid.endsWith('@g.us');
        this.opts.onChatMetadata(chatJid, timestamp, undefined, 'whatsapp', isGroup);

        // Only deliver full message for registered groups
        const groups = this.opts.registeredGroups();
        if (groups[chatJid]) {
          // Download media if present (images or documents)
          let mediaPath: string | undefined;
          let mediaMimeType: string | undefined;
          const group = groups[chatJid];
          if (group) {
            const imgMsg = msg.message?.imageMessage;
            const docMsg = msg.message?.documentMessage;
            const mediaMsg = imgMsg || docMsg;
            if (mediaMsg) {
              try {
                const buffer = await downloadMediaMessage(
                  msg, 'buffer', {},
                  { reuploadRequest: this.sock.updateMediaMessage, logger }
                ) as Buffer;
                mediaMimeType = sniffMimeType(buffer) || normalizeMimeType(mediaMsg.mimetype);
                const ext = extensionForMimeType(mediaMimeType, Boolean(docMsg));
                const mediaDir = path.join(GROUPS_DIR, group.folder, 'media');
                fs.mkdirSync(mediaDir, { recursive: true, mode: MEDIA_DIR_MODE });
                fs.chmodSync(mediaDir, MEDIA_DIR_MODE);
                const filename = `${msg.key.id || Date.now()}.${ext}`;
                const fullPath = path.join(mediaDir, filename);
                fs.writeFileSync(fullPath, buffer, { mode: MEDIA_FILE_INITIAL_MODE });
                fs.chmodSync(fullPath, MEDIA_FILE_FINAL_MODE);
                mediaPath = `media/${filename}`;
              } catch (err) {
                logger.warn({ err }, 'Failed to download media');
              }
            }
          }

          const content =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            msg.message?.documentMessage?.caption ||
            '';

          // Skip protocol messages with no text content (encryption keys, read receipts, etc.)
          if (!content && !mediaPath) continue;

          const sender = msg.key.participant || msg.key.remoteJid || '';
          const senderName = msg.pushName || sender.split('@')[0];

          const fromMe = msg.key.fromMe || false;
          // Detect bot messages: with own number, fromMe is reliable
          // since only the bot sends from that number.
          // With shared number, bot messages carry the assistant name prefix
          // (even in DMs/self-chat) so we check for that.
          const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
            ? fromMe
            : content.startsWith(`${ASSISTANT_NAME}:`);

          this.opts.onMessage(chatJid, {
            id: msg.key.id || '',
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: fromMe,
            is_bot_message: isBotMessage,
            media_path: mediaPath,
            media_mime_type: mediaMimeType,
          });
        }
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info({ jid, length: prefixed.length, queueSize: this.outgoingQueue.length }, 'WA disconnected, message queued');
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text: prefixed });
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
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
        // Send directly — queued items are already prefixed by sendMessage
        await this.sock.sendMessage(item.jid, { text: item.text });
        logger.info({ jid: item.jid, length: item.text.length }, 'Queued message sent');
      }
    } finally {
      this.flushing = false;
    }
  }
}
