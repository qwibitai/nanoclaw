/**
 * WeChat iLink protocol types (subset).
 *
 * Ported from @tencent-weixin/openclaw-weixin v1.0.3 (src/api/types.ts).
 * MVP subset: only the fields used for text getUpdates / sendMessage.
 * Media (image/voice/file/video) fields are kept in enums but not currently
 * decoded or constructed — they remain as pass-through for forward compat.
 */

export interface BaseInfo {
  channel_version?: string;
}

export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export interface TextItem {
  text?: string;
}

export interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  // Media items are present in the protocol but not decoded in MVP.
  // They're kept as unknown pass-through so we don't crash on receive.
  image_item?: unknown;
  voice_item?: { text?: string; [k: string]: unknown };
  file_item?: unknown;
  video_item?: unknown;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

export interface GetUpdatesReq {
  get_updates_buf?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface SendMessageReq {
  msg?: WeixinMessage;
}

/** QR login responses from ilink/bot/get_bot_qrcode and ilink/bot/get_qrcode_status. */
export interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export type QRStatus = 'wait' | 'scaned' | 'confirmed' | 'expired';

export interface QRStatusResponse {
  status: QRStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}
