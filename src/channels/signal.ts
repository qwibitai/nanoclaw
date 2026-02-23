import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { logger } from '../logger.js';
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

  private apiUrl: string;
  private phoneNumber: string;
  private opts: SignalChannelOpts;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private shouldReconnect = true;

  constructor(apiUrl: string, phoneNumber: string, opts: SignalChannelOpts) {
    this.apiUrl = apiUrl.replace(/\/$/, ''); // strip trailing slash
    this.phoneNumber = phoneNumber;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Verify API is reachable
    const aboutUrl = `${this.apiUrl}/v1/about`;
    try {
      const res = await fetch(aboutUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      logger.info('Signal API reachable');
    } catch (err) {
      logger.error({ err, url: aboutUrl }, 'Signal API not reachable');
      throw new Error(`Signal API not reachable at ${aboutUrl}`);
    }

    this.shouldReconnect = true;
    await this.openWebSocket();
  }

  private openWebSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const wsHost = this.apiUrl.replace(/^http/, 'ws');
      const wsUrl = `${wsHost}/v1/receive/${this.phoneNumber}`;

      let resolved = false;

      this.ws = new WebSocket(wsUrl);

      this.ws.addEventListener('open', () => {
        this.connected = true;
        logger.info({ url: wsUrl }, 'Signal WebSocket connected');
        console.log(`\n  Signal channel: ${this.phoneNumber}`);
        console.log(`  Send !chatid in a Signal chat to get the registration ID\n`);
        if (!resolved) {
          resolved = true;
          resolve();
        }
      });

      this.ws.addEventListener('message', (event) => {
        try {
          const data = typeof event.data === 'string' ? event.data : String(event.data);
          this.handleMessage(JSON.parse(data));
        } catch (err) {
          logger.error({ err }, 'Failed to parse Signal WebSocket message');
        }
      });

      this.ws.addEventListener('close', () => {
        this.connected = false;
        logger.warn('Signal WebSocket closed');
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
        if (!resolved) {
          resolved = true;
          reject(new Error('Signal WebSocket closed before open'));
        }
      });

      this.ws.addEventListener('error', (err) => {
        logger.error({ err }, 'Signal WebSocket error');
        if (!resolved) {
          resolved = true;
          reject(new Error('Signal WebSocket error'));
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (!this.shouldReconnect) return;
      logger.info('Reconnecting Signal WebSocket...');
      try {
        await this.openWebSocket();
      } catch {
        logger.warn('Signal reconnect failed, will retry');
        this.scheduleReconnect();
      }
    }, 5000);
  }

  private handleMessage(envelope: any): void {
    // signal-cli-rest-api JSON-RPC format
    const msg = envelope?.envelope;
    if (!msg) return;

    const sender = msg.source;
    if (!sender) return;

    // Filter self-messages
    if (sender === this.phoneNumber) return;

    const dataMessage = msg.dataMessage;
    if (!dataMessage) return;

    const timestamp = new Date(dataMessage.timestamp).toISOString();
    const senderName = msg.sourceName || sender;

    // Determine chat JID
    const groupInfo = dataMessage.groupInfo;
    const isGroup = !!groupInfo;
    let chatJid: string;
    let chatName: string;

    if (isGroup) {
      chatJid = `sig:${groupInfo.groupId}`;
      chatName = groupInfo.groupName || chatJid;
    } else {
      chatJid = `sig:${sender}`;
      chatName = senderName;
    }

    // Build content from text + attachments
    let content = dataMessage.message || '';
    const attachments: any[] = dataMessage.attachments || [];
    for (const att of attachments) {
      const type = (att.contentType || '').split('/')[0];
      let placeholder: string;
      switch (type) {
        case 'image':
          placeholder = '[Photo]';
          break;
        case 'video':
          placeholder = '[Video]';
          break;
        case 'audio':
          placeholder = '[Audio]';
          break;
        default:
          placeholder = '[Attachment]';
          break;
      }
      content = content ? `${content} ${placeholder}` : placeholder;
    }

    if (!content) return;

    // Handle commands
    const trimmed = content.trim();
    if (trimmed === '!chatid') {
      const typeLabel = isGroup ? 'group' : 'DM';
      this.sendCommandReply(chatJid, `Chat ID: ${chatJid}\nName: ${chatName}\nType: ${typeLabel}`);
      return;
    }
    if (trimmed === '!ping') {
      this.sendCommandReply(chatJid, `${ASSISTANT_NAME} is online.`);
      return;
    }

    // Store chat metadata for discovery
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'signal', isGroup);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid, chatName }, 'Message from unregistered Signal chat');
      return;
    }

    const msgId = `${dataMessage.timestamp}-${sender}`;

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    logger.info(
      { chatJid, chatName, sender: senderName },
      'Signal message stored',
    );
  }

  private async sendCommandReply(chatJid: string, text: string): Promise<void> {
    try {
      await this.sendMessage(chatJid, text);
    } catch (err) {
      logger.error({ chatJid, err }, 'Failed to send Signal command reply');
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const MAX_LENGTH = 4000;

    try {
      const chunks: string[] = [];
      if (text.length <= MAX_LENGTH) {
        chunks.push(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          chunks.push(text.slice(i, i + MAX_LENGTH));
        }
      }

      for (const chunk of chunks) {
        const body: any = {
          message: chunk,
          number: this.phoneNumber,
          text_mode: 'normal',
        };

        // Groups use group ID, DMs use recipients array
        const stripped = jid.replace(/^sig:/, '');
        if (stripped.startsWith('+')) {
          // DM — recipient is a phone number
          body.recipients = [stripped];
        } else {
          // Group — send to group ID
          body.recipients = [];
          body.group = stripped;
        }

        const res = await fetch(`${this.apiUrl}/v2/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          logger.error({ jid, status: res.status, detail }, 'Signal send failed');
        }
      }

      logger.info({ jid, length: text.length }, 'Signal message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal message');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const stripped = jid.replace(/^sig:/, '');
      const method = isTyping ? 'PUT' : 'DELETE';

      const body: any = {};
      if (stripped.startsWith('+')) {
        body.recipient = stripped;
      } else {
        body.group = stripped;
      }

      await fetch(`${this.apiUrl}/v1/typing-indicator/${this.phoneNumber}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Signal typing indicator');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('sig:');
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    logger.info('Signal channel stopped');
  }
}
