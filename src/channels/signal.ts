/**
 * Signal channel for NanoClaw via signal-cli JSON-RPC daemon.
 *
 * Requires:
 *   - signal-cli running in daemon mode: signal-cli -a <account> daemon --http localhost:8080
 *   - Environment: SIGNAL_ACCOUNT (phone number, e.g. +17733409232)
 *   - Optional:    SIGNAL_CLI_URL  (default: http://127.0.0.1:8080)
 */

import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/** How often to poll signal-cli for new messages (ms). */
const SIGNAL_POLL_INTERVAL = 2000;

/** Signal has no hard limit, but keep chunks reasonable. */
const SIGNAL_MAX_MESSAGE_LENGTH = 4000;

// ---------- signal-cli envelope types ----------

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceName?: string;
  sourceUuid?: string;
  timestamp?: number;
  dataMessage?: SignalDataMessage;
  typingMessage?: { action?: string; groupId?: string };
  receiptMessage?: { type?: string; timestamps?: number[] };
}

interface SignalDataMessage {
  message?: string;
  timestamp?: number;
  groupInfo?: { groupId?: string; type?: string };
  attachments?: Array<{
    contentType?: string;
    filename?: string;
    id?: string;
    size?: number;
  }>;
  quote?: {
    id?: number;
    author?: string;
    authorNumber?: string;
    text?: string;
  };
}

// ---------- channel implementation ----------

export class SignalChannel implements Channel {
  name = 'signal';

  private baseUrl: string;
  private account: string;
  private connected = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private rpcId = 0;
  private opts: {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
  };

  constructor(account: string, baseUrl: string, opts: ChannelOpts) {
    this.account = account;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.opts = opts;
  }

  // ---- JSON-RPC 2.0 helper ----

  private async rpc(
    method: string,
    params: Record<string, unknown>,
  ): Promise<any> {
    const id = String(++this.rpcId);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      id,
      params: { account: this.account, ...params },
    });

    const resp = await fetch(`${this.baseUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(
        `signal-cli RPC ${method} failed: ${resp.status} ${text}`,
      );
    }

    const json = (await resp.json()) as {
      result?: unknown;
      error?: unknown;
    };
    if (json.error) {
      throw new Error(
        `signal-cli RPC ${method} error: ${JSON.stringify(json.error)}`,
      );
    }

    return json.result;
  }

  // ---- Channel interface ----

  async connect(): Promise<void> {
    try {
      // Verify daemon is reachable — listGroups is a safe probe
      await this.rpc('listGroups', {});
      this.connected = true;
      logger.info(
        { account: this.account, url: this.baseUrl },
        'Signal channel connected',
      );
      console.log(`\n  Signal: ${this.account}`);
      console.log(`  Daemon: ${this.baseUrl}\n`);

      this.startPolling();
    } catch (err) {
      // Don't throw — let NanoClaw start without Signal if daemon isn't running.
      // This mirrors Telegram's pattern: disabled if creds missing.
      logger.warn(
        { account: this.account, url: this.baseUrl, err },
        'Signal: cannot reach signal-cli daemon (channel disabled)',
      );
      this.connected = false;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      logger.warn('Signal channel not connected');
      return;
    }

    try {
      const chunks = this.splitMessage(text);

      if (this.isGroupJid(jid)) {
        const groupId = jid.replace('signal:group:', '');
        for (const chunk of chunks) {
          await this.rpc('sendGroupMessage', {
            groupId,
            message: chunk,
          });
        }
      } else {
        const recipient = jid.replace('signal:', '');
        for (const chunk of chunks) {
          await this.rpc('send', {
            recipient: [recipient],
            message: chunk,
          });
        }
      }

      logger.info({ jid, length: text.length }, 'Signal message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal message');
    }
  }

  async sendImage(
    jid: string,
    imagePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.connected) return;

    try {
      const params: Record<string, unknown> = {
        attachment: [imagePath],
        message: caption || '',
      };

      if (this.isGroupJid(jid)) {
        params.groupId = jid.replace('signal:group:', '');
        await this.rpc('sendGroupMessage', params);
      } else {
        params.recipient = [jid.replace('signal:', '')];
        await this.rpc('send', params);
      }

      logger.info({ jid, imagePath }, 'Signal image sent');
    } catch (err) {
      logger.error({ jid, imagePath, err }, 'Failed to send Signal image');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.connected = false;
    logger.info('Signal channel disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected || !isTyping) return;
    try {
      if (this.isGroupJid(jid)) {
        await this.rpc('sendTyping', {
          groupId: jid.replace('signal:group:', ''),
        });
      } else {
        await this.rpc('sendTyping', {
          recipient: [jid.replace('signal:', '')],
        });
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Signal typing indicator');
    }
  }

  // Signal doesn't support editing sent messages, so streaming falls back
  // to sendMessage() automatically (no sendMessageReturningId / editMessage).

  // ---- internals ----

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(
      () => this.pollMessages(),
      SIGNAL_POLL_INTERVAL,
    );
    // Also poll immediately on connect
    this.pollMessages();
  }

  private async pollMessages(): Promise<void> {
    if (!this.connected) return;
    try {
      const messages = await this.rpc('receive', {});
      if (!Array.isArray(messages)) return;

      for (const msg of messages) {
        try {
          this.handleEnvelope(msg.envelope || msg);
        } catch (err) {
          logger.debug({ err }, 'Error processing Signal envelope');
        }
      }
    } catch (err) {
      logger.debug({ err }, 'Signal receive poll error');
      // Don't disconnect on transient errors — just skip this cycle
    }
  }

  private handleEnvelope(envelope: SignalEnvelope): void {
    // Only handle data messages (not receipts, typing, etc.)
    if (!envelope.dataMessage) return;

    const dm = envelope.dataMessage;
    const content = dm.message;
    if (!content) return; // No text content (e.g. attachment-only or reaction)

    const sourceNumber = envelope.source || envelope.sourceNumber || '';
    const sourceName = envelope.sourceName || sourceNumber;
    const sourceUuid = envelope.sourceUuid || '';
    const timestamp = envelope.timestamp
      ? new Date(envelope.timestamp).toISOString()
      : new Date().toISOString();

    // Determine JID: group or DM
    const groupId = dm.groupInfo?.groupId;
    const chatJid = groupId
      ? `signal:group:${groupId}`
      : `signal:${sourceNumber}`;

    const isGroup = !!groupId;
    const msgId = `${envelope.timestamp || Date.now()}`;

    // Handle quotes/replies
    const quote = dm.quote;
    const replyToMessageId = quote?.id?.toString();
    const replyToContent = quote?.text;
    const replyToSender = quote?.author || quote?.authorNumber;

    // Chat metadata discovery
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      isGroup ? undefined : sourceName,
      'signal',
      isGroup,
    );

    // Only deliver for registered groups/chats
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, sourceName },
        'Message from unregistered Signal chat',
      );
      return;
    }

    // Download attachments if present
    const attachments = dm.attachments?.map((att) => ({
      type: this.inferAttachmentType(att.contentType),
      path: att.id || '',
      mimeType: att.contentType,
    }));

    // Deliver message — startMessageLoop() will pick it up
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: sourceUuid || sourceNumber,
      sender_name: sourceName,
      content,
      timestamp,
      is_from_me: false,
      reply_to_message_id: replyToMessageId,
      reply_to_message_content: replyToContent,
      reply_to_sender_name: replyToSender,
      attachments:
        attachments && attachments.length > 0 ? attachments : undefined,
    });

    logger.info({ chatJid, sender: sourceName }, 'Signal message stored');
  }

  private inferAttachmentType(
    contentType?: string,
  ): 'image' | 'video' | 'audio' | 'document' {
    if (!contentType) return 'document';
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('video/')) return 'video';
    if (contentType.startsWith('audio/')) return 'audio';
    return 'document';
  }

  private isGroupJid(jid: string): boolean {
    return jid.startsWith('signal:group:');
  }

  private splitMessage(text: string): string[] {
    if (text.length <= SIGNAL_MAX_MESSAGE_LENGTH) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += SIGNAL_MAX_MESSAGE_LENGTH) {
      chunks.push(text.slice(i, i + SIGNAL_MAX_MESSAGE_LENGTH));
    }
    return chunks;
  }
}

// ---- self-registration ----

registerChannel('signal', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SIGNAL_ACCOUNT', 'SIGNAL_CLI_URL']);
  const account =
    process.env.SIGNAL_ACCOUNT || envVars.SIGNAL_ACCOUNT || '';
  const baseUrl =
    process.env.SIGNAL_CLI_URL ||
    envVars.SIGNAL_CLI_URL ||
    'http://127.0.0.1:8080';

  if (!account) {
    logger.warn('Signal: SIGNAL_ACCOUNT not set — channel disabled');
    return null;
  }

  return new SignalChannel(account, baseUrl, opts);
});
