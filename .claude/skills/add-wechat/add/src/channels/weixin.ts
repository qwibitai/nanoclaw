import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ASSISTANT_NAME, DATA_DIR, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  item_list?: MessageItem[];
  context_token?: string;
  message_type?: number;
  message_state?: number;
}

interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: unknown;
  voice_item?: { text?: string };
  file_item?: { file_name?: string };
  ref_msg?: { title?: string; message_item?: MessageItem };
}

const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
const MessageType = { BOT: 2 } as const;
const MessageState = { FINISH: 2 } as const;

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

interface AccountData {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
}

export interface WeixinChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = 'https://ilinkai.weixin.qq.com';
const CHANNEL_VERSION = '1.0.0';
const ILINK_APP_ID = 'bot';
const ILINK_APP_CLIENT_VERSION = (1 << 16) | (0 << 8) | 0; // 1.0.0
const LONG_POLL_TIMEOUT_MS = 35_000;
const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_PAUSE_MS = 60 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const MAX_MSG_LENGTH = 4000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function weixinStateDir(): string {
  return path.join(DATA_DIR, 'weixin');
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function generateClientId(): string {
  return `nanoclaw-wx-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function buildCommonHeaders(): Record<string, string> {
  return {
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
  };
}

function buildPostHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...buildCommonHeaders(),
  };
  if (body) headers['Content-Length'] = String(Buffer.byteLength(body, 'utf-8'));
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

function extractTextBody(itemList?: MessageItem[]): string {
  if (!itemList?.length) return '';
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (!parts.length) return text;
      return `[引用: ${parts.join(' | ')}]\n${text}`;
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return '';
}

function describeNonTextItem(item: MessageItem): string | null {
  switch (item.type) {
    case MessageItemType.IMAGE: return '[图片]';
    case MessageItemType.VOICE: return item.voice_item?.text || '[语音]';
    case MessageItemType.FILE: return `[文件: ${item.file_item?.file_name || 'unknown'}]`;
    case MessageItemType.VIDEO: return '[视频]';
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Account persistence
// ---------------------------------------------------------------------------

function loadAccount(): AccountData | null {
  const filePath = path.join(weixinStateDir(), 'account.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AccountData;
  } catch {
    return null;
  }
}

function saveAccount(data: AccountData): void {
  const dir = weixinStateDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'account.json');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
}

function loadSyncBuf(): string {
  const filePath = path.join(weixinStateDir(), 'sync.json');
  try {
    if (!fs.existsSync(filePath)) return '';
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as { get_updates_buf?: string };
    return data.get_updates_buf || '';
  } catch {
    return '';
  }
}

function saveSyncBuf(buf: string): void {
  const dir = weixinStateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'sync.json'),
    JSON.stringify({ get_updates_buf: buf }, null, 0),
    'utf-8',
  );
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

async function apiGet(baseUrl: string, endpoint: string, timeoutMs: number): Promise<string> {
  const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: buildCommonHeaders(),
      signal: controller.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    if (!res.ok) throw new Error(`GET ${endpoint} ${res.status}: ${text}`);
    return text;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

async function apiPost(
  baseUrl: string,
  endpoint: string,
  body: object,
  token?: string,
  timeoutMs = 15_000,
): Promise<string> {
  const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const bodyStr = JSON.stringify(body);
  const headers = buildPostHeaders(token, bodyStr);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
    clearTimeout(t);
    const text = await res.text();
    if (!res.ok) throw new Error(`POST ${endpoint} ${res.status}: ${text}`);
    return text;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// QR Login
// ---------------------------------------------------------------------------

async function loginWithQr(baseUrl: string): Promise<AccountData> {
  logger.info('Starting WeChat QR login...');
  console.log('\n  微信扫码登录...\n');

  // 1. Fetch QR code
  const qrRaw = await apiGet(baseUrl, 'ilink/bot/get_bot_qrcode?bot_type=3', 10_000);
  const qrResp = JSON.parse(qrRaw) as { qrcode: string; qrcode_img_content: string };

  if (!qrResp.qrcode_img_content) {
    throw new Error('Failed to get QR code from WeChat API');
  }

  // Print QR code to terminal
  try {
    const qrterm = await import('qrcode-terminal');
    qrterm.default.generate(qrResp.qrcode_img_content, { small: true }, (qr: string) => {
      console.log(qr);
    });
  } catch {
    // qrcode-terminal not available
  }
  console.log(`  扫码链接: ${qrResp.qrcode_img_content}\n`);
  console.log('  请使用微信扫描上方二维码...\n');

  // 2. Poll for scan result
  const deadline = Date.now() + 5 * 60_000;
  let currentBaseUrl = baseUrl;

  while (Date.now() < deadline) {
    try {
      const statusRaw = await apiGet(
        currentBaseUrl,
        `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrResp.qrcode)}`,
        35_000,
      );
      const status = JSON.parse(statusRaw) as {
        status: string;
        bot_token?: string;
        ilink_bot_id?: string;
        baseurl?: string;
        ilink_user_id?: string;
        redirect_host?: string;
      };

      switch (status.status) {
        case 'wait':
          break;
        case 'scaned':
          console.log('  👀 已扫码，请在微信上确认...');
          break;
        case 'scaned_but_redirect':
          if (status.redirect_host) {
            currentBaseUrl = `https://${status.redirect_host}`;
            logger.info({ redirectHost: status.redirect_host }, 'WeChat IDC redirect');
          }
          break;
        case 'confirmed': {
          if (!status.ilink_bot_id || !status.bot_token) {
            throw new Error('Login confirmed but missing bot_token or ilink_bot_id');
          }
          const account: AccountData = {
            token: status.bot_token,
            baseUrl: status.baseurl || currentBaseUrl,
            accountId: status.ilink_bot_id,
            userId: status.ilink_user_id,
            savedAt: new Date().toISOString(),
          };
          saveAccount(account);
          console.log('\n  ✅ 微信连接成功!\n');
          logger.info({ accountId: account.accountId }, 'WeChat login successful');
          return account;
        }
        case 'expired':
          throw new Error('QR code expired, please restart NanoClaw to retry');
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Long-poll timeout, normal
        continue;
      }
      throw err;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('WeChat login timed out');
}

// ---------------------------------------------------------------------------
// Channel class
// ---------------------------------------------------------------------------

export class WeixinChannel implements Channel {
  name = 'weixin';

  private opts: WeixinChannelOpts;
  private account: AccountData | null = null;
  private running = false;
  private abortController: AbortController | null = null;
  private contextTokens = new Map<string, string>();
  private pausedUntil = 0;

  constructor(opts: WeixinChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Load or create account
    this.account = loadAccount();
    if (!this.account) {
      this.account = await loginWithQr(BASE_URL);
    } else {
      logger.info({ accountId: this.account.accountId }, 'WeChat account loaded from disk');
      console.log(`\n  微信已连接 (account: ${this.account.accountId})\n`);
    }

    this.running = true;
    this.abortController = new AbortController();

    // Start long-poll in background
    this.pollLoop().catch((err) => {
      if (!this.abortController?.signal.aborted) {
        logger.error({ err }, 'WeChat poll loop crashed');
      }
    });
  }

  private async pollLoop(): Promise<void> {
    let getUpdatesBuf = loadSyncBuf();
    let consecutiveFailures = 0;
    let nextTimeoutMs = LONG_POLL_TIMEOUT_MS;

    logger.info('WeChat poll loop started');

    while (this.running && !this.abortController?.signal.aborted) {
      // Session pause check
      if (Date.now() < this.pausedUntil) {
        const waitMs = this.pausedUntil - Date.now();
        logger.debug({ waitMs }, 'WeChat session paused, waiting');
        await this.sleep(Math.min(waitMs, 10_000));
        continue;
      }

      try {
        const resp = await this.getUpdates(getUpdatesBuf, nextTimeoutMs);

        if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
          nextTimeoutMs = resp.longpolling_timeout_ms;
        }

        // Check for API errors
        const isError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);

        if (isError) {
          if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
            this.pausedUntil = Date.now() + SESSION_PAUSE_MS;
            logger.error('WeChat session expired, pausing for 1 hour');
            consecutiveFailures = 0;
            continue;
          }
          consecutiveFailures++;
          logger.error(
            { ret: resp.ret, errcode: resp.errcode, errmsg: resp.errmsg, failures: consecutiveFailures },
            'WeChat getUpdates failed',
          );
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            consecutiveFailures = 0;
            await this.sleep(BACKOFF_DELAY_MS);
          } else {
            await this.sleep(RETRY_DELAY_MS);
          }
          continue;
        }

        consecutiveFailures = 0;

        // Save sync buf
        if (resp.get_updates_buf) {
          saveSyncBuf(resp.get_updates_buf);
          getUpdatesBuf = resp.get_updates_buf;
        }

        // Process messages
        for (const msg of resp.msgs ?? []) {
          this.handleInboundMessage(msg);
        }
      } catch (err) {
        if (this.abortController?.signal.aborted) return;
        if (err instanceof Error && err.name === 'AbortError') {
          // Long-poll timeout, normal
          continue;
        }
        consecutiveFailures++;
        logger.error({ err, failures: consecutiveFailures }, 'WeChat getUpdates error');
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await this.sleep(BACKOFF_DELAY_MS);
        } else {
          await this.sleep(RETRY_DELAY_MS);
        }
      }
    }
    logger.info('WeChat poll loop ended');
  }

  private async getUpdates(buf: string, timeoutMs: number): Promise<GetUpdatesResp> {
    if (!this.account) throw new Error('WeChat not connected');
    try {
      const raw = await apiPost(
        this.account.baseUrl,
        'ilink/bot/getupdates',
        { get_updates_buf: buf, base_info: { channel_version: CHANNEL_VERSION } },
        this.account.token,
        timeoutMs,
      );
      return JSON.parse(raw) as GetUpdatesResp;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { ret: 0, msgs: [], get_updates_buf: buf };
      }
      throw err;
    }
  }

  private handleInboundMessage(msg: WeixinMessage): void {
    const fromUserId = msg.from_user_id ?? '';
    if (!fromUserId) return;

    // Skip bot's own messages
    if (msg.message_type === MessageType.BOT) return;

    const chatJid = `wx:${fromUserId}`;
    const timestamp = msg.create_time_ms
      ? new Date(msg.create_time_ms).toISOString()
      : new Date().toISOString();

    // Store context token
    if (msg.context_token) {
      this.contextTokens.set(fromUserId, msg.context_token);
    }

    // Extract text content
    let content = extractTextBody(msg.item_list);

    // If no text, describe non-text items
    if (!content && msg.item_list?.length) {
      const descriptions = msg.item_list
        .map(describeNonTextItem)
        .filter(Boolean);
      content = descriptions.join(' ') || '[未知消息类型]';
    }

    if (!content) return;

    // Store chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, fromUserId, 'weixin', false);

    // Check if registered
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered WeChat user');
      return;
    }

    // Deliver message
    this.opts.onMessage(chatJid, {
      id: String(msg.message_id ?? msg.seq ?? Date.now()),
      chat_jid: chatJid,
      sender: fromUserId,
      sender_name: fromUserId,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, fromUserId }, 'WeChat message stored');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.account) {
      logger.warn('WeChat not connected, cannot send message');
      return;
    }

    const userId = jid.replace(/^wx:/, '');
    const contextToken = this.contextTokens.get(userId);

    try {
      // Split long messages
      const chunks = text.length <= MAX_MSG_LENGTH
        ? [text]
        : this.splitText(text, MAX_MSG_LENGTH);

      for (const chunk of chunks) {
        const clientId = generateClientId();
        await apiPost(
          this.account.baseUrl,
          'ilink/bot/sendmessage',
          {
            msg: {
              from_user_id: '',
              to_user_id: userId,
              client_id: clientId,
              message_type: MessageType.BOT,
              message_state: MessageState.FINISH,
              item_list: [{ type: MessageItemType.TEXT, text_item: { text: chunk } }],
              context_token: contextToken,
            },
            base_info: { channel_version: CHANNEL_VERSION },
          },
          this.account.token,
        );
      }
      logger.info({ jid, length: text.length }, 'WeChat message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send WeChat message');
    }
  }

  private splitText(text: string, limit: number): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        chunks.push(remaining);
        break;
      }
      let splitAt = remaining.lastIndexOf('\n', limit);
      if (splitAt <= 0 || splitAt < limit * 0.5) splitAt = remaining.lastIndexOf(' ', limit);
      if (splitAt <= 0 || splitAt < limit * 0.5) splitAt = limit;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    return chunks;
  }

  isConnected(): boolean {
    return this.running && this.account !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('wx:');
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    this.account = null;
    logger.info('WeChat channel disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.account || !isTyping) return;
    // Typing requires a typing_ticket from getConfig — skip for now
    // as it adds complexity with minimal benefit
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.abortController?.signal.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }
}
