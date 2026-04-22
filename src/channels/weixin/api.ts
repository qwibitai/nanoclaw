/**
 * WeChat iLink HTTP API wrapper.
 *
 * Ported from @tencent-weixin/openclaw-weixin v1.0.3 (src/api/api.ts,
 * src/auth/login-qr.ts). Adapted for NanoClaw: OpenClaw SDK dependencies
 * removed (logger, redact, config-route-tag), Node's native fetch used
 * directly, all state and persistence moved to the caller.
 */
import crypto from 'node:crypto';

import { logger } from '../../logger.js';

import type {
  GetUpdatesResp,
  GetUploadUrlReq,
  GetUploadUrlResp,
  QRCodeResponse,
  QRStatusResponse,
  SendMessageReq,
  WeixinMessage,
} from './types.js';
import { MessageItemType, MessageState, MessageType } from './types.js';

const CHANNEL_VERSION = 'nanoclaw-weixin/0.1.0';

/**
 * Values copied from the Tencent `@tencent-weixin/openclaw-weixin` v2.1.9
 * package.json — the iLink backend (and the CDN it redirects you to) checks
 * both of these headers. Mismatched / missing values surface as opaque
 * 500 / -5102031 CDN errors, so keep them in sync with the upstream plugin.
 */
const ILINK_APP_ID = 'bot';
/** 2.1.9 -> (2<<16) | (1<<8) | 9 = 131593. */
const ILINK_APP_CLIENT_VERSION = (2 << 16) | (1 << 8) | 9;

/** Tencent's public iLink bot backend. No auth/approval needed to hit it. */
export const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com';

/** Tencent's public iLink CDN for encrypted media upload/download. */
export const DEFAULT_WEIXIN_CDN_BASE_URL =
  'https://novac2c.cdn.weixin.qq.com/c2c';

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;

export const DEFAULT_ILINK_BOT_TYPE = '3';

export interface WeixinApiOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  };
  if (body) {
    headers['Content-Length'] = String(Buffer.byteLength(body, 'utf-8'));
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function apiPost(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
  label: string;
}): Promise<string> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: buildHeaders(params.token, params.body),
      body: params.body,
      signal: controller.signal,
    });
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(
        `${params.label} ${res.status}: ${rawText.slice(0, 200)}`,
      );
    }
    return rawText;
  } finally {
    clearTimeout(timer);
  }
}

async function apiGet(params: {
  baseUrl: string;
  endpoint: string;
  timeoutMs: number;
  label: string;
}): Promise<string> {
  const url = new URL(params.endpoint, ensureTrailingSlash(params.baseUrl));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      headers: {
        'iLink-App-Id': ILINK_APP_ID,
        'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
      },
      signal: controller.signal,
    });
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(
        `${params.label} ${res.status}: ${rawText.slice(0, 200)}`,
      );
    }
    return rawText;
  } finally {
    clearTimeout(timer);
  }
}

export async function getUpdates(
  opts: WeixinApiOptions & {
    get_updates_buf?: string;
    longPollTimeoutMs?: number;
  },
): Promise<GetUpdatesResp> {
  const timeout = opts.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const raw = await apiPost({
      baseUrl: opts.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: opts.get_updates_buf ?? '',
        base_info: { channel_version: CHANNEL_VERSION },
      }),
      token: opts.token,
      timeoutMs: timeout,
      label: 'getUpdates',
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: opts.get_updates_buf };
    }
    throw err;
  }
}

export async function getUploadUrl(
  opts: WeixinApiOptions & GetUploadUrlReq,
): Promise<GetUploadUrlResp> {
  const raw = await apiPost({
    baseUrl: opts.baseUrl,
    endpoint: 'ilink/bot/getuploadurl',
    body: JSON.stringify({
      filekey: opts.filekey,
      media_type: opts.media_type,
      to_user_id: opts.to_user_id,
      rawsize: opts.rawsize,
      rawfilemd5: opts.rawfilemd5,
      filesize: opts.filesize,
      thumb_rawsize: opts.thumb_rawsize,
      thumb_rawfilemd5: opts.thumb_rawfilemd5,
      thumb_filesize: opts.thumb_filesize,
      no_need_thumb: opts.no_need_thumb,
      aeskey: opts.aeskey,
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: 'getUploadUrl',
  });
  return JSON.parse(raw) as GetUploadUrlResp;
}

export async function sendMessage(
  opts: WeixinApiOptions & {
    body: SendMessageReq;
  },
): Promise<void> {
  await apiPost({
    baseUrl: opts.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify({
      ...opts.body,
      base_info: { channel_version: CHANNEL_VERSION },
    }),
    token: opts.token,
    timeoutMs: opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: 'sendMessage',
  });
}

/** Build a SendMessageReq carrying a single plain-text item. */
export function buildTextMessage(params: {
  to: string;
  text: string;
  contextToken?: string;
  clientId: string;
}): SendMessageReq {
  const msg: WeixinMessage = {
    from_user_id: '',
    to_user_id: params.to,
    client_id: params.clientId,
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    item_list: params.text
      ? [{ type: MessageItemType.TEXT, text_item: { text: params.text } }]
      : undefined,
    context_token: params.contextToken,
  };
  return { msg };
}

export async function fetchQRCode(
  baseUrl: string,
  botType = DEFAULT_ILINK_BOT_TYPE,
): Promise<QRCodeResponse> {
  const raw = await apiGet({
    baseUrl,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: 'fetchQRCode',
  });
  return JSON.parse(raw) as QRCodeResponse;
}

export async function pollQRStatus(
  baseUrl: string,
  qrcode: string,
): Promise<QRStatusResponse> {
  try {
    const raw = await apiGet({
      baseUrl,
      endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      timeoutMs: QR_LONG_POLL_TIMEOUT_MS,
      label: 'pollQRStatus',
    });
    return JSON.parse(raw) as QRStatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'wait' };
    }
    logger.warn({ err: String(err) }, 'pollQRStatus error');
    throw err;
  }
}
