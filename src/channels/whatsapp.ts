import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  WASocket,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  GROUPS_DIR,
  STORE_DIR,
} from '../config.js';
import {
  getLastGroupSync,
  findMembersByName,
  getRegisteredGroup,
  setLastGroupSync,
  updateChatName,
} from '../db.js';
import { isImageMessage, processImage } from '../image.js';
import { logger } from '../logger.js';
import { isVoiceMessage, transcribeAudioMessage } from '../transcription.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

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
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<
    | { kind: 'text'; jid: string; text: string }
    | { kind: 'image'; jid: string; filePath: string; caption: string }
    | { kind: 'video'; jid: string; filePath: string; caption: string }
    | { kind: 'sticker'; jid: string; filePath: string }
  > = [];
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

    // Use pairing code when phone number is provided (more reliable than QR for remote setups)
    const phoneNumber = process.env.WHATSAPP_PHONE_NUMBER;
    if (phoneNumber && !state.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await this.sock.requestPairingCode(
            phoneNumber.replace(/[^0-9]/g, ''),
          );
          logger.info({ code }, `PAIRING CODE: ${code}`);
          const pairingFile = path.join(STORE_DIR, 'pairing-code.txt');
          fs.writeFileSync(pairingFile, code);
        } catch (err) {
          logger.error({ err }, 'Failed to request pairing code');
        }
      }, 3000);
    }

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        // Write QR data to file so external scripts can display it
        const qrFile = path.join(STORE_DIR, 'qr-code.txt');
        fs.writeFileSync(qrFile, qr);
        logger.info('WhatsApp QR code written to store/qr-code.txt');

        if (!phoneNumber && !process.env.WHATSAPP_RECONNECT_MODE) {
          const msg =
            'WhatsApp authentication required. Run /setup in Claude Code.';
          logger.error(msg);
          exec(
            `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
          );
          setTimeout(() => process.exit(1), 1000);
        }
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
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
          this.scheduleReconnect(1);
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
        try {
          if (!msg.message) continue;
          // Unwrap container types (viewOnceMessageV2, ephemeralMessage,
          // editedMessage, etc.) so that conversation, extendedTextMessage,
          // imageMessage, etc. are accessible at the top level.
          const normalized = normalizeMessageContent(msg.message);
          if (!normalized) continue;
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
            let content =
              normalized.conversation ||
              normalized.extendedTextMessage?.text ||
              normalized.imageMessage?.caption ||
              normalized.videoMessage?.caption ||
              '';

            // Prepend quoted message context when replying to a message
            const contextInfo =
              normalized.extendedTextMessage?.contextInfo ||
              normalized.imageMessage?.contextInfo ||
              normalized.videoMessage?.contextInfo ||
              normalized.documentMessage?.contextInfo;
            const quoted = contextInfo?.quotedMessage;
            if (quoted) {
              const quotedNorm = normalizeMessageContent(quoted);
              const quotedText =
                quotedNorm?.conversation ||
                quotedNorm?.extendedTextMessage?.text ||
                quotedNorm?.imageMessage?.caption ||
                quotedNorm?.videoMessage?.caption ||
                quotedNorm?.documentMessage?.caption ||
                '';
              if (quotedText) {
                const quotedParticipant = contextInfo.participant;
                const quotedName = quotedParticipant
                  ? quotedParticipant.replace(/@s\.whatsapp\.net$/, '')
                  : 'unknown';
                content = `> ${quotedName}: ${quotedText}\n\n${content}`;
              }
            }

            // Image attachment handling
            if (isImageMessage(msg)) {
              try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const groupDir = path.join(GROUPS_DIR, groups[chatJid].folder);
                const caption = normalized?.imageMessage?.caption ?? '';
                const result = await processImage(
                  buffer as Buffer,
                  groupDir,
                  caption,
                );
                if (result) {
                  content = result.content;
                }
              } catch (err) {
                logger.warn({ err, jid: chatJid }, 'Image - download failed');
              }
            }

            // Voice message transcription + save audio file
            if (isVoiceMessage(msg)) {
              try {
                // Save the audio file to attachments for voice cloning
                const audioBuffer = await downloadMediaMessage(
                  msg,
                  'buffer',
                  {},
                );
                const groupDir = path.join(GROUPS_DIR, groups[chatJid].folder);
                const attachDir = path.join(groupDir, 'attachments');
                fs.mkdirSync(attachDir, { recursive: true });
                const audioFilename = `voice-${Date.now()}.ogg`;
                const audioPath = path.join(attachDir, audioFilename);
                fs.writeFileSync(audioPath, audioBuffer as Buffer);
                const sizeKB = Math.round(
                  (audioBuffer as Buffer).length / 1024,
                );
                logger.info(
                  { jid: chatJid, audioFilename, sizeKB },
                  'Saved voice message audio file',
                );

                const transcript = await transcribeAudioMessage(msg, this.sock);
                if (transcript) {
                  content = `[Voice: ${transcript}]\n[Audio file: attachments/${audioFilename} (${sizeKB}KB)]`;
                } else {
                  content = `[Voice Message]\n[Audio file: attachments/${audioFilename} (${sizeKB}KB)]`;
                }
              } catch (err) {
                logger.warn(
                  { err, jid: chatJid },
                  'Voice transcription failed',
                );
              }
            }

            // Document attachment handling (PDF, text files, markdown, etc.)
            if (normalized?.documentMessage) {
              try {
                const mime = normalized.documentMessage.mimetype || '';
                const fileName = normalized.documentMessage.fileName || '';
                const ext = path.extname(fileName).toLowerCase();
                const isText =
                  mime.startsWith('text/') ||
                  [
                    '.md',
                    '.txt',
                    '.csv',
                    '.json',
                    '.xml',
                    '.yaml',
                    '.yml',
                    '.toml',
                    '.ini',
                    '.log',
                  ].includes(ext);
                const isPdf = mime === 'application/pdf' || ext === '.pdf';
                const isMedia =
                  mime.startsWith('video/') ||
                  mime.startsWith('audio/') ||
                  [
                    '.mp4',
                    '.mp3',
                    '.ogg',
                    '.wav',
                    '.m4a',
                    '.webm',
                    '.mov',
                    '.avi',
                  ].includes(ext);

                if (isPdf || isText || isMedia) {
                  const buffer = await downloadMediaMessage(msg, 'buffer', {});
                  const groupDir = path.join(
                    GROUPS_DIR,
                    groups[chatJid].folder,
                  );
                  const attachDir = path.join(groupDir, 'attachments');
                  fs.mkdirSync(attachDir, { recursive: true });
                  const filename = path.basename(
                    fileName ||
                      `doc-${Date.now()}${isPdf ? '.pdf' : ext || '.txt'}`,
                  );
                  const filePath = path.join(attachDir, filename);
                  fs.writeFileSync(filePath, buffer as Buffer);
                  const sizeKB = Math.round((buffer as Buffer).length / 1024);
                  const caption = normalized.documentMessage.caption || '';

                  if (isPdf) {
                    const pdfRef = `[PDF: attachments/${filename} (${sizeKB}KB)]\nUse: pdf-reader extract attachments/${filename}`;
                    content = caption ? `${caption}\n\n${pdfRef}` : pdfRef;
                  } else if (isMedia) {
                    const mediaType = mime.startsWith('video/')
                      ? 'Video'
                      : 'Audio';
                    const mediaRef = `[${mediaType}: attachments/${filename} (${sizeKB}KB)]`;
                    content = caption ? `${caption}\n\n${mediaRef}` : mediaRef;
                  } else {
                    const textContent = (buffer as Buffer).toString('utf-8');
                    const docRef = `[Document: attachments/${filename} (${sizeKB}KB)]\n\n${textContent}`;
                    content = caption ? `${caption}\n\n${docRef}` : docRef;
                  }
                  logger.info(
                    { jid: chatJid, filename, mime },
                    'Downloaded document attachment',
                  );
                }
              } catch (err) {
                logger.warn(
                  { err, jid: chatJid },
                  'Failed to download document attachment',
                );
              }
            }

            // Sticker handling — download, save for reuse, and process for vision
            if (normalized?.stickerMessage) {
              try {
                const buffer = await downloadMediaMessage(msg, 'buffer', {});
                const groupDir = path.join(GROUPS_DIR, groups[chatJid].folder);
                const stickerDir = path.join(groupDir, 'stickers');
                fs.mkdirSync(stickerDir, { recursive: true });
                const filename = `sticker-${Date.now()}.webp`;
                const filePath = path.join(stickerDir, filename);
                fs.writeFileSync(filePath, buffer as Buffer);
                // Process sticker through vision pipeline so agent can see it
                const visionResult = await processImage(
                  buffer as Buffer,
                  groupDir,
                  '',
                );
                content = visionResult
                  ? `[Sticker: stickers/${filename}] ${visionResult.content}`
                  : `[Sticker: stickers/${filename}]`;
                logger.info({ jid: chatJid, filename }, 'Sticker saved');
              } catch (err) {
                logger.warn({ err, jid: chatJid }, 'Sticker download failed');
              }
            }

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

    // Receive reactions from other users
    this.sock.ev.on('messages.reaction', (reactions) => {
      for (const { key, reaction } of reactions) {
        try {
          const rawJid = key.remoteJid;
          if (!rawJid || rawJid === 'status@broadcast') continue;

          const emoji = reaction.text || '';
          // Empty text means reaction was removed — skip
          if (!emoji) continue;

          const chatJid = rawJid; // reactions don't use LID JIDs
          const groups = this.opts.registeredGroups();
          if (!groups[chatJid]) continue;

          const senderName =
            reaction.key?.participant?.split('@')[0] || 'unknown';
          const reactedMsgId = reaction.key?.id || '';
          const timestamp = new Date().toISOString();

          this.opts.onMessage(chatJid, {
            id: `reaction-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            chat_jid: chatJid,
            sender: reaction.key?.participant || '',
            sender_name: senderName,
            content: `[Reaction: ${emoji} on message ${reactedMsgId} by ${senderName}]`,
            timestamp,
            is_from_me: false,
            is_bot_message: false,
          });
        } catch (err) {
          logger.error({ err }, 'Error processing reaction');
        }
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Prefix bot messages so users know who's speaking.
    // Use the group's trigger as display name (e.g. "@mobi" → "mobi:"),
    // falling back to the global ASSISTANT_NAME.
    // Skip prefix when the assistant has its own dedicated phone number.
    let displayName = ASSISTANT_NAME;
    const group = getRegisteredGroup(jid);
    if (group?.trigger) {
      displayName = group.trigger.replace(/^@/, '');
    }
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${displayName}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ kind: 'text', jid, text: prefixed });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return;
    }
    // Resolve @mentions to JIDs for real WhatsApp tagging
    const mentionMatches = prefixed.match(/@[\w\u00C0-\u024F]+/g);
    let mentions: string[] | undefined;
    if (mentionMatches && jid.endsWith('@g.us')) {
      const names = mentionMatches.map((m) => m.slice(1).toLowerCase());
      const dbMembers = findMembersByName(jid, names);
      logger.debug(
        {
          mentionMatches,
          names,
          jid,
          dbMembersCount: dbMembers.length,
          dbMembers,
        },
        'Mention resolution',
      );
      if (dbMembers.length > 0) {
        // Translate LID JIDs to phone JIDs for real WhatsApp mentions
        const resolved = await Promise.all(
          dbMembers.map((m) => this.translateJid(m.jid)),
        );
        mentions = resolved.filter((j) => j.endsWith('@s.whatsapp.net'));
        // If no phone JIDs resolved, try LID JIDs directly as fallback
        if (mentions.length === 0) {
          mentions = dbMembers.map((m) => m.jid);
        }
        logger.debug({ resolved, mentions }, 'Mention JIDs after translation');
      }
    }

    try {
      await this.sock.sendMessage(jid, { text: prefixed, mentions });
      logger.info(
        { jid, length: prefixed.length, mentions: mentions?.length ?? 0 },
        'Message sent',
      );
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ kind: 'text', jid, text: prefixed });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  async sendImage(
    jid: string,
    filePath: string,
    caption: string,
  ): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ kind: 'image', jid, filePath, caption });
      logger.info({ jid, filePath }, 'WA disconnected, image queued');
      return;
    }
    try {
      const buffer = fs.readFileSync(filePath);
      await this.sock.sendMessage(jid, { image: buffer, caption });
      logger.info({ jid, filePath }, 'Image sent');
    } catch (err) {
      this.outgoingQueue.push({ kind: 'image', jid, filePath, caption });
      logger.warn({ jid, filePath, err }, 'Failed to send image, queued');
    }
  }

  async sendVideo(
    jid: string,
    filePath: string,
    caption: string,
  ): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ kind: 'video', jid, filePath, caption });
      logger.info({ jid, filePath }, 'WA disconnected, video queued');
      return;
    }
    try {
      const buffer = fs.readFileSync(filePath);
      await this.sock.sendMessage(jid, { video: buffer, caption });
      logger.info({ jid, filePath }, 'Video sent');
    } catch (err) {
      this.outgoingQueue.push({ kind: 'video', jid, filePath, caption });
      logger.warn({ jid, filePath, err }, 'Failed to send video, queued');
    }
  }

  async sendSticker(jid: string, filePath: string): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ kind: 'sticker', jid, filePath });
      logger.info({ jid, filePath }, 'WA disconnected, sticker queued');
      return;
    }
    try {
      const buffer = fs.readFileSync(filePath);
      await this.sock.sendMessage(jid, { sticker: buffer });
      logger.info({ jid, filePath }, 'Sticker sent');
    } catch (err) {
      this.outgoingQueue.push({ kind: 'sticker', jid, filePath });
      logger.warn({ jid, filePath, err }, 'Failed to send sticker, queued');
    }
  }

  async sendDocument(
    jid: string,
    filePath: string,
    filename: string,
    caption: string,
  ): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid, filePath }, 'WA disconnected, document dropped');
      return;
    }
    try {
      const buffer = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mimeMap: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx':
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xlsx':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.csv': 'text/csv',
        '.txt': 'text/plain',
      };
      const mimetype = mimeMap[ext] || 'application/octet-stream';
      await this.sock.sendMessage(jid, {
        document: buffer,
        mimetype,
        fileName: filename,
        caption,
      });
      logger.info({ jid, filePath, filename }, 'Document sent');
    } catch (err) {
      logger.warn({ jid, filePath, err }, 'Failed to send document');
    }
  }

  async sendAudio(jid: string, filePath: string): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid, filePath }, 'WA disconnected, audio dropped');
      return;
    }
    try {
      const buffer = fs.readFileSync(filePath);
      await this.sock.sendMessage(jid, {
        audio: buffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
      });
      logger.info({ jid, filePath }, 'Audio sent');
    } catch (err) {
      logger.warn({ jid, filePath, err }, 'Failed to send audio');
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

  async sendReaction(
    jid: string,
    messageId: string,
    emoji: string,
    participant?: string,
  ): Promise<void> {
    if (!this.connected) {
      logger.warn(
        { jid, messageId, emoji },
        'WA disconnected, reaction dropped',
      );
      return;
    }
    try {
      await this.sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: { remoteJid: jid, id: messageId, participant },
        },
      });
      logger.info({ jid, messageId, emoji }, 'Reaction sent');
    } catch (err) {
      logger.warn({ jid, messageId, emoji, err }, 'Failed to send reaction');
    }
  }

  async getInviteLink(jid: string): Promise<string | null> {
    if (!this.connected) return null;
    try {
      const code = await this.sock.groupInviteCode(jid);
      return code ? `https://chat.whatsapp.com/${code}` : null;
    } catch (err) {
      logger.warn({ jid, err }, 'Failed to get group invite code');
      return null;
    }
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

  async updateProfilePicture(jid: string, filePath: string): Promise<void> {
    if (!this.connected) {
      logger.warn(
        { jid, filePath },
        'WA disconnected, profile picture update dropped',
      );
      return;
    }
    const buffer = fs.readFileSync(filePath);
    await this.sock.updateProfilePicture(jid, buffer);
    logger.info({ jid }, 'Profile picture updated');
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

  private scheduleReconnect(attempt: number): void {
    const delayMs = Math.min(5000 * Math.pow(2, attempt - 1), 300000);
    logger.info({ attempt, delayMs }, 'Reconnecting...');
    setTimeout(() => {
      this.connectInternal().catch((err) => {
        logger.error({ err, attempt }, 'Reconnection attempt failed');
        this.scheduleReconnect(attempt + 1);
      });
    }, delayMs);
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
        if (item.kind === 'image') {
          const buffer = fs.readFileSync(item.filePath);
          await this.sock.sendMessage(item.jid, {
            image: buffer,
            caption: item.caption,
          });
          logger.info(
            { jid: item.jid, filePath: item.filePath },
            'Queued image sent',
          );
        } else if (item.kind === 'video') {
          const buffer = fs.readFileSync(item.filePath);
          await this.sock.sendMessage(item.jid, {
            video: buffer,
            caption: item.caption,
          });
          logger.info(
            { jid: item.jid, filePath: item.filePath },
            'Queued video sent',
          );
        } else if (item.kind === 'sticker') {
          const buffer = fs.readFileSync(item.filePath);
          await this.sock.sendMessage(item.jid, { sticker: buffer });
          logger.info(
            { jid: item.jid, filePath: item.filePath },
            'Queued sticker sent',
          );
        } else {
          await this.sock.sendMessage(item.jid, { text: item.text });
          logger.info(
            { jid: item.jid, length: item.text.length },
            'Queued message sent',
          );
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}

registerChannel('whatsapp', (opts: ChannelOpts) => new WhatsAppChannel(opts));
