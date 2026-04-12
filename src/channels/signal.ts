import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface DataMessage {
  timestamp: number;
  message?: string | null;
  expiresInSeconds?: number;
  viewOnce?: boolean;
  attachments?: Array<{ contentType: string; filename?: string }>;
  groupInfo?: { groupId: string; type: string };
}

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceName?: string;
  timestamp: number;
  dataMessage?: DataMessage;
}

interface SignalPayload {
  envelope?: SignalEnvelope;
  account?: string;
}

export class SignalChannel implements Channel {
  name = 'signal';

  private apiUrl: string;
  private phoneNumber: string;
  private opts: SignalChannelOpts;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private closed = false;

  constructor(apiUrl: string, phoneNumber: string, opts: SignalChannelOpts) {
    this.apiUrl = apiUrl;
    this.phoneNumber = phoneNumber;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.closed = false;
    return this.openWebSocket();
  }

  private openWebSocket(): Promise<void> {
    return new Promise((resolve) => {
      const wsUrl =
        this.apiUrl.replace(/^http/, 'ws') + `/v1/receive/${this.phoneNumber}`;
      const ws = new WebSocket(wsUrl);
      this.ws = ws;

      ws.onopen = () => {
        this.reconnectDelay = 1000;
        logger.info({ wsUrl }, 'Signal WebSocket connected');
        resolve();
      };

      ws.onmessage = (event: { data: string }) => {
        try {
          const data: SignalPayload = JSON.parse(event.data);
          this.handleEnvelope(data);
        } catch (err) {
          logger.debug({ err }, 'Signal: failed to parse WebSocket message');
        }
      };

      ws.onclose = () => {
        if (!this.closed) {
          this.scheduleReconnect();
        }
      };

      ws.onerror = (err: unknown) => {
        logger.debug({ err }, 'Signal WebSocket error');
      };
    });
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(this.reconnectDelay, 30000);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
    logger.info({ delay }, 'Signal: scheduling reconnect');
    this.reconnectTimer = setTimeout(() => {
      if (!this.closed) {
        this.openWebSocket().catch((err) => {
          logger.debug({ err }, 'Signal: reconnect failed');
        });
      }
    }, delay);
  }

  private handleEnvelope(data: SignalPayload): void {
    const envelope = data.envelope;
    if (!envelope) return;

    const dataMsg = envelope.dataMessage;
    if (!dataMsg) return;

    const sourceNumber = envelope.sourceNumber ?? envelope.source ?? '';
    const sourceName = envelope.sourceName ?? '';
    const timestamp = String(envelope.timestamp);

    const isGroup = Boolean(dataMsg.groupInfo?.groupId);
    const chatJid = isGroup
      ? `sig:group:${dataMsg.groupInfo!.groupId}`
      : `sig:${sourceNumber}`;

    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      isGroup ? undefined : sourceName,
      'signal',
      isGroup,
    );

    const content = this.extractContent(dataMsg);
    if (content === null) return;

    const groups = this.opts.registeredGroups();
    if (!(chatJid in groups)) return;

    const is_from_me = sourceNumber === this.phoneNumber;

    this.opts.onMessage(chatJid, {
      id: `${envelope.timestamp}-${sourceNumber}`,
      chat_jid: chatJid,
      sender: sourceNumber,
      sender_name: sourceName,
      content,
      timestamp,
      is_from_me,
    });
  }

  private extractContent(dataMsg: DataMessage): string | null {
    if (dataMsg.message) return dataMsg.message;

    if (dataMsg.attachments && dataMsg.attachments.length > 0) {
      const att = dataMsg.attachments[0];
      const ct = att.contentType ?? '';
      if (ct.startsWith('image/')) return '[Photo]';
      if (ct.startsWith('video/')) return '[Video]';
      if (ct.startsWith('audio/')) return '[Voice message]';
      return `[Document: ${att.filename ?? 'file'}]`;
    }

    return null;
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const MAX_LENGTH = 4096;
    try {
      const chunks =
        text.length <= MAX_LENGTH
          ? [text]
          : Array.from(
              { length: Math.ceil(text.length / MAX_LENGTH) },
              (_, i) => text.slice(i * MAX_LENGTH, (i + 1) * MAX_LENGTH),
            );
      for (const chunk of chunks) {
        const body = this.buildSendBody(jid, chunk);
        const res = await fetch(`${this.apiUrl}/v2/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          logger.warn(
            { jid, status: res.status },
            'Signal: send returned non-OK status',
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Signal message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal message');
    }
  }

  private buildSendBody(jid: string, message: string): Record<string, unknown> {
    if (jid.startsWith('sig:group:')) {
      const groupId = jid.slice('sig:group:'.length);
      return { number: this.phoneNumber, recipients: [groupId], message };
    }
    const recipient = jid.slice('sig:'.length);
    return { number: this.phoneNumber, recipients: [recipient], message };
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('sig:');
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws !== null) {
      this.ws.close();
      this.ws = null;
    }
    logger.info('Signal channel disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    try {
      const recipient = jid.startsWith('sig:group:')
        ? jid.slice('sig:group:'.length)
        : jid.slice('sig:'.length);
      await fetch(
        `${this.apiUrl}/v1/typing-indicator/${this.phoneNumber}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ recipient }),
        },
      );
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Signal typing indicator');
    }
  }
}

registerChannel('signal', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SIGNAL_API_URL', 'SIGNAL_PHONE_NUMBER']);
  const apiUrl = process.env.SIGNAL_API_URL || envVars.SIGNAL_API_URL || '';
  const phoneNumber =
    process.env.SIGNAL_PHONE_NUMBER || envVars.SIGNAL_PHONE_NUMBER || '';

  if (!apiUrl) {
    logger.warn('Signal: SIGNAL_API_URL not set');
    return null;
  }
  if (!phoneNumber) {
    logger.warn('Signal: SIGNAL_PHONE_NUMBER not set');
    return null;
  }

  return new SignalChannel(apiUrl, phoneNumber, opts);
});
