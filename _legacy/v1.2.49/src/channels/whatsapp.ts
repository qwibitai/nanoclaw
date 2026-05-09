import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import https from 'https';

import {
  Browsers,
  DisconnectReason,
  WAMessage,
  WASocket,
  downloadMediaMessage,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import { ASSISTANT_HAS_OWN_NUMBER, ASSISTANT_NAME, STORE_DIR } from '../config.js';
import { resolveGroupIpcPath } from '../group-folder.js';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata, RegisteredGroup } from '../types.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const WA_VERSION_URL =
  'https://raw.githubusercontent.com/WhiskeySockets/Baileys/master/src/Defaults/baileys-version.json';
const SENDFILE_TIMEOUT_MS = 60_000;

function fetchWaVersion(): Promise<[number, number, number] | undefined> {
  return new Promise((resolve) => {
    https
      .get(WA_VERSION_URL, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', (chunk: string) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data).version);
          } catch {
            resolve(undefined);
          }
        });
      })
      .on('error', () => resolve(undefined));
  });
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

    // Fetch current WhatsApp Web version so the server doesn't reject us (405)
    const version = await fetchWaVersion();

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger as any),
      },
      printQRInTerminal: false,
      logger: logger as any,
      browser: Browsers.macOS('Chrome'),
      // Defense-in-depth (jibot-code-5m2): default is 60_000ms which trips for
      // every Baileys init-query bundle when transient event-loop pressure
      // (e.g. the Email-channel maxBuffer overflow tracked in jibot-code-r8y)
      // delays IQ response handling. Doubling the budget absorbs those stalls
      // without changing semantics. Real fix is in r8y; this is belt-and-braces.
      defaultQueryTimeoutMs: 120_000,
      ...(version && { version }),
    });

    this.sock.ev.on('connection.update', (update: any) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg = 'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(`osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`);
        // Gracefully disable WhatsApp instead of crashing the entire process
        this.connected = false;
        try {
          this.sock?.end?.(undefined);
        } catch {}
        if (onFirstOpen) onFirstOpen(); // unblock startup
        onFirstOpen = undefined;
        return;
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        const shouldReconnect = reason !== DisconnectReason.loggedOut;
        logger.info({ reason, shouldReconnect, queuedMessages: this.outgoingQueue.length }, 'Connection closed');

        // Unblock startup so other channels can initialize while WA retries
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }

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
        this.sock.sendPresenceUpdate('available').catch((err: any) => {
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
        this.flushOutgoingQueue().catch((err) => logger.error({ err }, 'Failed to flush outgoing queue'));

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) => logger.error({ err }, 'Initial group sync failed'));
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) => logger.error({ err }, 'Periodic group sync failed'));
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

    this.sock.ev.on('messages.upsert', async ({ messages }: { messages: any[] }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        const msgTypes = Object.keys(msg.message).join(',');
        logger.info({ rawJid, msgTypes, fromMe: msg.key.fromMe }, 'WA incoming message');

        // Translate LID JID to phone JID if applicable
        const chatJid = await this.translateJid(rawJid);
        const groups = this.opts.registeredGroups();
        logger.info({ rawJid, chatJid, registered: !!groups[chatJid] }, 'WA JID check');

        const timestamp = new Date(Number(msg.messageTimestamp) * 1000).toISOString();

        // Always notify about chat metadata for group discovery
        const isGroup = chatJid.endsWith('@g.us');
        this.opts.onChatMetadata(chatJid, timestamp, undefined, 'whatsapp', isGroup);

        // Only deliver full message for registered groups
        if (groups[chatJid]) {
          // Extract text content from various message types
          // Strip Unicode directional isolation marks (U+2068 FSI / U+2069 PDI)
          // that WhatsApp wraps around @mention names — e.g. "@⁨jibot⁩" → "@jibot"
          const stripMentionMarks = (s: string) => s.replace(/[\u2068\u2069]/g, '');
          let content = stripMentionMarks(
            msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption ||
              '',
          );

          // Translate LID mentions to display names.
          // WhatsApp @mentions are encoded as @{LID_USER} in message text
          // (e.g., "@39304034308253" instead of "@jibot"). Replace jibot's
          // own LID mention so the trigger pattern "@jibot" matches.
          if (this.sock.user?.lid) {
            const selfLidUser = this.sock.user.lid.split(':')[0];
            if (selfLidUser && content.includes('@' + selfLidUser)) {
              content = content.replace(new RegExp('@' + selfLidUser, 'g'), '@jibot');
            }
          }

          // Handle media messages: documents, images, video, audio
          const docMsg =
            msg.message?.documentMessage || msg.message?.documentWithCaptionMessage?.message?.documentMessage;
          const imgMsg = msg.message?.imageMessage;
          const vidMsg = msg.message?.videoMessage;
          const audioMsg = msg.message?.audioMessage;
          const hasMedia = !!(docMsg || imgMsg || vidMsg || audioMsg);

          if (hasMedia) {
            const fileName =
              (docMsg as any)?.fileName ||
              (imgMsg ? 'image.jpg' : vidMsg ? 'video.mp4' : audioMsg ? 'audio.ogg' : 'file');
            const mimeType = (docMsg || imgMsg || vidMsg || audioMsg)?.mimetype || 'application/octet-stream';
            const caption =
              (docMsg as any)?.caption ||
              msg.message?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
              imgMsg?.caption ||
              vidMsg?.caption ||
              '';

            if (!content && caption) content = caption;

            // Download and save media file for registered groups
            if (groups[chatJid]) {
              try {
                const buffer = (await downloadMediaMessage(msg as WAMessage, 'buffer', {})) as Buffer;
                if (buffer && buffer.length > 0) {
                  const group = groups[chatJid];
                  const ipcPath = resolveGroupIpcPath(group.folder);
                  const inputDir = path.join(ipcPath, 'input');
                  fs.mkdirSync(inputDir, { recursive: true });
                  const safeName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
                  fs.writeFileSync(path.join(inputDir, safeName), buffer);
                  const sizeStr =
                    buffer.length > 1024 * 1024
                      ? `${(buffer.length / (1024 * 1024)).toFixed(1)}MB`
                      : `${(buffer.length / 1024).toFixed(1)}KB`;
                  const annotation = `[Attached: ${fileName} (${mimeType}, ${sizeStr}) \u2014 saved to /workspace/ipc/input/${safeName}]`;
                  content = content ? `${content}\n${annotation}` : annotation;
                  logger.info({ chatJid, filename: safeName, size: buffer.length, mimeType }, 'WA media saved');
                }
              } catch (err) {
                logger.warn({ chatJid, fileName, err }, 'Failed to download WA media');
                const annotation = `[Attached: ${fileName} (${mimeType}) \u2014 download failed]`;
                content = content ? `${content}\n${annotation}` : annotation;
              }
            } else {
              // Unregistered - just note the document
              if (!content) content = `[Document: ${fileName} (${mimeType})]`;
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
          const isBotMessage = ASSISTANT_HAS_OWN_NUMBER ? fromMe : content.startsWith(`${ASSISTANT_NAME}:`);

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

  async sendFile(jid: string, filePath: string, filename: string, mimetype: string, caption?: string): Promise<void> {
    if (!this.connected) {
      throw new Error('WhatsApp disconnected; cannot send file');
    }
    let timer: NodeJS.Timeout;
    // ⚠️ DO NOT PORT THIS PATTERN AS-IS — see nanoclaw-dou (P2).
    // `{ document: { url: filePath } }` deterministically hangs Baileys 6.6.0:
    // sendMessage logs `fetched media stream` and never resolves. Verified on
    // jibotmac 2026-04-30 across every WhatsApp document send.
    // When porting sendFile to the v2 channel adapter, use:
    //   { document: fs.readFileSync(filePath) }              // small files
    //   { document: { stream: fs.createReadStream(filePath) } }  // large files
    // The fix lives on origin/fix/sendfile-buffer (commit fbdfe1d) for reference.
    const sendPromise = this.sock.sendMessage(jid, {
      document: { url: filePath },
      fileName: filename,
      mimetype,
      caption,
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `WhatsApp sendFile timed out after ${SENDFILE_TIMEOUT_MS / 1000}s for jid=${jid} filename=${filename}`,
            ),
          ),
        SENDFILE_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([sendPromise, timeoutPromise]);
      logger.info({ jid, filename, mimetype, captionLen: caption?.length }, 'WA file sent');
    } catch (err) {
      logger.error({ jid, filename, err }, 'Failed to send WA file');
      throw err;
    } finally {
      clearTimeout(timer!);
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = ASSISTANT_HAS_OWN_NUMBER ? text : `${ASSISTANT_NAME}: ${text}`;

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
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send, message queued');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
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
      for (const [jid, metadata] of Object.entries(groups) as [string, any][]) {
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
      const pn = await (this.sock.signalRepository as any)?.lidMapping?.getPNForLID(jid);
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
