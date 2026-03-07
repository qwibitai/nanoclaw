import WebSocket from 'ws';

import { ASSISTANT_NAME } from '../config.js';
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

export class SignalChannel implements Channel {
  name = 'signal';

  private ws: WebSocket | null = null;
  private opts: SignalChannelOpts;
  private apiUrl: string;
  private phoneNumber: string;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(apiUrl: string, phoneNumber: string, opts: SignalChannelOpts) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.phoneNumber = phoneNumber;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wsUrl = `${this.apiUrl.replace(/^http/, 'ws')}/v1/receive/${encodeURIComponent(this.phoneNumber)}`;

      this.ws = new WebSocket(wsUrl);

      this.ws.once('open', () => {
        logger.info({ phone: this.phoneNumber }, 'Signal connected');
        console.log(`\n  Signal: Connected as ${this.phoneNumber}`);
        console.log(`  Signal API: ${this.apiUrl}\n`);
        resolve();
      });

      this.ws.once('error', (err: Error) => {
        logger.error({ err: err.message }, 'Signal WebSocket error during connect');
        reject(err);
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        try {
          const payload = JSON.parse(data.toString());
          this.handleEnvelope(payload);
        } catch (err) {
          logger.debug({ err }, 'Failed to parse Signal message');
        }
      });

      this.ws.on('close', () => {
        logger.warn('Signal WebSocket closed, reconnecting in 5s');
        this.ws = null;
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.reconnect(), 5000);
      });
    });
  }

  private async reconnect(): Promise<void> {
    try {
      await this.connect();
    } catch (err) {
      logger.error({ err }, 'Signal reconnect failed, retrying in 30s');
      this.reconnectTimer = setTimeout(() => this.reconnect(), 30000);
    }
  }

  private handleEnvelope(payload: any): void {
    const msg = payload?.envelope?.dataMessage;
    if (!msg?.message) return;

    const source: string =
      payload?.envelope?.source || payload?.envelope?.sourceNumber || '';
    if (!source) return;

    const groupId: string | undefined = msg?.groupInfo?.groupId;
    const jid = groupId ? `signal:group.${groupId}` : `signal:${source}`;

    const senderName: string = payload?.envelope?.sourceName || source;
    const isGroup = !!groupId;

    const timestamp = new Date(
      payload?.envelope?.timestamp ?? msg?.timestamp ?? Date.now(),
    ).toISOString();

    // Use group JID as chat name for groups, sender name for DMs
    const chatName = isGroup ? jid : senderName;

    this.opts.onChatMetadata(jid, timestamp, chatName, 'signal', isGroup);

    const group = this.opts.registeredGroups()[jid];
    if (!group) {
      logger.debug({ jid }, 'Message from unregistered Signal chat');
      return;
    }

    this.opts.onMessage(jid, {
      id: String(payload?.envelope?.timestamp ?? Date.now()),
      chat_jid: jid,
      sender: source,
      sender_name: senderName,
      content: msg.message as string,
      timestamp,
      is_from_me: false,
    });

    logger.info({ jid, sender: senderName }, 'Signal message stored');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.isConnected()) {
      logger.warn({ jid }, 'Signal not connected, cannot send message');
      return;
    }

    try {
      const recipient = jid.replace(/^signal:/, '');

      const response = await fetch(`${this.apiUrl}/v2/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          number: this.phoneNumber,
          recipients: [recipient],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      logger.info({ jid, length: text.length }, 'Signal message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal message');
    }
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === 1; // 1 = WebSocket.OPEN
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      logger.info('Signal disconnected');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping) return;
    try {
      const recipient = jid.replace(/^signal:/, '');
      await fetch(
        `${this.apiUrl}/v1/typing-indicator/${encodeURIComponent(this.phoneNumber)}`,
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
  const apiUrl =
    process.env.SIGNAL_API_URL || envVars.SIGNAL_API_URL || '';
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
