import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import makeWASocket, {
  DisconnectReason,
  WAMessage,
  WASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import {
  MAX_OUTGOING_QUEUE_SIZE,
  RECONNECT_INITIAL_DELAY_MS,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_DELAY_MS,
  STORE_DIR,
} from '../config.js';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Well-known JID for the virtual complaint group that all 1:1 messages route to. */
export const VIRTUAL_COMPLAINT_GROUP_JID = 'complaint@virtual';

/** Returns true if the JID represents an individual (1:1) chat.
 * Matches both phone JIDs (@s.whatsapp.net) and LID JIDs (@lid).
 * LID (Linked Device ID) is WhatsApp's newer addressing scheme — messages from
 * contacts not yet in the phone's address book often arrive with @lid JIDs.
 */
export function isIndividualChat(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
}

/** Returns true if the JID represents a group chat. */
export function isGroupChat(jid: string): boolean {
  return jid.endsWith('@g.us');
}

/** Extracts the phone number from an individual JID, or null if not an individual JID.
 * For @lid JIDs, returns the LID user part (not a phone number, but unique per contact).
 * The LID part strips the device suffix (e.g., "186410254491803:0" → "186410254491803").
 */
export function extractPhoneNumber(jid: string): string | null {
  if (!isIndividualChat(jid)) return null;
  const user = jid.split('@')[0];
  // Strip device suffix (e.g., "918600822444:12" → "918600822444")
  return user.split(':')[0];
}

/** Metadata extracted from a Baileys audioMessage. */
export interface AudioMetadata {
  messageId: string;
  senderJid: string;
  senderName: string;
  timestamp: string;
  fileLength: number;
  seconds: number;
  mimetype: string;
  ptt: boolean;
}

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  /** Called when an audio message is received in a 1:1 chat. */
  onAudioMessage?: (chatJid: string, msg: WAMessage, metadata: AudioMetadata) => void;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';
  prefixAssistantName = true;

  private sock!: WASocket;
  private connected = false;
  /** Maps LID user part → phone JID (e.g., "186410254491803" → "918600822444@s.whatsapp.net") */
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  private reconnectAttempts = 0;

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  /** Register a LID-to-phone mapping discovered from Baileys events or auth state. */
  addLidMapping(lidUser: string, phoneJid: string): void {
    if (lidUser && phoneJid && !this.lidToPhoneMap[lidUser]) {
      this.lidToPhoneMap[lidUser] = phoneJid;
      logger.info({ lidUser, phoneJid }, 'New LID-to-phone mapping registered');
    }
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

    this.sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: ['ConstituencyBot', 'Chrome', '1.0.0'],
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        execFile('osascript', [
          '-e',
          `display notification "${msg}" with title "ConstituencyBot" sound name "Basso"`,
        ]);
        setTimeout(() => process.exit(1), 1000);
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
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
        this.reconnectAttempts = 0;
        logger.info('Connected to WhatsApp');

        // Build LID to phone mappings from auth state files.
        // Baileys stores lid-mapping-{lid}_reverse.json files containing the
        // phone number for each LID. Load ALL of them to translate LID JIDs.
        this.loadLidMappingsFromAuthState(authDir);

        // Also set self-mapping from socket user info
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
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

    // Capture LID-to-phone mappings from contact events.
    // When Baileys processes device migration for a new contact, it emits contacts.update
    // or contacts.upsert with the LID and phone number.
    this.sock.ev.on('contacts.update', (updates) => {
      for (const contact of updates) {
        if (contact.lid && contact.id?.endsWith('@s.whatsapp.net')) {
          const lidUser = contact.lid.split('@')[0].split(':')[0];
          this.addLidMapping(lidUser, contact.id);
        }
      }
    });
    this.sock.ev.on('contacts.upsert', (contacts) => {
      for (const contact of contacts) {
        if (contact.lid && contact.id?.endsWith('@s.whatsapp.net')) {
          const lidUser = contact.lid.split('@')[0].split(':')[0];
          this.addLidMapping(lidUser, contact.id);
        }
      }
    });

    this.sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        // Debug: log ALL incoming messages so we can diagnose delivery issues
        logger.debug(
          {
            rawJid,
            fromMe: msg.key.fromMe,
            pushName: msg.pushName,
            hasConversation: !!msg.message?.conversation,
            hasExtended: !!msg.message?.extendedTextMessage,
            messageType: Object.keys(msg.message || {}).join(','),
          },
          'WhatsApp message received',
        );

        // Translate LID JID to phone JID if applicable
        const chatJid = this.translateJid(rawJid);

        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();

        // For 1:1 chats, store metadata with push name for user identification
        if (isIndividualChat(chatJid)) {
          this.opts.onChatMetadata(
            chatJid,
            timestamp,
            msg.pushName || undefined,
          );
        } else {
          // Group or other chat — notify without name (group names come from syncGroupMetadata)
          this.opts.onChatMetadata(chatJid, timestamp);
        }

        // Determine which registered group to route this message to
        const groups = this.opts.registeredGroups();
        let routeJid = chatJid;

        // 1:1 messages route to the virtual complaint group
        if (isIndividualChat(chatJid)) {
          routeJid = VIRTUAL_COMPLAINT_GROUP_JID;
        }

        // Deliver full message if the route target is a registered group
        if (!groups[routeJid]) {
          logger.debug(
            { chatJid, routeJid, registeredJids: Object.keys(groups) },
            'Message from unregistered route, skipping',
          );
        }
        if (groups[routeJid]) {
          // Audio message detection: route to onAudioMessage for 1:1 chats
          // and for group audio replies (audio messages that quote another message)
          const audioMsg = msg.message?.audioMessage;
          if (audioMsg && this.opts.onAudioMessage) {
            const isReply = !!audioMsg.contextInfo?.quotedMessage;
            if (isIndividualChat(chatJid) || isReply) {
              const rawSender = msg.key.participant || msg.key.remoteJid || '';
              const sender = this.translateJid(rawSender);
              const senderName = msg.pushName || sender.split('@')[0];

              this.opts.onAudioMessage(chatJid, msg, {
                messageId: msg.key.id || '',
                senderJid: sender,
                senderName,
                timestamp,
                fileLength: Number(audioMsg.fileLength || 0),
                seconds: audioMsg.seconds || 0,
                mimetype: audioMsg.mimetype || 'audio/ogg; codecs=opus',
                ptt: audioMsg.ptt || false,
              });
              continue; // Don't process as text message
            }
          }

          const content =
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            '';

          // Extract quoted message text from reply context
          // Check both extendedTextMessage and imageMessage/videoMessage contextInfo
          const contextInfo =
            msg.message?.extendedTextMessage?.contextInfo ||
            msg.message?.imageMessage?.contextInfo ||
            msg.message?.videoMessage?.contextInfo;
          const quotedMsg = contextInfo?.quotedMessage;
          const quotedText =
            quotedMsg?.conversation ||
            quotedMsg?.extendedTextMessage?.text ||
            undefined;

          // For 1:1 chats: sender is the JID itself (no participant); name from pushName
          // For groups: sender is the participant (may be LID — translate to phone JID)
          const rawSender = msg.key.participant || msg.key.remoteJid || '';
          const sender = this.translateJid(rawSender);
          const senderName = msg.pushName || sender.split('@')[0];

          this.opts.onMessage(chatJid, {
            id: msg.key.id || '',
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: msg.key.fromMe || false,
            quotedText,
          });
        }
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      this.enqueueOutgoing(jid, text);
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text });
      logger.info({ jid, length: text.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.enqueueOutgoing(jid, text);
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  private enqueueOutgoing(jid: string, text: string): void {
    if (this.flushing) {
      logger.warn({ jid }, 'Dropping re-enqueue during flush to prevent loop');
      return;
    }
    this.outgoingQueue.push({ jid, text });
    if (this.outgoingQueue.length > MAX_OUTGOING_QUEUE_SIZE) {
      const dropped = this.outgoingQueue.length - MAX_OUTGOING_QUEUE_SIZE;
      this.outgoingQueue.splice(0, dropped);
      logger.warn(
        { dropped, queueSize: this.outgoingQueue.length },
        'Outgoing queue exceeded max size, dropped oldest messages',
      );
    } else {
      logger.info(
        { jid, length: text.length, queueSize: this.outgoingQueue.length },
        'Message queued',
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
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      await this.sock.sendPresenceUpdate(
        isTyping ? 'composing' : 'paused',
        jid,
      );
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

  /**
   * Load all LID→phone mappings from Baileys auth state files.
   * Baileys stores `lid-mapping-{lid}_reverse.json` files containing the
   * phone number (as a JSON string) for each LID user.
   */
  private loadLidMappingsFromAuthState(authDir: string): void {
    try {
      const files = fs.readdirSync(authDir);
      let count = 0;
      for (const file of files) {
        // Reverse mapping files: lid-mapping-{lidUser}_reverse.json → phone number
        const reverseMatch = file.match(
          /^lid-mapping-(\d+)_reverse\.json$/,
        );
        if (reverseMatch) {
          const lidUser = reverseMatch[1];
          const content = fs.readFileSync(
            path.join(authDir, file),
            'utf-8',
          );
          const phone = JSON.parse(content) as string;
          if (phone && !this.lidToPhoneMap[lidUser]) {
            this.lidToPhoneMap[lidUser] = `${phone}@s.whatsapp.net`;
            count++;
          }
          continue;
        }

        // Forward mapping files: lid-mapping-{phone}.json → LID user
        const forwardMatch = file.match(/^lid-mapping-(\d+)\.json$/);
        if (forwardMatch) {
          const phone = forwardMatch[1];
          const content = fs.readFileSync(
            path.join(authDir, file),
            'utf-8',
          );
          const lidUser = JSON.parse(content) as string;
          if (lidUser && !this.lidToPhoneMap[lidUser]) {
            this.lidToPhoneMap[lidUser] = `${phone}@s.whatsapp.net`;
            count++;
          }
        }
      }
      if (count > 0) {
        logger.info(
          { count, total: Object.keys(this.lidToPhoneMap).length },
          'Loaded LID-to-phone mappings from auth state',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load LID mappings from auth state');
    }
  }

  /**
   * Translate a @lid JID to a @s.whatsapp.net phone JID if possible.
   * LID (Linked Device ID) is WhatsApp's newer addressing scheme. Messages from
   * contacts not in the phone's address book often arrive with @lid JIDs.
   *
   * Falls back to the original JID if no mapping is found (the JID is still
   * routable since isIndividualChat now accepts @lid).
   */
  private translateJid(jid: string): string {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];
    const phoneJid = this.lidToPhoneMap[lidUser];
    if (phoneJid) {
      logger.debug({ lidJid: jid, phoneJid }, 'Translated LID to phone JID');
      return phoneJid;
    }

    // Try to resolve by scanning auth state for matching sessions.
    // Baileys stores signal sessions keyed by JID — if there's a phone JID session
    // that was migrated from this LID, the auth state directory will have both.
    try {
      const authDir = path.join(STORE_DIR, 'auth');
      if (fs.existsSync(authDir)) {
        const files = fs.readdirSync(authDir);
        // Look for a session file that maps to this LID
        // Baileys v7 stores: pre-key-PHONE.json and pre-key-LID.json etc.
        // Look for any file containing the LID user to find the paired phone
        for (const file of files) {
          if (file.includes(lidUser) && file.endsWith('.json')) {
            // Found a file for this LID — now check for phone-based sessions
            // by looking at the sender-key-memory or session files
            const prefix = file.split('-')[0]; // e.g., "session", "pre-key"
            const phoneSessions = files.filter(
              (f) =>
                f.startsWith(prefix) &&
                f.endsWith('.json') &&
                !f.includes(lidUser) &&
                !f.includes('@lid'),
            );
            // This heuristic is imperfect; just log for now
            logger.debug(
              { lidUser, lidJid: jid, authFiles: phoneSessions.length },
              'LID JID not in map, checked auth state',
            );
            break;
          }
        }
      }
    } catch {
      // Auth state scan failed, continue with original JID
    }

    logger.info(
      { lidJid: jid, lidUser },
      'Could not translate LID to phone JID — using LID as individual chat',
    );
    return jid;
  }

  private reconnectWithBackoff(): void {
    this.reconnectAttempts++;
    if (this.reconnectAttempts > RECONNECT_MAX_ATTEMPTS) {
      logger.error(
        { attempts: this.reconnectAttempts - 1 },
        'Exhausted all reconnection attempts, exiting for launchd restart',
      );
      process.exit(1);
    }
    const delay = Math.min(
      RECONNECT_INITIAL_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS,
    );
    logger.info(
      { attempt: this.reconnectAttempts, maxAttempts: RECONNECT_MAX_ATTEMPTS, delayMs: delay },
      'Reconnecting with backoff',
    );
    setTimeout(() => {
      this.connectInternal().catch((err) => {
        logger.error({ err, attempt: this.reconnectAttempts }, 'Reconnection attempt failed');
        this.reconnectWithBackoff();
      });
    }, delay);
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
}
