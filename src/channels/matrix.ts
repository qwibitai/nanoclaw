import fs from 'fs';
import path from 'path';

// Polyfill IndexedDB for Node.js — the matrix-sdk-crypto-wasm Rust crypto
// store requires an IndexedDB implementation. Must be imported before
// matrix-js-sdk so globalThis.indexedDB is available when the WASM module loads.
import 'fake-indexeddb/auto';

import sdk from 'matrix-js-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import {
  persistCryptoStore,
  restoreCryptoStore,
} from './matrix-idb-persist.js';

/** Persistent data directory — survives container restarts */
const MATRIX_DATA_DIR = '/app/data';
const MATRIX_CRYPTO_STORE_PATH = path.join(
  MATRIX_DATA_DIR,
  'matrix-crypto-store',
);
const MATRIX_DEVICE_ID_PATH = path.join(MATRIX_DATA_DIR, 'matrix-device-id');

/**
 * Crypto store prefix for IndexedDB databases created by the Rust SDK.
 * The WASM crypto module stores Olm account keys, Megolm sessions, and device
 * lists in IndexedDB (provided by fake-indexeddb in Node.js). A persistence
 * layer (matrix-idb-persist) serialises the in-memory IndexedDB state to a
 * SQLite file at MATRIX_CRYPTO_STORE_PATH so Olm keys and Megolm sessions
 * survive process restarts.
 */
const MATRIX_CRYPTO_DB_PREFIX = 'matrix-crypto-nanoclaw';

export interface MatrixChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/** Naive markdown → HTML for Matrix formatted_body */
function markdownToHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

/** Determine Matrix msgtype from MIME type */
function msgtypeFromMime(mimeType: string): sdk.MsgType {
  if (mimeType.startsWith('image/')) return sdk.MsgType.Image;
  if (mimeType.startsWith('video/')) return sdk.MsgType.Video;
  if (mimeType.startsWith('audio/')) return sdk.MsgType.Audio;
  return sdk.MsgType.File;
}

export class MatrixChannel implements Channel {
  name = 'matrix';

  private client: sdk.MatrixClient | null = null;
  private opts: MatrixChannelOpts;
  private homeserverUrl: string;
  private accessToken: string;
  private botUserId: string;
  private botPassword: string | undefined;
  private syncReady = false;
  private cryptoPersistTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    homeserverUrl: string,
    accessToken: string,
    botUserId: string,
    opts: MatrixChannelOpts,
    botPassword?: string,
  ) {
    this.homeserverUrl = homeserverUrl;
    this.accessToken = accessToken;
    this.botUserId = botUserId;
    this.opts = opts;
    this.botPassword = botPassword;
  }

  /**
   * One-time bootstrap of cross-signing keys (master, self-signing,
   * user-signing). Without these, Element X shows "Encrypted by a device
   * not verified by its owner" warnings on every k2 message because the
   * recipient has no way to confirm the sending device belongs to k2.
   *
   * Idempotent: skips when `isCrossSigningReady()` returns true. Per the
   * SDK docs that helper checks both that cross-signing is enabled on
   * the account *and* that the private keys are reachable on this device
   * (either cached locally or recoverable from secret storage), so it's
   * a stricter and more accurate skip condition than the raw
   * `getCrossSigningStatus().publicKeysOnDevice` flag — the latter only
   * tests the public side, which would falsely skip if the local private
   * key cache had been wiped.
   *
   * Requires the bot's password (MATRIX_BOT_PASSWORD) for the
   * User-Interactive Auth flow that authorises uploading the
   * device-signing keys to the server. If the password is unset, logs a
   * warning and skips — never fails startup.
   */
  private async bootstrapCrossSigningIfNeeded(): Promise<void> {
    const crypto = this.client?.getCrypto();
    if (!crypto) return;

    let ready: boolean;
    try {
      ready = await crypto.isCrossSigningReady();
    } catch (err) {
      logger.warn({ err }, 'Failed to read Matrix cross-signing status');
      return;
    }

    if (ready) {
      const masterKeyId = await crypto
        .getCrossSigningKeyId()
        .catch(() => null);
      logger.info(
        { masterKeyId },
        'Matrix cross-signing already initialised',
      );
      return;
    }

    if (!this.botPassword) {
      logger.warn(
        'Matrix cross-signing not set up and MATRIX_BOT_PASSWORD is unset — skipping bootstrap. Element X will continue to show "device not verified by its owner" warnings until cross-signing is initialised.',
      );
      return;
    }

    try {
      await crypto.bootstrapCrossSigning({
        authUploadDeviceSigningKeys: async (
          makeRequest: (auth: object) => Promise<unknown>,
        ) => {
          await makeRequest({
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: this.botUserId },
            password: this.botPassword!,
          });
        },
      });

      const masterKeyId = await crypto
        .getCrossSigningKeyId()
        .catch(() => null);
      logger.info({ masterKeyId }, 'Matrix cross-signing bootstrapped');
    } catch (err) {
      logger.error(
        { err },
        'Failed to bootstrap Matrix cross-signing — Element X will continue to show device verification warnings',
      );
    }
  }

  async connect(): Promise<void> {
    // Ensure the persistent data directories exist and are writable.
    // Device ID and crypto store must survive restarts for E2EE key continuity.
    for (const dir of [MATRIX_DATA_DIR, MATRIX_CRYPTO_STORE_PATH]) {
      fs.mkdirSync(dir, { recursive: true });
      try {
        fs.accessSync(dir, fs.constants.W_OK);
      } catch {
        throw new Error(
          `Matrix directory ${dir} is not writable — ` +
            'E2EE keys will be lost on restart. Fix permissions or volume mount.',
        );
      }
    }

    // Reuse a previously persisted device ID so the crypto identity survives
    // restarts. If none exists, discover it via whoami and persist it.
    let deviceId: string | undefined;
    try {
      deviceId =
        fs.readFileSync(MATRIX_DEVICE_ID_PATH, 'utf-8').trim() || undefined;
      if (deviceId) {
        logger.info({ deviceId }, 'Matrix device ID loaded from disk');
      }
    } catch {
      // No persisted device ID yet — will discover below
    }

    if (!deviceId) {
      const tempClient = sdk.createClient({
        baseUrl: this.homeserverUrl,
        accessToken: this.accessToken,
        userId: this.botUserId,
      });
      const whoami = await tempClient.whoami();
      deviceId = whoami.device_id || undefined;
      tempClient.stopClient();

      if (deviceId) {
        fs.writeFileSync(MATRIX_DEVICE_ID_PATH, deviceId, 'utf-8');
        logger.info({ deviceId }, 'Matrix device ID discovered and persisted');
      } else {
        logger.warn(
          'Matrix: whoami did not return a device_id — E2EE will be unavailable',
        );
      }
    }

    this.client = sdk.createClient({
      baseUrl: this.homeserverUrl,
      accessToken: this.accessToken,
      userId: this.botUserId,
      deviceId,
    });

    // Initialise Rust crypto for E2EE support.
    // The WASM module stores keys in IndexedDB (polyfilled by fake-indexeddb).
    // Before crypto init, restore any previously persisted IndexedDB state from
    // the SQLite file on disk so the same Olm account and Megolm sessions are
    // available without re-registering keys with Synapse.
    if (deviceId) {
      const restored = await restoreCryptoStore(MATRIX_CRYPTO_STORE_PATH);
      if (restored) {
        logger.info('Matrix crypto store restored from disk');
      }

      await this.client.initRustCrypto({
        cryptoDatabasePrefix: MATRIX_CRYPTO_DB_PREFIX,
      });

      // Persist the freshly-initialised (or restored) crypto store to disk
      // so it survives process restarts.
      await persistCryptoStore(MATRIX_CRYPTO_STORE_PATH);

      // One-time cross-signing bootstrap so Element X stops showing
      // "Encrypted by a device not verified by its owner" warnings.
      // Idempotent — skips if already initialised. Runs before sync.
      await this.bootstrapCrossSigningIfNeeded();

      // Re-persist after bootstrap so newly-created cross-signing keys
      // survive the next restart.
      await persistCryptoStore(MATRIX_CRYPTO_STORE_PATH);

      // Periodically flush crypto state to disk (every 5 minutes).
      // New Megolm sessions established during runtime are captured here.
      this.cryptoPersistTimer = setInterval(
        () => {
          persistCryptoStore(MATRIX_CRYPTO_STORE_PATH).catch((err) => {
            logger.warn({ err }, 'Failed to persist Matrix crypto store');
          });
        },
        5 * 60 * 1000,
      );

      logger.info(
        { cryptoDbPrefix: MATRIX_CRYPTO_DB_PREFIX, deviceId },
        'Matrix E2EE crypto initialised',
      );
    }

    // Auto-accept room invites
    this.client.on(
      sdk.RoomMemberEvent.Membership,
      (_event: sdk.MatrixEvent, member: sdk.RoomMember) => {
        if (
          member.membership === 'invite' &&
          member.userId === this.botUserId
        ) {
          this.client!.joinRoom(member.roomId)
            .then(() => {
              logger.info(
                { roomId: member.roomId },
                'Matrix invite auto-accepted',
              );
            })
            .catch((err) => {
              logger.error(
                { roomId: member.roomId, err },
                'Failed to auto-accept Matrix invite',
              );
            });
        }
      },
    );

    // Listen for plaintext room messages
    this.client.on(
      sdk.RoomEvent.Timeline,
      (
        event: sdk.MatrixEvent,
        room: sdk.Room | undefined,
        _toStartOfTimeline: boolean | undefined,
      ) => {
        // Only process new messages, not historical ones during initial sync
        if (_toStartOfTimeline) return;
        // Skip encrypted events — they'll be handled by the Decrypted listener
        if (event.isEncrypted()) return;
        if (event.getType() !== 'm.room.message') return;
        this.processMessageEvent(event, room);
      },
    );

    // Listen for decrypted E2EE messages
    this.client.on(
      sdk.MatrixEventEvent.Decrypted,
      (event: sdk.MatrixEvent, err?: Error) => {
        if (err) {
          logger.warn(
            { eventId: event.getId(), err },
            'Matrix event decryption failed',
          );
          return;
        }
        if (event.getType() !== 'm.room.message') return;
        const roomId = event.getRoomId();
        const room = roomId
          ? (this.client!.getRoom(roomId) ?? undefined)
          : undefined;
        this.processMessageEvent(event, room);
      },
    );

    // Start the client and wait for initial sync
    return new Promise<void>((resolve, reject) => {
      this.client!.on(sdk.ClientEvent.Sync, (state: string) => {
        if (state === 'PREPARED') {
          this.syncReady = true;
          logger.info(
            { userId: this.botUserId, homeserver: this.homeserverUrl },
            'Matrix client connected',
          );
          console.log(`\n  Matrix bot: ${this.botUserId}`);
          console.log(`  Rooms will auto-register on first message\n`);

          // Join any rooms with pending invites from before startup
          const pendingInvites = this.client!.getRooms().filter(
            (room) => room.getMyMembership() === 'invite',
          );
          for (const room of pendingInvites) {
            this.client!.joinRoom(room.roomId)
              .then(() => {
                logger.info(
                  { roomId: room.roomId, roomName: room.name },
                  'Matrix pending invite accepted on startup',
                );
              })
              .catch((err) => {
                logger.error(
                  { roomId: room.roomId, err },
                  'Failed to accept pending Matrix invite on startup',
                );
              });
          }
          if (pendingInvites.length > 0) {
            logger.info(
              { count: pendingInvites.length },
              'Processing pending Matrix invites',
            );
          }

          resolve();
        } else if (state === 'ERROR') {
          reject(new Error('Matrix sync failed'));
        }
      });

      this.client!.startClient({ initialSyncLimit: 10 });
    });
  }

  private processMessageEvent(
    event: sdk.MatrixEvent,
    room: sdk.Room | undefined,
  ): void {
    const sender = event.getSender();
    if (!sender || sender === this.botUserId) return;

    const content = event.getContent();
    const msgtype = content.msgtype;
    if (!msgtype) return;

    const roomId = event.getRoomId();
    if (!roomId) return;
    const chatJid = `mx:${roomId}`;

    const timestamp = new Date(event.getTs()).toISOString();
    const senderName =
      room?.getMember(sender)?.name || sender.replace(/:.*$/, '').slice(1);
    const msgId = event.getId() || `${Date.now()}`;

    // Determine chat name and group status
    const roomName = room?.name || chatJid;
    const memberCount = room?.getJoinedMemberCount() || 0;
    const isGroup = memberCount > 2;

    // Store chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, roomName, 'matrix', isGroup);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, roomName },
        'Message from unregistered Matrix room',
      );
      return;
    }

    // Build message content based on msgtype
    let messageContent: string;
    if (msgtype === 'm.text') {
      messageContent = content.body || '';
    } else if (msgtype === 'm.image') {
      messageContent = '[Image]';
    } else if (msgtype === 'm.video') {
      messageContent = '[Video]';
    } else if (msgtype === 'm.audio') {
      messageContent = '[Audio]';
    } else if (msgtype === 'm.file') {
      const fileName = content.body || 'file';
      messageContent = `[File: ${fileName}]`;
    } else {
      // Unknown msgtype — skip
      return;
    }

    // Trigger detection: check if message matches TRIGGER_PATTERN
    if (msgtype === 'm.text' && !TRIGGER_PATTERN.test(messageContent)) {
      // Check for @mention of the bot display name in the body
      const botLocalpart = this.botUserId.replace(/:.*$/, '').slice(1);
      const mentionPattern = new RegExp(
        `@(${ASSISTANT_NAME}|${botLocalpart})\\b`,
        'i',
      );
      if (mentionPattern.test(messageContent)) {
        messageContent = `@${ASSISTANT_NAME} ${messageContent}`;
      }
    }

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content: messageContent,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, roomName, sender: senderName },
      'Matrix message stored',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Matrix client not initialized');
      return;
    }

    try {
      const roomId = jid.replace(/^mx:/, '');

      // Matrix practical limit ~32000 chars — split if needed
      const MAX_LENGTH = 32000;
      const chunks =
        text.length <= MAX_LENGTH
          ? [text]
          : Array.from(
              { length: Math.ceil(text.length / MAX_LENGTH) },
              (_, i) => text.slice(i * MAX_LENGTH, (i + 1) * MAX_LENGTH),
            );

      for (const chunk of chunks) {
        await this.client.sendHtmlMessage(roomId, chunk, markdownToHtml(chunk));
      }

      logger.info({ jid, length: text.length }, 'Matrix message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Matrix message');
    }
  }

  async sendFile(
    jid: string,
    filePath: string,
    mimeType: string,
    fileName?: string,
  ): Promise<void> {
    if (!this.client) {
      logger.warn('Matrix client not initialized');
      return;
    }

    try {
      const roomId = jid.replace(/^mx:/, '');
      const resolvedName = fileName || path.basename(filePath);
      const fileBuffer = fs.readFileSync(filePath);
      const stat = fs.statSync(filePath);

      // Upload file to Matrix content repository
      const uploadResponse = await this.client.uploadContent(fileBuffer, {
        name: resolvedName,
        type: mimeType,
      });
      const contentUri =
        typeof uploadResponse === 'string'
          ? uploadResponse
          : uploadResponse.content_uri;

      const msgtype = msgtypeFromMime(mimeType);

      await this.client.sendMessage(roomId, {
        msgtype,
        body: resolvedName,
        url: contentUri,
        info: {
          mimetype: mimeType,
          size: stat.size,
        },
      } as any);

      logger.info(
        { jid, fileName: resolvedName, mimeType },
        'Matrix file sent',
      );
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send Matrix file');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.syncReady;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('mx:');
  }

  async disconnect(): Promise<void> {
    if (this.cryptoPersistTimer) {
      clearInterval(this.cryptoPersistTimer);
      this.cryptoPersistTimer = null;
    }
    if (this.client) {
      // Flush crypto state to disk before stopping
      await persistCryptoStore(MATRIX_CRYPTO_STORE_PATH).catch((err) => {
        logger.warn(
          { err },
          'Failed to persist Matrix crypto store on shutdown',
        );
      });
      this.client.stopClient();
      this.client = null;
      this.syncReady = false;
      logger.info('Matrix client stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;
    try {
      const roomId = jid.replace(/^mx:/, '');
      await this.client.sendTyping(roomId, isTyping, isTyping ? 30000 : 0);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Matrix typing indicator');
    }
  }
}

registerChannel('matrix', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'MATRIX_HOMESERVER_URL',
    'MATRIX_ACCESS_TOKEN',
    'MATRIX_BOT_USER_ID',
    'MATRIX_BOT_PASSWORD',
  ]);
  const homeserverUrl =
    process.env.MATRIX_HOMESERVER_URL || envVars.MATRIX_HOMESERVER_URL || '';
  const accessToken =
    process.env.MATRIX_ACCESS_TOKEN || envVars.MATRIX_ACCESS_TOKEN || '';
  const botUserId =
    process.env.MATRIX_BOT_USER_ID || envVars.MATRIX_BOT_USER_ID || '';
  // Optional — only used to authorise one-time cross-signing bootstrap.
  const botPassword =
    process.env.MATRIX_BOT_PASSWORD || envVars.MATRIX_BOT_PASSWORD || undefined;

  if (!homeserverUrl || !accessToken || !botUserId) {
    logger.warn(
      'Matrix: MATRIX_HOMESERVER_URL, MATRIX_ACCESS_TOKEN, and MATRIX_BOT_USER_ID must all be set',
    );
    return null;
  }

  return new MatrixChannel(
    homeserverUrl,
    accessToken,
    botUserId,
    opts,
    botPassword,
  );
});
