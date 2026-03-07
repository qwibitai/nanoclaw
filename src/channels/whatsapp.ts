import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  OPENCLAW_AUTH_DIR,
  STORE_DIR,
  WHATSAPP_PAIRING_PHONE,
} from '../config.js';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30000;
const QR_FILE = path.join(STORE_DIR, 'qr-data.txt');
const PAIRING_CODE_FILE = path.join(STORE_DIR, 'pairing-code.txt');
const AUTH_STATUS_FILE = path.join(STORE_DIR, 'auth-status.txt');

function writeArtifact(filePath: string, content: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  } catch (err) {
    logger.warn({ err, filePath }, 'Failed to write WhatsApp auth artifact');
  }
}

function removeArtifact(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // no-op
  }
}

function maybeSeedAuthFromOpenClaw(authDir: string): void {
  const localCreds = path.join(authDir, 'creds.json');
  if (fs.existsSync(localCreds)) return;

  const sourceCreds = path.join(OPENCLAW_AUTH_DIR, 'creds.json');
  if (!fs.existsSync(sourceCreds)) return;

  try {
    fs.mkdirSync(authDir, { recursive: true });
    fs.cpSync(OPENCLAW_AUTH_DIR, authDir, { recursive: true });
    logger.info(
      { source: OPENCLAW_AUTH_DIR, destination: authDir },
      'Seeded WhatsApp auth from OpenClaw credentials',
    );
  } catch (err) {
    logger.warn(
      { err, source: OPENCLAW_AUTH_DIR },
      'Failed to seed WhatsApp auth from OpenClaw',
    );
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
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualDisconnect = false;
  private pairingCodeRequested = false;

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.manualDisconnect = false;
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(STORE_DIR, { recursive: true });
    maybeSeedAuthFromOpenClaw(authDir);
    fs.mkdirSync(authDir, { recursive: true });
    this.pairingCodeRequested = false;

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn(
        { err },
        'Failed to fetch latest WA Web version, using default',
      );
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

    // Request pairing code for headless flows even when QR updates are absent.
    if (WHATSAPP_PAIRING_PHONE && !state.creds.registered) {
      this.requestPairingCode();
    }

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        writeArtifact(QR_FILE, qr);
        writeArtifact(AUTH_STATUS_FILE, 'qr_required');
        const msg = `WhatsApp authentication required. QR data saved to ${QR_FILE}`;
        logger.warn(msg);
        if (process.platform === 'darwin') {
          exec(
            `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
          );
        }
        this.requestPairingCode();
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect =
          !this.manualDisconnect && reason !== DisconnectReason.loggedOut;
        logger.info(
          {
            reason,
            shouldReconnect,
            queuedMessages: this.outgoingQueue.length,
          },
          'Connection closed',
        );

        if (shouldReconnect) {
          this.scheduleReconnect();
        } else {
          if (reason === DisconnectReason.loggedOut) {
            writeArtifact(AUTH_STATUS_FILE, 'failed:logged_out');
            logger.info('Logged out. Run /setup to re-authenticate.');
          }
        }
      } else if (connection === 'open') {
        this.connected = true;
        this.reconnectAttempts = 0;
        this.clearReconnectTimer();
        writeArtifact(AUTH_STATUS_FILE, 'authenticated');
        removeArtifact(QR_FILE);
        removeArtifact(PAIRING_CODE_FILE);
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
        try {
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
          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            undefined,
            'whatsapp',
            isGroup,
          );

          // Only deliver full message for registered groups
          const groups = this.opts.registeredGroups();
          if (groups[chatJid]) {
            const content = this.extractMessageContent(msg.message);

            // Skip protocol messages with no text content (encryption keys, read receipts, etc.)
            if (!content) continue;

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
            });
          }
        } catch (err) {
          logger.error(
            { err, remoteJid: msg.key?.remoteJid },
            'Error processing incoming message',
          );
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
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text: prefixed });
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
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

  async syncGroups(force: boolean): Promise<void> {
    return this.syncGroupMetadata(force);
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
      logger.debug(
        { lidJid: jid, phoneJid: cached },
        'Translated LID to phone JID (cached)',
      );
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info(
          { lidJid: jid, phoneJid },
          'Translated LID to phone JID (signalRepository)',
        );
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
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Send directly — queued items are already prefixed by sendMessage
        await this.sock.sendMessage(item.jid, { text: item.text });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }

  private extractMessageContent(message: unknown): string {
    const normalized = normalizeMessageContent(
      message as Parameters<typeof normalizeMessageContent>[0],
    );
    if (!normalized) return '';

    const text =
      normalized.conversation || normalized.extendedTextMessage?.text || '';
    if (text) return text;

    if (normalized.imageMessage) {
      return normalized.imageMessage.caption || '[Image]';
    }
    if (normalized.videoMessage) {
      return normalized.videoMessage.caption || '[Video]';
    }
    if (normalized.audioMessage) {
      return normalized.audioMessage.ptt ? '[Voice note]' : '[Audio]';
    }
    if (normalized.documentMessage) {
      const fileName = normalized.documentMessage.fileName;
      return fileName ? `[Document: ${fileName}]` : '[Document]';
    }
    if (normalized.stickerMessage) {
      return '[Sticker]';
    }

    return '';
  }

  private scheduleReconnect(): void {
    if (this.manualDisconnect) return;
    if (this.reconnectTimer) return;

    const attempt = this.reconnectAttempts + 1;
    const delayMs = Math.min(
      MAX_RECONNECT_DELAY_MS,
      INITIAL_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts = attempt;

    logger.info({ attempt, delayMs }, 'Scheduling WhatsApp reconnect');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectInternal().catch((err) => {
        logger.error({ err, attempt }, 'Reconnect attempt failed');
        this.scheduleReconnect();
      });
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private requestPairingCode(): void {
    if (!WHATSAPP_PAIRING_PHONE || this.pairingCodeRequested) return;
    this.pairingCodeRequested = true;

    setTimeout(() => {
      this.sock
        .requestPairingCode(WHATSAPP_PAIRING_PHONE)
        .then((code) => {
          writeArtifact(PAIRING_CODE_FILE, code);
          writeArtifact(AUTH_STATUS_FILE, `pairing_code:${code}`);
          logger.info(
            {
              pairingPhone: WHATSAPP_PAIRING_PHONE,
              pairingCodeFile: PAIRING_CODE_FILE,
            },
            'WhatsApp pairing code generated for headless auth',
          );
        })
        .catch((err) => {
          this.pairingCodeRequested = false;
          logger.warn({ err }, 'Failed to request WhatsApp pairing code');
        });
    }, 3000);
  }
}

registerChannel('whatsapp', (opts: ChannelOpts) => new WhatsAppChannel(opts));
