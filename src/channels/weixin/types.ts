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

/** CDN media reference; aes_key is base64-encoded bytes. */
export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  /** 0 = only fileid encrypted, 1 = packed thumb + mid info. */
  encrypt_type?: number;
  full_url?: string;
}

export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  /** Plaintext byte length as a decimal string. */
  len?: string;
}

export interface VideoItem {
  media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: CDNMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: { text?: string; [k: string]: unknown };
  file_item?: FileItem;
  video_item?: VideoItem;
}

/** proto: UploadMediaType */
export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

export type UploadMediaTypeValue =
  (typeof UploadMediaType)[keyof typeof UploadMediaType];

export interface GetUploadUrlReq {
  filekey?: string;
  media_type?: number;
  to_user_id?: string;
  rawsize?: number;
  rawfilemd5?: string;
  /** Ciphertext size (AES-128-ECB with PKCS7 padding). */
  filesize?: number;
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  no_need_thumb?: boolean;
  /** hex-encoded AES-128 key. */
  aeskey?: string;
}

export interface GetUploadUrlResp {
  upload_param?: string;
  thumb_upload_param?: string;
  /** Full URL preferred when the server returns it. */
  upload_full_url?: string;
}

export interface UploadedFileInfo {
  filekey: string;
  /** CDN-returned download encrypted_query_param. */
  downloadEncryptedQueryParam: string;
  /** Hex-encoded AES-128 key. */
  aeskey: string;
  /** Plaintext size in bytes. */
  fileSize: number;
  /** Ciphertext size in bytes (AES-128-ECB padded). */
  fileSizeCiphertext: number;
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
