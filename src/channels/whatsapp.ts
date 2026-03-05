import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  WASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  GROUPS_DIR,
  STORE_DIR,
} from '../config.js';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { logger } from '../logger.js';
import { isVoiceMessage, transcribeAudio } from '../transcription.js';
import {
  Channel,
  HealthInfo,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private lastConnectedAt: string | null = null;
  private disconnectLog: Array<{ reason: number; at: string }> = [];
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

    // Fetch latest WA Web version — required with Baileys from GitHub main
    // to avoid 405 errors from outdated default version
    const { version } = await fetchLatestWaWebVersion({});
    logger.info({ version }, 'Using WA Web version');

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
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
        const reason =
          (lastDisconnect?.error as { output?: { statusCode?: number } })
            ?.output?.statusCode ?? 0;
        this.disconnectLog.push({ reason, at: new Date().toISOString() });
        if (this.disconnectLog.length > 20) this.disconnectLog.shift();
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info(
          {
            reason,
            shouldReconnect,
            queuedMessages: this.outgoingQueue.length,
          },
          'Connection closed',
        );

        if (shouldReconnect) {
          this.reconnectWithBackoff();
        } else {
          logger.info('Logged out. Run /setup to re-authenticate.');
          process.exit(0);
        }
      } else if (connection === 'open') {
        this.connected = true;
        this.lastConnectedAt = new Date().toISOString();
        this.reconnectAttempt = 0; // Reset backoff on successful connection
        logger.info('Connected to WhatsApp');

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch(() => {});

        // Start periodic presence pings to reduce 428 keepalive disconnects
        this.startPresencePings();

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
        this.opts.onChatMetadata(chatJid, timestamp);

        // Validate JID format
        if (
          !chatJid.endsWith('@g.us') &&
          !chatJid.endsWith('@s.whatsapp.net') &&
          !chatJid.endsWith('@lid')
        ) {
          logger.debug({ chatJid }, 'Ignoring message with invalid JID format');
          continue;
        }

        // Only deliver full message for registered groups
        const groups = this.opts.registeredGroups();
        if (groups[chatJid]) {
          let content =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            '';

          const sender = msg.key.participant || msg.key.remoteJid || '';
          const senderName = msg.pushName || sender.split('@')[0];
          const fromMe = msg.key.fromMe || false;
          const group = groups[chatJid];

          // Voice message transcription
          if (isVoiceMessage(msg)) {
            try {
              const buffer = (await downloadMediaMessage(
                msg,
                'buffer',
                {},
              )) as Buffer;
              if (buffer.length > 25 * 1024 * 1024) {
                logger.warn(
                  { size: buffer.length },
                  'Voice message too large (>25MB), skipping transcription',
                );
                content = '[Voice message — too large for transcription]';
              } else {
                const transcript = await transcribeAudio(buffer, 'audio/ogg');
                if (transcript) {
                  content = `[Voice: ${transcript}]`;
                } else {
                  content = '[Voice message — transcription unavailable]';
                }
              }
            } catch (err) {
              logger.debug({ err }, 'Failed to download voice message');
              content = '[Voice message — download failed]';
            }
          }

          // Image message: download and save to group media folder
          if (msg.message?.imageMessage && !content) {
            try {
              const buffer = (await downloadMediaMessage(
                msg,
                'buffer',
                {},
              )) as Buffer;
              const mediaDir = path.join(GROUPS_DIR, group.folder, 'media');
              fs.mkdirSync(mediaDir, { recursive: true });
              const filename = `img-${Date.now()}.jpg`;
              fs.writeFileSync(path.join(mediaDir, filename), buffer);
              const caption =
                (msg.message.imageMessage as { caption?: string }).caption ||
                '';
              content = `[Image: /workspace/group/media/${filename}]${caption ? ` ${caption}` : ''}`;
            } catch (err) {
              logger.debug({ err }, 'Failed to download image');
              content = '[Image — download failed]';
            }
          }

          // Document message: download and save to group media folder
          if (msg.message?.documentMessage) {
            try {
              const buffer = (await downloadMediaMessage(
                msg,
                'buffer',
                {},
              )) as Buffer;
              const mediaDir = path.join(GROUPS_DIR, group.folder, 'media');
              fs.mkdirSync(mediaDir, { recursive: true });
              const rawName =
                (msg.message.documentMessage as { fileName?: string })
                  .fileName || 'document';
              const origName = path.basename(rawName);
              const filename = `doc-${Date.now()}-${origName}`;
              fs.writeFileSync(path.join(mediaDir, filename), buffer);
              content = `[Document: /workspace/group/media/${filename}]`;
            } catch (err) {
              logger.debug({ err }, 'Failed to download document');
              content = '[Document — download failed]';
            }
          }

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
      // Cap queue at 100 messages to prevent memory leak during extended disconnects
      if (this.outgoingQueue.length > 100) {
        const dropped = this.outgoingQueue.shift();
        logger.warn({ jid: dropped?.jid, queueSize: this.outgoingQueue.length }, 'Queue cap exceeded, dropped oldest message');
      }
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

  /**
   * Reconnect with exponential backoff. Retries indefinitely, capping at 5 min.
   */
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;

  private reconnectWithBackoff(): void {
    this.reconnectAttempt++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempt - 1), 300000); // 1s, 2s, 4s, ... 5min cap
    logger.info(
      { attempt: this.reconnectAttempt, delayMs: delay },
      'Reconnecting with backoff...',
    );
    this.reconnectTimer = setTimeout(() => {
      this.connectInternal().catch((err) => {
        logger.error({ err, attempt: this.reconnectAttempt }, 'Reconnect failed, will retry');
        this.reconnectWithBackoff();
      });
    }, delay);
  }

  /**
   * Start periodic presence pings to reduce 428 keepalive disconnects.
   */
  private startPresencePings(): void {
    if (this.presenceTimer) return;
    this.presenceTimer = setInterval(() => {
      if (this.connected) {
        this.sock.sendPresenceUpdate('available').catch(() => {});
      }
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
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
   * Get health information for monitoring.
   */
  getHealthInfo(): HealthInfo {
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const recentErrors = this.disconnectLog.filter(
      (d) =>
        new Date(d.at).getTime() > tenMinAgo &&
        (d.reason === 405 || d.reason === 515),
    );
    return {
      connected: this.connected,
      lastConnectedAt: this.lastConnectedAt,
      recentDisconnects: [...this.disconnectLog],
      protocolErrorCount: recentErrors.length,
    };
  }

  /**
   * Force a full reconnect — re-fetches WA version to heal protocol mismatches.
   */
  async forceReconnect(): Promise<void> {
    logger.info('Force reconnect requested by health monitor');
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignore */
    }
    this.connected = false;
    await this.connectInternal();
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
      const pn = await (
        this.sock.signalRepository as any
      )?.lidMapping?.getPNForLID(jid);
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
        const item = this.outgoingQueue[0]; // peek, don't shift yet
        try {
          await this.sock.sendMessage(item.jid, { text: item.text });
          this.outgoingQueue.shift(); // only remove after successful send
          logger.info(
            { jid: item.jid, length: item.text.length },
            'Queued message sent',
          );
        } catch (err) {
          // Send failed — stop flushing, keep remaining messages for next reconnect
          logger.warn(
            { jid: item.jid, err, remaining: this.outgoingQueue.length },
            'Queue flush failed, will retry on next reconnect',
          );
          break;
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
