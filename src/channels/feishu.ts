/**
 * Feishu (Lark) channel for NanoClaw.
 *
 * Connects via WebSocket long-connection (no public server needed).
 * Uses the official @larksuiteoapi/node-sdk.
 *
 * Environment variables:
 *   FEISHU_APP_ID     - Feishu app ID from open platform
 *   FEISHU_APP_SECRET - Feishu app secret
 *   FEISHU_DOMAIN     - Optional: "feishu" (default) or "lark" for international
 */

import * as Lark from '@larksuiteoapi/node-sdk';

import { logger } from '../logger.js';
import type { Channel, NewMessage } from '../types.js';
import type { ChannelOpts } from './registry.js';
import { registerChannel } from './registry.js';

const JID_PREFIX = 'fs:';
const TEXT_CHUNK_LIMIT = 4000;

/** Deduplicate messages by ID (simple LRU set). */
const seenMessages = new Set<string>();
const MAX_SEEN = 500;

function isDuplicate(messageId: string | undefined): boolean {
  if (!messageId) return false;
  if (seenMessages.has(messageId)) return true;
  seenMessages.add(messageId);
  if (seenMessages.size > MAX_SEEN) {
    const first = seenMessages.values().next().value;
    if (first !== undefined) seenMessages.delete(first);
  }
  return false;
}

/** Resolve receive_id_type from Feishu ID prefix. */
function resolveReceiveIdType(
  id: string,
): 'chat_id' | 'open_id' | 'union_id' {
  if (id.startsWith('ou_')) return 'open_id';
  if (id.startsWith('on_')) return 'union_id';
  return 'chat_id';
}

/** Split long text into chunks respecting newlines and spaces. */
function chunkText(text: string, limit: number = TEXT_CHUNK_LIMIT): string[] {
  if (!text || text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const lastNewline = window.lastIndexOf('\n');
    const lastSpace = window.lastIndexOf(' ');
    let breakIdx = lastNewline > 0 ? lastNewline : lastSpace;
    if (breakIdx <= 0) breakIdx = limit;
    const chunk = remaining.slice(0, breakIdx).trimEnd();
    if (chunk.length > 0) chunks.push(chunk);
    const brokeOnSep =
      breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
    remaining = remaining
      .slice(breakIdx + (brokeOnSep ? 1 : 0))
      .trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

class FeishuChannel implements Channel {
  name = 'feishu';
  private client: InstanceType<typeof Lark.Client>;
  private wsClient: InstanceType<typeof Lark.WSClient> | null = null;
  private connected = false;
  private opts: ChannelOpts;
  private appId: string;
  private appSecret: string;
  private domain: string;

  constructor(
    opts: ChannelOpts,
    appId: string,
    appSecret: string,
    domain: string,
  ) {
    this.opts = opts;
    this.appId = appId;
    this.appSecret = appSecret;
    this.domain = domain;

    this.client = new Lark.Client({
      appId,
      appSecret,
      domain:
        domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      appType: Lark.AppType.SelfBuild,
    });
  }

  async connect(): Promise<void> {
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data: unknown) => {
        this.handleMessage(data as Record<string, unknown>).catch((err) => {
          logger.error(
            { err, channel: 'feishu' },
            'Feishu message handler error',
          );
        });
      },
    });

    this.wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain:
        this.domain === 'lark' ? Lark.Domain.Lark : Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.warn,
    });

    this.wsClient.start({ eventDispatcher: dispatcher });
    this.connected = true;
    logger.info(
      { channel: 'feishu', domain: this.domain },
      'Feishu WebSocket client started',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.startsWith(JID_PREFIX) ? jid.slice(JID_PREFIX.length) : jid;
    if (!chatId.trim()) return;

    const chunks = chunkText(text);
    for (const chunk of chunks) {
      try {
        await this.client.im.message.create({
          params: { receive_id_type: resolveReceiveIdType(chatId.trim()) },
          data: {
            receive_id: chatId.trim(),
            msg_type: 'text',
            content: JSON.stringify({ text: chunk }),
          },
        });
      } catch (err) {
        logger.error(
          { err, channel: 'feishu', chatId },
          'Failed to send Feishu message',
        );
        throw err;
      }
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.wsClient = null;
    logger.info({ channel: 'feishu' }, 'Feishu channel disconnected');
  }

  /** Handle an incoming Feishu message event. */
  private async handleMessage(data: Record<string, unknown>): Promise<void> {
    const message = (data as { message?: Record<string, unknown> }).message;
    if (!message) return;

    const chatId = message.chat_id as string | undefined;
    if (!chatId) return;

    const messageId = message.message_id as string | undefined;
    if (isDuplicate(messageId)) return;

    // Only handle text messages
    const messageType = message.message_type as string | undefined;
    if (messageType !== 'text' || !message.content) return;

    let text: string;
    try {
      const parsed = JSON.parse(message.content as string) as {
        text?: string;
      };
      text = (parsed.text ?? '').trim();
    } catch {
      return;
    }
    if (!text) return;

    const chatType = message.chat_type as string | undefined;
    const sender = (data as { sender?: { sender_id?: { open_id?: string } } })
      .sender;
    const senderId = sender?.sender_id?.open_id ?? '';

    // In group chats, strip @mention placeholders
    if (chatType === 'group') {
      text = text.replace(/@_user_\d+\s*/g, '').trim();
      if (!text) return;
    }

    const jid = `${JID_PREFIX}${chatId}`;
    const timestamp = new Date().toISOString();

    const msg: NewMessage = {
      id: messageId ?? `fs_${Date.now()}`,
      chat_jid: jid,
      sender: senderId,
      sender_name: '',
      content: text,
      timestamp,
      is_from_me: false,
    };

    logger.debug(
      { channel: 'feishu', chatId, senderId, textLength: text.length },
      'Feishu message received',
    );

    this.opts.onMessage(jid, msg);
    this.opts.onChatMetadata(
      jid,
      timestamp,
      undefined,
      'feishu',
      chatType === 'group',
    );
  }
}

// --- Self-registration ---
// The channel is automatically enabled when FEISHU_APP_ID is set.
registerChannel('feishu', (opts) => {
  const appId = process.env.FEISHU_APP_ID?.trim();
  const appSecret = process.env.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) return null;

  const domain = (process.env.FEISHU_DOMAIN ?? 'feishu').toLowerCase();
  return new FeishuChannel(opts, appId, appSecret, domain);
});
