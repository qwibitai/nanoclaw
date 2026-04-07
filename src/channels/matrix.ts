/**
 * Matrix channel for NanoClaw.
 *
 * Supports E2E-encrypted rooms via the Rust-based crypto backend in
 * matrix-js-sdk.  Set the following env vars (managed by OneCLI or .env):
 *
 *   MATRIX_HOMESERVER   e.g. https://matrix.org
 *   MATRIX_ACCESS_TOKEN syt_…
 *   MATRIX_USER_ID      @bot:matrix.org
 *   MATRIX_DEVICE_ID    (optional, re-use an existing device)
 */

import { execFile } from 'child_process';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

import {
  ClientEvent,
  EventType,
  MemoryStore,
  MsgType,
  RoomEvent,
  SyncState,
  createClient,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';

import type { Channel, NewMessage } from '../types.js';
import { type ChannelOpts, registerChannel } from './registry.js';

// ─── JID helpers ─────────────────────────────────────────────────────────────

export const MATRIX_JID_PREFIX = 'matrix:';

export function toJid(roomId: string): string {
  return `${MATRIX_JID_PREFIX}${roomId}`;
}

export function toRoomId(jid: string): string {
  return jid.slice(MATRIX_JID_PREFIX.length);
}

// ─── Native desktop notification ─────────────────────────────────────────────

function nativeNotify(title: string, body: string): void {
  const t = title.replace(/["\\]/g, ' ').slice(0, 80);
  const b = body.replace(/["\\]/g, ' ').slice(0, 120);
  if (process.platform === 'darwin') {
    execFileAsync('osascript', [
      '-e',
      `display notification "${b}" with title "${t}"`,
    ]).catch(() => {
      // notification not critical — ignore failures silently
    });
  } else {
    // Linux / freedesktop
    execFileAsync('notify-send', ['--', t, b]).catch(() => {});
  }
}

// ─── Text chunking ────────────────────────────────────────────────────────────

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLen) {
    chunks.push(text.slice(i, i + maxLen));
  }
  return chunks;
}

// ─── Channel implementation ───────────────────────────────────────────────────

export class MatrixChannel implements Channel {
  name = 'matrix' as const;

  private readonly client: MatrixClient;
  private readonly userId: string;
  private readonly opts: ChannelOpts;
  private _connected = false;

  constructor(client: MatrixClient, userId: string, opts: ChannelOpts) {
    this.client = client;
    this.userId = userId;
    this.opts = opts;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    // Initialise Rust-based E2EE (replaces the legacy libolm path).
    // The SDK downloads a pre-built native binary at install time — no
    // separate compilation step is required.
    await this.client.initRustCrypto();

    // Allow messages from devices we haven't verified yet (avoids silent
    // failures in group rooms with many participants).
    // Cast needed: method exists at runtime but is absent from some type stubs.
    const crypto = this.client.getCrypto() as
      | (ReturnType<MatrixClient['getCrypto']> & {
          setGlobalErrorOnUnknownDevices?: (v: boolean) => void;
        })
      | undefined;
    crypto?.setGlobalErrorOnUnknownDevices?.(false);

    // Auto-accept room invitations.
    this.client.on(RoomEvent.MyMembership, (room, membership) => {
      if (membership === 'invite') {
        this.client.joinRoom(room.roomId).catch((err: unknown) => {
          console.error('[matrix] Failed to auto-join room:', err);
        });
      }
    });

    // Route incoming timeline events to our handler.
    this.client.on(RoomEvent.Timeline, (event, room, toStart) => {
      if (toStart || !room) return;
      this.handleTimelineEvent(event, room);
    });

    // Surface interactive verification requests (SAS / emoji) to the
    // operator so they can complete them from any Matrix client.
    this.client.on(
      // Event name kept as a string so it compiles against all SDK versions.
      'crypto.verificationRequest' as Parameters<MatrixClient['on']>[0],
      (request: { userId?: string; otherUserId?: string }) => {
        const who = request.userId ?? request.otherUserId ?? 'unknown';
        console.log(
          `[matrix] Verification request from ${who}. ` +
            `Open your Matrix client and accept the request to confirm device identity.`,
        );
        nativeNotify('Matrix — verification request', `From: ${who}`);
      },
    );

    // Start the SDK sync loop.
    await this.client.startClient({ initialSyncLimit: 10 });

    // Wait for the first full sync before reporting "connected".
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('[matrix] Initial sync timed out after 30 s')),
        30_000,
      );
      this.client.once(ClientEvent.Sync, (state) => {
        if (state === SyncState.Prepared) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    this._connected = true;
    console.log(`[matrix] Connected as ${this.userId}`);
  }

  async disconnect(): Promise<void> {
    this._connected = false;
    this.client.stopClient();
    console.log('[matrix] Disconnected');
  }

  // ── Channel interface ──────────────────────────────────────────────────────

  isConnected(): boolean {
    return this._connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(MATRIX_JID_PREFIX);
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const roomId = toRoomId(jid);
    // Matrix has no hard message-length limit but large payloads cause issues;
    // 4 000 chars keeps us well within server defaults.
    for (const chunk of splitText(text, 4_000)) {
      await this.client.sendMessage(roomId, {
        msgtype: MsgType.Text,
        body: chunk,
      });
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    await this.client.sendTyping(toRoomId(jid), isTyping, 5_000).catch(() => {});
  }

  async syncGroups(_force: boolean): Promise<void> {
    const now = new Date().toISOString();
    for (const room of this.client.getRooms()) {
      const jid = toJid(room.roomId);
      const isGroup = room.getJoinedMemberCount() > 2;
      this.opts.onChatMetadata(jid, now, room.name, 'matrix', isGroup);
    }
  }

  // ── Internal event handling ────────────────────────────────────────────────

  private handleTimelineEvent(event: MatrixEvent, room: Room): void {
    const type = event.getType();

    // Accept plaintext messages and (post-decryption) encrypted messages.
    const isMessage = type === EventType.RoomMessage;
    const isEncrypted = type === 'm.room.encrypted';
    if (!isMessage && !isEncrypted) return;

    if (event.isRedacted()) return;

    const sender = event.getSender();
    if (!sender || sender === this.userId) return;

    const content = event.getContent();
    const msgtype = content['msgtype'] as string | undefined;

    // Only handle human-readable text for now; ignore files, images, etc.
    if (msgtype !== MsgType.Text && msgtype !== MsgType.Notice) return;

    const text = (content['body'] as string | undefined) ?? '';
    if (!text.trim()) return;

    const jid = toJid(room.roomId);
    const timestamp = new Date(event.getTs()).toISOString();
    const senderName = room.getMember(sender)?.name ?? sender;
    const eventId = event.getId() ?? `${room.roomId}:${event.getTs()}`;

    const msg: NewMessage = {
      id: eventId,
      chat_jid: jid,
      sender,
      sender_name: senderName,
      content: text,
      timestamp,
      is_from_me: false,
      is_bot_message: false,
    };

    // Capture reply context if present.
    const relatesTo = content['m.relates_to'] as
      | Record<string, Record<string, string>>
      | undefined;
    const inReplyTo = relatesTo?.['m.in_reply_to'];
    if (inReplyTo?.['event_id']) {
      msg.reply_to_message_id = inReplyTo['event_id'];
    }

    const isGroup = room.getJoinedMemberCount() > 2;
    this.opts.onChatMetadata(jid, timestamp, room.name, 'matrix', isGroup);
    this.opts.onMessage(jid, msg);

    nativeNotify(`Matrix — ${room.name}`, `${senderName}: ${text}`);
  }
}

// ─── Self-registration ────────────────────────────────────────────────────────

registerChannel('matrix', (opts: ChannelOpts): Channel | null => {
  const homeserver = process.env['MATRIX_HOMESERVER'];
  const accessToken = process.env['MATRIX_ACCESS_TOKEN'];
  const userId = process.env['MATRIX_USER_ID'];

  if (!homeserver || !accessToken || !userId) return null;

  // Ensure the data directory exists; the Rust crypto backend will write its
  // SQLite store here so keys survive process restarts.
  const dataDir = join(process.cwd(), 'data', 'matrix');
  mkdirSync(dataDir, { recursive: true });

  const client = createClient({
    baseUrl: homeserver,
    accessToken,
    userId,
    deviceId: process.env['MATRIX_DEVICE_ID'],
    store: new MemoryStore(),
  });

  return new MatrixChannel(client, userId, opts);
});
