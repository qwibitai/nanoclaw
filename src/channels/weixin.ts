/**
 * NanoClaw WeChat channel.
 *
 * Wraps the iLink HTTP protocol (ported from @tencent-weixin/openclaw-weixin)
 * into NanoClaw's Channel interface. Credentials are obtained via a separate
 * QR-code login step (scripts/weixin-login.ts) and persisted to STORE_DIR.
 *
 * JID scheme: `wx:<ilink_user_id>`. WeChat iLink bot chats are 1-on-1 only,
 * so every JID is a direct chat.
 */
import crypto from 'node:crypto';

import { logger } from '../logger.js';
import { Channel } from '../types.js';

import {
  buildTextMessage,
  sendMessage as sendMessageApi,
} from './weixin/api.js';
import { runMonitorLoop } from './weixin/monitor.js';
import { registerChannel } from './registry.js';
import {
  getDefaultAccount,
  loadContextTokens,
  loadWeixinAccount,
  saveContextTokens,
} from './weixin/storage.js';

const WX_JID_PREFIX = 'wx:';

export class WeixinChannel implements Channel {
  readonly name = 'weixin';

  private accountId: string;
  private baseUrl: string;
  private token: string;

  private contextTokens: Record<string, string>;
  private abortController: AbortController | null = null;
  private monitorDone: Promise<void> | null = null;
  private connected = false;

  private onMessage: (
    chatJid: string,
    message: import('../types.js').NewMessage,
  ) => void;
  private onChatMetadata: import('../types.js').OnChatMetadata;

  constructor(
    accountId: string,
    account: { token: string; baseUrl: string; userId?: string },
    callbacks: {
      onMessage: (
        chatJid: string,
        message: import('../types.js').NewMessage,
      ) => void;
      onChatMetadata: import('../types.js').OnChatMetadata;
    },
  ) {
    this.accountId = accountId;
    this.baseUrl = account.baseUrl;
    this.token = account.token;
    this.contextTokens = loadContextTokens(accountId);
    this.onMessage = callbacks.onMessage;
    this.onChatMetadata = callbacks.onChatMetadata;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(WX_JID_PREFIX);
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.abortController = new AbortController();
    this.connected = true;

    this.monitorDone = runMonitorLoop({
      accountId: this.accountId,
      baseUrl: this.baseUrl,
      token: this.token,
      abortSignal: this.abortController.signal,
      onInbound: (parsed) => {
        if (parsed.contextToken) {
          this.contextTokens[parsed.message.sender] = parsed.contextToken;
          saveContextTokens(this.accountId, this.contextTokens);
        }
        this.onChatMetadata(
          parsed.jid,
          parsed.message.timestamp,
          undefined,
          this.name,
          false,
        );
        this.onMessage(parsed.jid, parsed.message);
      },
    });

    logger.info(
      { accountId: this.accountId, baseUrl: this.baseUrl },
      'weixin channel connected',
    );
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    this.abortController?.abort();
    if (this.monitorDone) {
      try {
        await this.monitorDone;
      } catch {
        // monitor loop exits via its own abort handling — ignore
      }
    }
    this.abortController = null;
    this.monitorDone = null;
    logger.info({ accountId: this.accountId }, 'weixin channel disconnected');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.ownsJid(jid)) {
      throw new Error(`weixin: not owner of jid ${jid}`);
    }
    const userId = jid.slice(WX_JID_PREFIX.length);
    const contextToken = this.contextTokens[userId];
    if (!contextToken) {
      logger.warn(
        { accountId: this.accountId, userId },
        'weixin sendMessage: no contextToken cached — reply may be rejected by server',
      );
    }

    const req = buildTextMessage({
      to: userId,
      text,
      contextToken,
      clientId: crypto.randomUUID(),
    });

    try {
      await sendMessageApi({
        baseUrl: this.baseUrl,
        token: this.token,
        body: req,
      });
      logger.info(
        {
          accountId: this.accountId,
          userId,
          len: text.length,
          hasContextToken: Boolean(contextToken),
        },
        'weixin sendMessage ok',
      );
    } catch (err) {
      logger.error(
        { accountId: this.accountId, userId, err: String(err) },
        'weixin sendMessage failed',
      );
      throw err;
    }
  }
}

registerChannel('weixin', ({ onMessage, onChatMetadata }) => {
  const accountId = getDefaultAccount();
  if (!accountId) {
    logger.info(
      'weixin channel not configured (no account logged in) — skipping',
    );
    return null;
  }
  const account = loadWeixinAccount(accountId);
  if (!account?.token || !account.baseUrl) {
    logger.warn({ accountId }, 'weixin account file is incomplete — skipping');
    return null;
  }
  return new WeixinChannel(accountId, account, { onMessage, onChatMetadata });
});
