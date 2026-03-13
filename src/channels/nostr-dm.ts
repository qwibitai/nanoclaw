import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { connect } from 'net';

import WebSocket from 'ws';
import { useWebSocketImplementation, SimplePool } from 'nostr-tools/pool';

import {
  GROUPS_DIR,
  NOSTR_DM_ALLOWLIST,
  NOSTR_DM_RELAYS,
  NOSTR_SIGNER_SOCKET,
} from '../config.js';
import { reportError, clearAlert } from '../health.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface NostrDMChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface NostrEvent {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
  sig: string;
}

interface Rumor {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  tags: string[][];
  created_at: number;
}

// --- Daemon socket helper ---

function daemonRequest(payload: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const sock = connect(NOSTR_SIGNER_SOCKET);
    let data = '';
    sock.on('connect', () => {
      sock.write(JSON.stringify(payload));
      sock.end();
    });
    sock.on('data', (chunk) => {
      data += chunk;
    });
    sock.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error(`Bad response from signer: ${data}`));
      }
    });
    sock.on('error', (err) => {
      sock.destroy();
      reject(
        new Error(
          `Cannot connect to signing daemon at ${NOSTR_SIGNER_SOCKET}: ${err.message}`,
        ),
      );
    });
  });
}

export class NostrDMChannel implements Channel {
  name = 'nostr';

  private pool: SimplePool | null = null;
  private connected = false;
  private ownPubkey = '';
  private allowedPubkeys: Set<string>;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private seenIds = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private subCloser: { close: () => void } | null = null;
  private profileCache = new Map<string, { name: string; fetchedAt: number }>();
  private profileFetching = new Set<string>();

  private opts: NostrDMChannelOpts;

  constructor(opts: NostrDMChannelOpts) {
    this.opts = opts;
    this.allowedPubkeys = new Set(NOSTR_DM_ALLOWLIST);
  }

  async connect(): Promise<void> {
    // Get our pubkey from the signing daemon
    const res = await daemonRequest({ method: 'get_public_key' });
    if (res.error) throw new Error(`Signer error: ${res.error}`);
    this.ownPubkey = res.pubkey as string;

    // Set up WebSocket for Node.js
    useWebSocketImplementation(WebSocket);

    this.pool = new SimplePool();
    this.subscribe();

    this.connected = true;
    this.reconnectAttempts = 0;
    clearAlert('nostr-dm-disconnect');
    logger.info(
      {
        pubkey: this.ownPubkey,
        relays: NOSTR_DM_RELAYS.length,
        allowlist: this.allowedPubkeys.size,
      },
      'Nostr DM channel connected',
    );

    // Flush any queued outbound messages
    this.flushOutgoingQueue().catch((err) =>
      logger.error({ err }, 'Failed to flush Nostr DM outgoing queue'),
    );
  }

  private subscribe(): void {
    if (!this.pool) return;

    this.subCloser = this.pool.subscribeMany(
      NOSTR_DM_RELAYS,
      { kinds: [1059], '#p': [this.ownPubkey] },
      {
        onevent: (event: NostrEvent) => {
          this.handleGiftWrap(event).catch((err) =>
            logger.error({ err }, 'Error handling Nostr gift wrap'),
          );
        },
        onclose: (reasons: string[]) => {
          // Called when all relay connections close
          logger.warn({ reasons }, 'Nostr DM relay subscriptions closed');
          this.connected = false;
          this.scheduleReconnect();
        },
      },
    );
  }

  private async handleGiftWrap(event: NostrEvent): Promise<void> {
    // Deduplicate by gift-wrap event ID
    if (this.seenIds.has(event.id)) return;
    this.seenIds.add(event.id);
    // Cap the dedup set to prevent unbounded growth
    if (this.seenIds.size > 10000) {
      const arr = [...this.seenIds];
      this.seenIds = new Set(arr.slice(-5000));
    }

    // Unwrap via signing daemon
    let rumor: Rumor;
    try {
      const res = await daemonRequest({
        method: 'unwrap_gift_wrap',
        params: { event },
      });
      if (res.error) {
        logger.warn({ error: res.error }, 'Failed to unwrap gift wrap');
        return;
      }
      rumor = res.rumor as Rumor;
    } catch (err) {
      logger.warn({ err }, 'Daemon unwrap request failed');
      return;
    }

    // Handle NIP-17 private direct messages (kind 14) and file messages (kind 15)
    if (rumor.kind !== 14 && rumor.kind !== 15) return;

    const senderPubkey = rumor.pubkey;

    // Ignore our own messages (self-wraps)
    if (senderPubkey === this.ownPubkey) return;

    // Phase 1: allowlist check
    if (!this.allowedPubkeys.has(senderPubkey)) {
      logger.debug(
        { sender: senderPubkey.slice(0, 12) },
        'Nostr DM from non-allowlisted pubkey, ignoring',
      );
      return;
    }

    const chatJid = `nostr:${senderPubkey}`;
    // Use arrival time, not rumor created_at — NIP-17 randomizes timestamps
    // for metadata protection, which breaks cursor-based message ordering.
    const timestamp = new Date().toISOString();
    const senderName = await this.resolveDisplayName(senderPubkey);

    let content = rumor.content || '';

    // Kind 15: encrypted file attachment
    if (rumor.kind === 15) {
      const fileType = this.getTag(rumor.tags, 'file-type');
      if (!fileType?.startsWith('image/')) {
        // Only handle images for now
        content = content || '[File attachment - unsupported type]';
      } else {
        const imagePath = await this.downloadAndDecryptAttachment(
          rumor,
          chatJid,
        );
        if (imagePath) {
          content = `[Image: ${imagePath}]`;
        } else {
          content = '[Image - download/decrypt failed]';
        }
      }
    }

    if (!content) return;

    this.opts.onChatMetadata(chatJid, timestamp, senderName, 'nostr', false);

    this.opts.onMessage(chatJid, {
      id: rumor.id,
      chat_jid: chatJid,
      sender: senderPubkey,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected || !this.pool) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, length: text.length, queueSize: this.outgoingQueue.length },
        'Nostr DM channel disconnected, message queued',
      );
      return;
    }

    const recipientPubkey = jid.slice('nostr:'.length);

    try {
      // Wrap the DM via signing daemon (produces recipient wrap + self wrap)
      const res = await daemonRequest({
        method: 'wrap_dm',
        params: { recipientPubkey, message: text },
      });
      if (res.error) {
        throw new Error(res.error as string);
      }

      const events = res.events as NostrEvent[];

      // Publish all wraps (recipient + self) to relays
      await Promise.all(
        events.map((ev) => this.pool!.publish(NOSTR_DM_RELAYS, ev)),
      );

      logger.info(
        { jid, length: text.length, wraps: events.length },
        'Nostr DM sent',
      );
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Nostr DM, queued',
      );
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('nostr:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.subCloser?.close();
    this.pool?.close(NOSTR_DM_RELAYS);
    this.pool = null;
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Nostr has no typing indicators
  }

  /**
   * Fetch kind 0 metadata for a pubkey and return a display name.
   * Caches results for 24 hours. Returns truncated hex as fallback.
   */
  private async resolveDisplayName(pubkey: string): Promise<string> {
    const fallback = pubkey.slice(0, 12);
    const cached = this.profileCache.get(pubkey);
    if (cached && Date.now() - cached.fetchedAt < 86400000) {
      return cached.name;
    }

    if (!this.pool || this.profileFetching.has(pubkey)) {
      return cached?.name || fallback;
    }
    this.profileFetching.add(pubkey);

    try {
      const event = await this.pool.get(NOSTR_DM_RELAYS, {
        kinds: [0],
        authors: [pubkey],
      }, { maxWait: 5000 });
      if (event?.content) {
        const meta = JSON.parse(event.content);
        const name =
          meta.display_name || meta.displayName || meta.name || fallback;
        this.profileCache.set(pubkey, { name, fetchedAt: Date.now() });
        return name;
      }
    } catch (err) {
      logger.debug({ err, pubkey: fallback }, 'Failed to fetch Nostr profile');
    } finally {
      this.profileFetching.delete(pubkey);
    }

    this.profileCache.set(pubkey, { name: fallback, fetchedAt: Date.now() });
    return fallback;
  }

  private getTag(tags: string[][], name: string): string | undefined {
    return tags.find((t) => t[0] === name)?.[1];
  }

  /**
   * Download an encrypted Blossom attachment and decrypt it with AES-256-GCM.
   * Saves to the group folder so the container can read it via /workspace/group/attachments/.
   * Returns the container-relative path, or null on failure.
   */
  private async downloadAndDecryptAttachment(
    rumor: Rumor,
    chatJid: string,
  ): Promise<string | null> {
    const url = rumor.content?.trim();
    const keyHex = this.getTag(rumor.tags, 'decryption-key');
    const nonceHex = this.getTag(rumor.tags, 'decryption-nonce');
    const algo = this.getTag(rumor.tags, 'encryption-algorithm');
    const fileType = this.getTag(rumor.tags, 'file-type') || 'image/jpeg';
    const fileHash = this.getTag(rumor.tags, 'x') || rumor.id;

    if (!url || !keyHex || !nonceHex) {
      logger.warn(
        { url: !!url, key: !!keyHex, nonce: !!nonceHex },
        'Missing fields for Nostr file attachment',
      );
      return null;
    }

    // Resolve group folder from registered groups
    const groups = this.opts.registeredGroups();
    const group = groups[chatJid];
    if (!group) {
      logger.warn({ chatJid }, 'No registered group for Nostr DM attachment');
      return null;
    }

    const ext = fileType.split('/')[1]?.split(';')[0] || 'bin';
    const attachDir = path.join(GROUPS_DIR, group.folder, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });
    const filePath = path.join(attachDir, `${fileHash}.${ext}`);

    // Skip if already downloaded
    if (fs.existsSync(filePath)) {
      return `/workspace/group/attachments/${fileHash}.${ext}`;
    }

    try {
      // Download encrypted blob
      const res = await fetch(url);
      if (!res.ok) {
        logger.warn(
          { url, status: res.status },
          'Failed to download Nostr attachment',
        );
        return null;
      }
      const encrypted = Buffer.from(await res.arrayBuffer());

      if (algo !== 'aes-gcm') {
        logger.warn(
          { algo },
          'Unsupported encryption algorithm for Nostr attachment',
        );
        return null;
      }

      // AES-256-GCM: last 16 bytes are the auth tag
      const key = Buffer.from(keyHex, 'hex');
      const nonce = Buffer.from(nonceHex, 'hex');
      const authTag = encrypted.subarray(encrypted.length - 16);
      const ciphertext = encrypted.subarray(0, encrypted.length - 16);

      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);

      fs.writeFileSync(filePath, decrypted);
      logger.info(
        { hash: fileHash, size: decrypted.length, type: fileType },
        'Nostr DM image decrypted and saved',
      );

      return `/workspace/group/attachments/${fileHash}.${ext}`;
    } catch (err) {
      logger.warn({ err, url }, 'Failed to download/decrypt Nostr attachment');
      return null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    if (this.reconnectAttempts === 3) {
      reportError(
        'nostr-dm-disconnect',
        `Nostr DM relay connections lost. Failed to reconnect ${this.reconnectAttempts} times.`,
      );
    }
    const delay = Math.min(
      5000 * Math.pow(2, this.reconnectAttempts - 1),
      60000,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      logger.info('Reconnecting Nostr DM relays...');
      try {
        this.subCloser?.close();
        this.pool?.close(NOSTR_DM_RELAYS);
        this.pool = new SimplePool();
        this.subscribe();
        this.connected = true;
        this.reconnectAttempts = 0;
        clearAlert('nostr-dm-disconnect');
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush Nostr DM outgoing queue'),
        );
      } catch (err) {
        logger.error({ err }, 'Nostr DM reconnect failed');
        this.scheduleReconnect();
      }
    }, delay);
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.outgoingQueue.length === 0) return;
    logger.info(
      { count: this.outgoingQueue.length },
      'Flushing outgoing Nostr DM queue',
    );
    while (this.outgoingQueue.length > 0) {
      const item = this.outgoingQueue.shift()!;
      await this.sendMessage(item.jid, item.text);
    }
  }
}
