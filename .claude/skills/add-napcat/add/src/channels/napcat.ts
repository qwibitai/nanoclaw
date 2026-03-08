import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';

import WebSocket from 'ws';

import { ASSISTANT_NAME, GROUPS_DIR, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// OneBot 11 message segment types
interface OneBotSegment {
  type: string;
  data: Record<string, any>;
}

// OneBot 11 message event
interface OneBotMessageEvent {
  post_type: 'message';
  message_type: 'private' | 'group';
  sub_type: string;
  message_id: number;
  user_id: number;
  group_id?: number;
  message: OneBotSegment[] | string;
  raw_message: string;
  time: number;
  self_id: number;
  sender: {
    user_id: number;
    nickname: string;
    card?: string;
    sex?: string;
    age?: number;
    role?: string;
  };
}

// OneBot 11 meta event (lifecycle, heartbeat)
interface OneBotMetaEvent {
  post_type: 'meta_event';
  meta_event_type: string;
  sub_type?: string;
  self_id: number;
  time: number;
}

// OneBot 11 API response
interface OneBotApiResponse {
  status: string;
  retcode: number;
  data: any;
  echo?: string;
}

type OneBotEvent =
  | OneBotMessageEvent
  | OneBotMetaEvent
  | { post_type: string; [key: string]: any };

export interface NapCatChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Extract plain text content from OneBot 11 message segments.
 * Handles both array format and raw string format.
 */
export function extractTextContent(
  message: OneBotSegment[] | string,
  rawMessage: string,
): string {
  if (typeof message === 'string') {
    return message;
  }

  if (!Array.isArray(message) || message.length === 0) {
    return rawMessage || '';
  }

  const parts: string[] = [];
  for (const seg of message) {
    switch (seg.type) {
      case 'text':
        parts.push(seg.data.text || '');
        break;
      case 'at':
        // @mention — qq can be a number or "all"
        if (seg.data.qq === 'all') {
          parts.push('@all');
        } else {
          parts.push(`@${seg.data.qq}`);
        }
        break;
      case 'face':
        parts.push('[QQ Face]');
        break;
      case 'image':
        parts.push('[Image]');
        break;
      case 'record':
        parts.push('[Voice]');
        break;
      case 'video':
        parts.push('[Video]');
        break;
      case 'file':
        parts.push(`[File: ${seg.data.name || seg.data.file || ''}]`);
        break;
      case 'share':
        parts.push(`[Link: ${seg.data.title || seg.data.url || ''}]`);
        break;
      case 'location':
        parts.push(`[Location: ${seg.data.title || ''}]`);
        break;
      case 'reply':
        // Reply reference — skip, the actual content follows
        break;
      case 'forward':
        parts.push('[Forward message]');
        break;
      case 'json':
        parts.push('[JSON message]');
        break;
      case 'xml':
        parts.push('[XML message]');
        break;
      default:
        // Unknown segment type — use raw text if available
        if (seg.data?.text) {
          parts.push(seg.data.text);
        }
        break;
    }
  }

  return parts.join('').trim() || rawMessage || '';
}

/**
 * Build a JID (chat identifier) from an OneBot message event.
 * Format: qq:<user_id> for private, qq:<group_id> for group.
 */
export function buildJid(event: OneBotMessageEvent): string {
  if (event.message_type === 'group' && event.group_id) {
    return `qq:${event.group_id}`;
  }
  return `qq:${event.user_id}`;
}

/**
 * Check if the bot is @mentioned in the message segments.
 * Returns true if any 'at' segment targets the bot's self_id.
 */
export function isBotMentioned(
  message: OneBotSegment[] | string,
  selfId: number,
): boolean {
  if (typeof message === 'string' || !Array.isArray(message)) {
    return false;
  }
  return message.some(
    (seg) => seg.type === 'at' && String(seg.data.qq) === String(selfId),
  );
}

export class NapCatChannel implements Channel {
  name = 'napcat';

  private ws: WebSocket | null = null;
  private opts: NapCatChannelOpts;
  private wsUrl: string;
  private accessToken: string;
  private selfId: number = 0;
  private connected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private chatTypes = new Map<string, 'group' | 'private'>();
  private static readonly MAX_CHAT_TYPES = 10000;
  private pendingCalls = new Map<
    string,
    {
      resolve: (value: OneBotApiResponse) => void;
      reject: (reason: any) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private callCounter = 0;
  private groupsDir: string;

  constructor(wsUrl: string, accessToken: string, opts: NapCatChannelOpts, groupsDir: string = GROUPS_DIR) {
    this.wsUrl = wsUrl;
    this.accessToken = accessToken;
    this.opts = opts;
    this.groupsDir = groupsDir;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = this.accessToken
        ? `${this.wsUrl}?access_token=${encodeURIComponent(this.accessToken)}`
        : this.wsUrl;

      this.ws = new WebSocket(url);

      const connectTimeout = setTimeout(() => {
        if (!this.connected) {
          this.ws?.close();
          reject(new Error('NapCat WebSocket connection timeout'));
        }
      }, 15000);

      // Fallback timer for NapCat configs that don't send lifecycle events
      const fallbackTimer = setTimeout(async () => {
        if (!this.connected && this.ws?.readyState === WebSocket.OPEN) {
          this.connected = true;
          clearTimeout(connectTimeout);
          logger.info('NapCat connected (no lifecycle event received)');
          // Try to fetch selfId via API
          try {
            const resp = await this.callApi('get_login_info');
            if (resp.retcode === 0 && resp.data?.user_id) {
              this.selfId = resp.data.user_id;
            }
          } catch {
            // Non-fatal — selfId stays 0
          }
          console.log(`\n  NapCat QQ bot connected`);
          console.log(`  Connected to: ${this.wsUrl}\n`);
          resolve();
        }
      }, 5000);

      this.ws.on('open', () => {
        logger.info({ url: this.wsUrl }, 'NapCat WebSocket connected');
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString()) as
            | OneBotEvent
            | OneBotApiResponse;

          // Check if this is an API response (has echo field)
          if ('echo' in event && event.echo) {
            const pending = this.pendingCalls.get(event.echo);
            if (pending) {
              clearTimeout(pending.timer);
              this.pendingCalls.delete(event.echo);
              pending.resolve(event as OneBotApiResponse);
            }
            return;
          }

          // Handle events
          if ('post_type' in event) {
            if (event.post_type === 'meta_event') {
              const metaEvent = event as OneBotMetaEvent;
              if (
                metaEvent.meta_event_type === 'lifecycle' &&
                metaEvent.sub_type === 'connect'
              ) {
                this.selfId = metaEvent.self_id;
                this.connected = true;
                clearTimeout(connectTimeout);
                clearTimeout(fallbackTimer);
                logger.info(
                  { selfId: this.selfId },
                  'NapCat bot connected (lifecycle event)',
                );
                console.log(`\n  NapCat QQ bot: ${this.selfId}`);
                console.log(`  Connected to: ${this.wsUrl}\n`);
                resolve();
              }
              // Heartbeat events — just log at debug level
              if (metaEvent.meta_event_type === 'heartbeat') {
                logger.debug({ selfId: metaEvent.self_id }, 'NapCat heartbeat');
              }
            } else if (event.post_type === 'message') {
              this.handleMessage(event as OneBotMessageEvent).catch((err) => {
                logger.error({ err }, 'NapCat: handleMessage error');
              });
            }
          }
        } catch (err) {
          logger.error({ err }, 'Failed to parse NapCat WebSocket message');
        }
      });

      this.ws.on('error', (err: Error) => {
        logger.error({ err: err.message }, 'NapCat WebSocket error');
        if (!this.connected) {
          clearTimeout(connectTimeout);
          clearTimeout(fallbackTimer);
          reject(err);
        }
      });

      this.ws.on('close', (code: number, reason: Buffer) => {
        logger.warn(
          { code, reason: reason.toString() },
          'NapCat WebSocket closed',
        );
        this.connected = false;

        // Reject all pending API calls
        this.rejectAllPendingCalls('WebSocket closed');

        // Auto-reconnect after 5 seconds
        if (this.ws) {
          this.scheduleReconnect();
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      logger.info('NapCat attempting reconnection...');
      try {
        await this.connect();
        logger.info('NapCat reconnected successfully');
      } catch (err) {
        logger.error({ err }, 'NapCat reconnection failed');
        this.scheduleReconnect();
      }
    }, 5000);
  }

  /**
   * Reject all pending API calls and clear the map.
   */
  private rejectAllPendingCalls(reason: string): void {
    const entries = [...this.pendingCalls.values()];
    this.pendingCalls.clear();
    for (const pending of entries) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
  }

  /**
   * Download a file from a URL to the group's files directory.
   * Returns the local path on success, null on failure.
   */
  private async downloadFile(
    url: string,
    groupFolder: string,
    filenameHint: string,
  ): Promise<string | null> {
    try {
      const filesDir = path.join(this.groupsDir, groupFolder, 'files');
      await fs.promises.mkdir(filesDir, { recursive: true });

      // Sanitize filename and add timestamp prefix for uniqueness
      const safeName = path.basename(filenameHint).replace(/[^\w.\-]/g, '_') || 'file';
      const filename = `${Math.floor(Date.now() / 1000)}_${safeName}`;
      const filePath = path.join(filesDir, filename);

      // Path traversal guard
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(path.resolve(filesDir))) {
        logger.warn({ filePath, filesDir }, 'NapCat: path traversal detected');
        return null;
      }

      // Check if the URL is actually a local file path (NapCat sometimes returns local paths)
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        // Local file path — copy instead of HTTP download
        try {
          await fs.promises.access(url, fs.constants.R_OK);
          await fs.promises.copyFile(url, filePath);
          logger.info({ filePath, source: url }, 'NapCat: file copied from local path');
          return filePath;
        } catch (copyErr) {
          logger.warn({ source: url, err: copyErr }, 'NapCat: local file copy failed');
          return null;
        }
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok || !response.body) {
          logger.warn({ url, status: response.status }, 'NapCat: file download failed');
          return null;
        }

        const readable = Readable.fromWeb(response.body as any);
        await pipeline(readable, fs.createWriteStream(filePath));
        logger.info({ filePath, url }, 'NapCat: file downloaded');
        return filePath;
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      logger.error({ err, url, groupFolder }, 'NapCat: file download error');
      return null;
    }
  }

  /**
   * Resolve the download URL for a file segment.
   * Tries segment.data.url first, then falls back to OneBot API.
   */
  private async resolveFileUrl(
    segment: OneBotSegment,
  ): Promise<{ url: string; filename: string } | null> {
    // Direct URL (most common for NapCat)
    if (segment.data.url) {
      const filename =
        segment.data.name ||
        segment.data.file_name ||
        segment.data.file ||
        `${segment.type}_file`;
      return { url: segment.data.url, filename };
    }

    // Fallback: call OneBot API to get the file URL
    const fileId = segment.data.file_id || segment.data.file;
    if (!fileId) return null;

    const apiMap: Record<string, string> = {
      image: 'get_image',
      record: 'get_record',
      video: 'get_file',
      file: 'get_file',
    };
    const action = apiMap[segment.type];
    if (!action) return null;

    try {
      const resp = await this.callApi(action, { file_id: fileId, file: fileId });
      if (resp.retcode === 0 && resp.data) {
        const url = resp.data.url || resp.data.file;
        const filename =
          resp.data.file_name ||
          resp.data.name ||
          segment.data.name ||
          segment.data.file ||
          `${segment.type}_file`;
        if (url) return { url, filename };
      }
    } catch (err) {
      logger.debug({ err, segment: segment.type }, 'NapCat: API file resolve failed');
    }

    return null;
  }

  /**
   * Extract content from message segments, downloading files for registered groups.
   * Falls back to placeholder text on any download failure.
   */
  private async extractContentWithFiles(
    message: OneBotSegment[] | string,
    rawMessage: string,
    groupFolder: string,
  ): Promise<string> {
    if (typeof message === 'string') {
      return message;
    }

    if (!Array.isArray(message) || message.length === 0) {
      return rawMessage || '';
    }

    const fileTypes = new Set(['image', 'record', 'video', 'file']);
    const parts: string[] = [];

    for (const seg of message) {
      if (fileTypes.has(seg.type)) {
        // Attempt to download the file
        const resolved = await this.resolveFileUrl(seg);
        if (resolved) {
          const localPath = await this.downloadFile(
            resolved.url,
            groupFolder,
            resolved.filename,
          );
          if (localPath) {
            // Map host path to container path: groups/{folder}/files/xxx -> /workspace/group/files/xxx
            const relativePath = path.relative(
              path.join(this.groupsDir, groupFolder),
              localPath,
            );
            const containerPath = `/workspace/group/${relativePath}`;
            const label =
              seg.type === 'image'
                ? 'Image'
                : seg.type === 'record'
                  ? 'Voice'
                  : seg.type === 'video'
                    ? 'Video'
                    : 'File';
            parts.push(`[${label}: ${containerPath}]`);
            continue;
          }
        }
        // Fallback to placeholder
        switch (seg.type) {
          case 'image':
            parts.push('[Image]');
            break;
          case 'record':
            parts.push('[Voice]');
            break;
          case 'video':
            parts.push('[Video]');
            break;
          case 'file':
            parts.push(`[File: ${seg.data.name || seg.data.file || ''}]`);
            break;
        }
      } else {
        // Handle non-file segments identically to extractTextContent
        switch (seg.type) {
          case 'text':
            parts.push(seg.data.text || '');
            break;
          case 'at':
            if (seg.data.qq === 'all') {
              parts.push('@all');
            } else {
              parts.push(`@${seg.data.qq}`);
            }
            break;
          case 'face':
            parts.push('[QQ Face]');
            break;
          case 'share':
            parts.push(`[Link: ${seg.data.title || seg.data.url || ''}]`);
            break;
          case 'location':
            parts.push(`[Location: ${seg.data.title || ''}]`);
            break;
          case 'reply':
            break;
          case 'forward':
            parts.push('[Forward message]');
            break;
          case 'json':
            parts.push('[JSON message]');
            break;
          case 'xml':
            parts.push('[XML message]');
            break;
          default:
            if (seg.data?.text) {
              parts.push(seg.data.text);
            }
            break;
        }
      }
    }

    return parts.join('').trim() || rawMessage || '';
  }

  private async handleMessage(event: OneBotMessageEvent): Promise<void> {
    const chatJid = buildJid(event);
    const timestamp = new Date(event.time * 1000).toISOString();

    // Determine sender name: prefer card (group nickname) > nickname > user_id
    const senderName =
      event.sender.card || event.sender.nickname || String(event.user_id);
    const sender = String(event.user_id);
    const msgId = String(event.message_id);

    // Extract text content from message segments (basic, no file download)
    let content = extractTextContent(event.message, event.raw_message);

    // Determine chat name
    const isGroup = event.message_type === 'group';
    let chatName: string | undefined;
    if (isGroup && event.group_id) {
      chatName = `QQ Group ${event.group_id}`;
    } else {
      chatName = senderName;
    }

    // Record chat type for sendMessage routing (cap size to prevent unbounded growth)
    if (this.chatTypes.size >= NapCatChannel.MAX_CHAT_TYPES) {
      // Evict oldest entry
      const firstKey = this.chatTypes.keys().next().value;
      if (firstKey !== undefined) this.chatTypes.delete(firstKey);
    }
    this.chatTypes.set(chatJid, event.message_type);

    // Store chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'napcat', isGroup);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered NapCat chat',
      );
      return;
    }

    // For registered groups, re-extract content with file downloads
    if (Array.isArray(event.message) && event.message.some(
      (seg: OneBotSegment) => seg.type === 'image' || seg.type === 'record' || seg.type === 'video' || seg.type === 'file',
    )) {
      content = await this.extractContentWithFiles(
        event.message,
        event.raw_message,
        group.folder,
      );
    }

    // If bot is @mentioned in group, prepend trigger if not already matching
    if (
      isGroup &&
      this.selfId &&
      isBotMentioned(event.message, this.selfId) &&
      !TRIGGER_PATTERN.test(content)
    ) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: event.user_id === this.selfId,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'NapCat message stored',
    );
  }

  /**
   * Call an OneBot 11 API action via WebSocket.
   */
  private callApi(
    action: string,
    params: Record<string, any> = {},
  ): Promise<OneBotApiResponse> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }

      const echo = `nanoclaw_${++this.callCounter}_${Date.now()}`;
      const timer = setTimeout(() => {
        this.pendingCalls.delete(echo);
        reject(new Error(`API call ${action} timed out`));
      }, 10000);

      this.pendingCalls.set(echo, { resolve, reject, timer });

      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    try {
      const id = jid.replace(/^qq:/, '');

      // Determine if this is a group or private message
      // Use recorded chat type from received messages; fall back to 'private'
      const chatType = this.chatTypes.get(jid) || 'private';
      const isGroup = chatType === 'group';

      // Build message segments (plain text)
      const message: OneBotSegment[] = [{ type: 'text', data: { text } }];

      if (isGroup) {
        await this.callApi('send_group_msg', {
          group_id: parseInt(id, 10),
          message,
        });
      } else {
        await this.callApi('send_private_msg', {
          user_id: parseInt(id, 10),
          message,
        });
      }

      logger.info({ jid, length: text.length }, 'NapCat message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send NapCat message');
    }
  }

  /**
   * Send a file (image, voice, video, or document) to a chat.
   * Reads the file from disk, base64-encodes it, and sends via OneBot API.
   */
  async sendFile(
    jid: string,
    filePath: string,
    type: 'image' | 'record' | 'video' | 'file' = 'file',
  ): Promise<void> {
    const MAX_FILE_SIZE = 30 * 1024 * 1024; // 30MB

    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > MAX_FILE_SIZE) {
        logger.warn(
          { jid, filePath, size: stat.size },
          'NapCat: file too large to send (>30MB)',
        );
        return;
      }

      const fileData = await fs.promises.readFile(filePath);
      const base64 = fileData.toString('base64');
      const filename = path.basename(filePath);

      const id = jid.replace(/^qq:/, '');
      const chatType = this.chatTypes.get(jid) || 'private';
      const isGroup = chatType === 'group';

      const segment: OneBotSegment = {
        type,
        data: {
          file: `base64://${base64}`,
          name: filename,
        },
      };

      if (isGroup) {
        await this.callApi('send_group_msg', {
          group_id: parseInt(id, 10),
          message: [segment],
        });
      } else {
        await this.callApi('send_private_msg', {
          user_id: parseInt(id, 10),
          message: [segment],
        });
      }

      logger.info({ jid, filePath, type }, 'NapCat file sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Failed to send NapCat file');
    }
  }

  isConnected(): boolean {
    return (
      this.connected &&
      this.ws !== null &&
      this.ws.readyState === WebSocket.OPEN
    );
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('qq:');
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.rejectAllPendingCalls('Channel disconnecting');

    const ws = this.ws;
    this.ws = null;
    this.connected = false;

    if (ws) {
      ws.close();
      logger.info('NapCat WebSocket disconnected');
    }
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // QQ/OneBot 11 does not have a standard typing indicator API
    // This is intentionally a no-op
  }

  /**
   * Sync group names from QQ. Fetches group list and updates metadata.
   */
  async syncGroups(_force: boolean): Promise<void> {
    if (!this.isConnected()) return;

    try {
      const resp = await this.callApi('get_group_list');
      if (resp.retcode === 0 && Array.isArray(resp.data)) {
        const registered = this.opts.registeredGroups();
        for (const group of resp.data) {
          const jid = `qq:${group.group_id}`;
          if (registered[jid]) {
            this.opts.onChatMetadata(
              jid,
              new Date().toISOString(),
              group.group_name,
              'napcat',
              true,
            );
          }
        }
        logger.info({ count: resp.data.length }, 'NapCat group list synced');
      }
    } catch (err) {
      logger.debug({ err }, 'Failed to sync NapCat groups');
    }
  }
}

registerChannel('napcat', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['NAPCAT_WS_URL', 'NAPCAT_ACCESS_TOKEN']);
  const wsUrl = process.env.NAPCAT_WS_URL || envVars.NAPCAT_WS_URL || '';
  const accessToken =
    process.env.NAPCAT_ACCESS_TOKEN || envVars.NAPCAT_ACCESS_TOKEN || '';

  if (!wsUrl) {
    logger.warn('NapCat: NAPCAT_WS_URL not set');
    return null;
  }

  return new NapCatChannel(wsUrl, accessToken, opts);
});
