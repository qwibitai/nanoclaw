/**
 * Inbound message parsing for WeChat.
 *
 * Converts a WeixinMessage from the getUpdates long-poll into the NanoClaw
 * NewMessage shape that the router can persist and route. Media items are
 * collapsed into a placeholder string in MVP — full decryption/download is
 * deferred (requires AES-128-ECB + SILK transcoding from the upstream plugin).
 */
import crypto from 'node:crypto';

import { NewMessage } from '../../types.js';

import type { MessageItem, WeixinMessage } from './types.js';
import { MessageItemType } from './types.js';

function isMediaItem(item: MessageItem): boolean {
  return (
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VIDEO ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VOICE
  );
}

function mediaPlaceholder(item: MessageItem): string {
  switch (item.type) {
    case MessageItemType.IMAGE:
      return '[图片]';
    case MessageItemType.VIDEO:
      return '[视频]';
    case MessageItemType.FILE:
      return '[文件]';
    case MessageItemType.VOICE:
      return '[语音]';
    default:
      return '[媒体]';
  }
}

function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) return '';
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      if (ref.message_item && isMediaItem(ref.message_item)) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const inner = bodyFromItemList([ref.message_item]);
        if (inner) parts.push(inner);
      }
      if (!parts.length) return text;
      return `[引用: ${parts.join(' | ')}]\n${text}`;
    }
    // Voice-to-text: use transcript when provided by upstream.
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return String(item.voice_item.text);
    }
  }
  // No text found — surface a media placeholder so Claude at least knows
  // something was sent.
  const mediaItem = itemList.find(isMediaItem);
  if (mediaItem) return mediaPlaceholder(mediaItem);
  return '';
}

export interface ParsedInbound {
  jid: string;
  message: NewMessage;
  contextToken?: string;
}

export function parseWeixinMessage(
  msg: WeixinMessage,
  ownBotUserId: string | undefined,
): ParsedInbound | null {
  const fromUserId = msg.from_user_id ?? '';
  if (!fromUserId) return null;
  if (ownBotUserId && fromUserId === ownBotUserId) return null;

  const content = bodyFromItemList(msg.item_list);
  if (!content) return null;

  const ts = msg.create_time_ms ?? Date.now();
  const timestamp = new Date(ts).toISOString();
  const jid = `wx:${fromUserId}`;

  const id =
    msg.client_id?.trim() ||
    (msg.message_id != null ? String(msg.message_id) : undefined) ||
    crypto.randomUUID();

  return {
    jid,
    message: {
      id,
      chat_jid: jid,
      sender: fromUserId,
      sender_name: fromUserId,
      content,
      timestamp,
      is_from_me: false,
    },
    contextToken: msg.context_token,
  };
}
