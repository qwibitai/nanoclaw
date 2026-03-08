import WebSocket from 'ws';

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

type OneBotEvent = OneBotMessageEvent | OneBotMetaEvent | { post_type: string; [key: string]: any };

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
    (seg) =>
      seg.type === 'at' &&
      String(seg.data.qq) === String(selfId),
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
  private pendingCalls = new Map<string, {
    resolve: (value: OneBotApiResponse) => void;
    reject: (reason: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private callCounter = 0;

  constructor(wsUrl: string, accessToken: string, opts: NapCatChannelOpts) {
    this.wsUrl = wsUrl;
    this.accessToken = accessToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = this.accessToken
        ? `${this.wsUrl}?access_token=${this.accessToken}`
        : this.wsUrl;

      this.ws = new WebSocket(url);

      const connectTimeout = setTimeout(() => {
        if (!this.connected) {
          this.ws?.close();
          reject(new Error('NapCat WebSocket connection timeout'));
        }
      }, 15000);

      this.ws.on('open', () => {
        logger.info({ url: this.wsUrl }, 'NapCat WebSocket connected');
      });

      this.ws.on('message', (data: WebSocket.Data) => {
        try {
          const event = JSON.parse(data.toString()) as OneBotEvent | OneBotApiResponse;

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
              if (metaEvent.meta_event_type === 'lifecycle' && metaEvent.sub_type === 'connect') {
                this.selfId = metaEvent.self_id;
                this.connected = true;
                clearTimeout(connectTimeout);
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
              this.handleMessage(event as OneBotMessageEvent);
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
        for (const [echo, pending] of this.pendingCalls) {
          clearTimeout(pending.timer);
          pending.reject(new Error('WebSocket closed'));
          this.pendingCalls.delete(echo);
        }

        // Auto-reconnect after 5 seconds
        if (this.ws) {
          this.scheduleReconnect();
        }
      });

      // If no lifecycle event within 5s but WS is open, resolve anyway
      // (some NapCat configs may not send lifecycle events)
      setTimeout(() => {
        if (!this.connected && this.ws?.readyState === WebSocket.OPEN) {
          this.connected = true;
          clearTimeout(connectTimeout);
          logger.info('NapCat connected (no lifecycle event received)');
          console.log(`\n  NapCat QQ bot connected`);
          console.log(`  Connected to: ${this.wsUrl}\n`);
          resolve();
        }
      }, 5000);
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

  private handleMessage(event: OneBotMessageEvent): void {
    const chatJid = buildJid(event);
    const timestamp = new Date(event.time * 1000).toISOString();

    // Determine sender name: prefer card (group nickname) > nickname > user_id
    const senderName =
      event.sender.card || event.sender.nickname || String(event.user_id);
    const sender = String(event.user_id);
    const msgId = String(event.message_id);

    // Extract text content from message segments
    let content = extractTextContent(event.message, event.raw_message);

    // Determine chat name
    const isGroup = event.message_type === 'group';
    let chatName: string | undefined;
    if (isGroup && event.group_id) {
      chatName = `QQ Group ${event.group_id}`;
    } else {
      chatName = senderName;
    }

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
  private callApi(action: string, params: Record<string, any> = {}): Promise<OneBotApiResponse> {
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('NapCat WebSocket not connected');
      return;
    }

    try {
      const id = jid.replace(/^qq:/, '');

      // Determine if this is a group or private message
      // Group IDs in QQ are typically large numbers; we check registered groups
      const group = this.opts.registeredGroups()[jid];
      const isGroup = group !== undefined;

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

  isConnected(): boolean {
    return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('qq:');
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending API calls
    for (const [echo, pending] of this.pendingCalls) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Channel disconnecting'));
      this.pendingCalls.delete(echo);
    }

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
        for (const group of resp.data) {
          const jid = `qq:${group.group_id}`;
          const registeredGroup = this.opts.registeredGroups()[jid];
          if (registeredGroup) {
            this.opts.onChatMetadata(
              jid,
              new Date().toISOString(),
              group.group_name,
              'napcat',
              true,
            );
          }
        }
        logger.info(
          { count: resp.data.length },
          'NapCat group list synced',
        );
      }
    } catch (err) {
      logger.debug({ err }, 'Failed to sync NapCat groups');
    }
  }
}

registerChannel('napcat', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['NAPCAT_WS_URL', 'NAPCAT_ACCESS_TOKEN']);
  const wsUrl =
    process.env.NAPCAT_WS_URL || envVars.NAPCAT_WS_URL || '';
  const accessToken =
    process.env.NAPCAT_ACCESS_TOKEN || envVars.NAPCAT_ACCESS_TOKEN || '';

  if (!wsUrl) {
    logger.warn('NapCat: NAPCAT_WS_URL not set');
    return null;
  }

  return new NapCatChannel(wsUrl, accessToken, opts);
});
