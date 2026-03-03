import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

interface SignalReceiveEnvelope {
  envelope?: {
    timestamp?: number;
    sourceNumber?: string;
    sourceName?: string;
    sourceUuid?: string;
    dataMessage?: {
      message?: string;
      timestamp?: number;
      groupInfo?: {
        groupId?: string;
        groupName?: string;
      };
      attachments?: unknown[];
    };
  };
}

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SignalChannel implements Channel {
  name = 'signal';

  private opts: SignalChannelOpts;
  private baseUrl: string;
  private account: string;
  private receiveIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private connected = false;
  private pollInFlight = false;

  constructor(
    baseUrl: string,
    account: string,
    receiveIntervalMs: number,
    opts: SignalChannelOpts,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.account = account;
    this.receiveIntervalMs = receiveIntervalMs;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.connected = true;

    // Poll once immediately, then on interval.
    await this.pollMessages();
    this.timer = setInterval(() => {
      this.pollMessages().catch((err) => {
        logger.error({ err }, 'Signal poll failed');
      });
    }, this.receiveIntervalMs);

    logger.info(
      {
        baseUrl: this.baseUrl,
        account: this.account,
        intervalMs: this.receiveIntervalMs,
      },
      'Signal channel connected',
    );
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const isGroup = jid.startsWith('signal-group:');
    const target = jid.replace(/^signal(-group)?:/, '');

    const body = isGroup
      ? {
          number: this.account,
          message: text,
          groupId: target,
        }
      : {
          number: this.account,
          message: text,
          recipients: [target],
        };

    try {
      await fetch(`${this.baseUrl}/v2/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      logger.info({ jid, length: text.length }, 'Signal message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:') || jid.startsWith('signal-group:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('Signal channel disconnected');
  }

  // Signal has no typing indicator API.
  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // no-op
  }

  private async pollMessages(): Promise<void> {
    if (!this.connected || this.pollInFlight) return;
    this.pollInFlight = true;

    try {
      const receiveUrl = `${this.baseUrl}/v1/receive/${encodeURIComponent(this.account)}?timeout=1`;
      const response = await fetch(receiveUrl);
      if (!response.ok) {
        logger.warn({ status: response.status }, 'Signal receive returned non-OK');
        return;
      }

      const raw = await response.json();
      const envelopes: SignalReceiveEnvelope[] = Array.isArray(raw)
        ? raw
        : Array.isArray(raw?.messages)
          ? raw.messages
          : Array.isArray(raw?.envelopes)
            ? raw.envelopes
            : [];

      for (const item of envelopes) {
        const envelope = item.envelope;
        const dataMessage = envelope?.dataMessage;
        if (!envelope || !dataMessage) continue;

        const groupId = dataMessage.groupInfo?.groupId;
        const chatJid = groupId
          ? `signal-group:${groupId}`
          : `signal:${envelope.sourceNumber || envelope.sourceUuid || 'unknown'}`;

        const timestampMs =
          dataMessage.timestamp || envelope.timestamp || Date.now();
        const timestamp = new Date(timestampMs).toISOString();

        const chatName = groupId ? dataMessage.groupInfo?.groupName : undefined;
        this.opts.onChatMetadata(chatJid, timestamp, chatName, 'signal', !!groupId);

        const group = this.opts.registeredGroups()[chatJid];
        if (!group) continue;

        const text = dataMessage.message?.trim() || '';
        const attachments = dataMessage.attachments?.length
          ? `[Attachments: ${dataMessage.attachments.length}]`
          : '';
        const content = [text, attachments].filter(Boolean).join('\n').trim();
        if (!content) continue;

        const sender = envelope.sourceNumber || envelope.sourceUuid || 'unknown';
        const senderName = envelope.sourceName || sender;

        this.opts.onMessage(chatJid, {
          id: `${timestampMs}-${sender}`,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });
      }
    } catch (err) {
      logger.error({ err }, 'Signal poll failed');
    } finally {
      this.pollInFlight = false;
    }
  }
}

registerChannel('signal', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'SIGNAL_API_BASE_URL',
    'SIGNAL_ACCOUNT',
    'SIGNAL_RECEIVE_INTERVAL_MS',
  ]);

  const baseUrl = envVars.SIGNAL_API_BASE_URL || '';
  const account = envVars.SIGNAL_ACCOUNT || '';
  const interval = parseInt(envVars.SIGNAL_RECEIVE_INTERVAL_MS || '2000', 10);

  if (!baseUrl || !account) {
    logger.warn('Signal: SIGNAL_API_BASE_URL or SIGNAL_ACCOUNT not set');
    return null;
  }

  return new SignalChannel(baseUrl, account, interval, opts);
});
