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

const POLL_INTERVAL_MS = 3000;
const RETRY_DELAY_MS = 5000;

interface SignalBridgeThread {
  id: string;
  name?: string;
  isGroup?: boolean;
  lastMessageAt?: string;
}

interface SignalBridgeAttachment {
  kind?: string;
  name?: string;
}

interface SignalBridgeEvent {
  id?: string;
  type?: string;
  direction?: 'incoming' | 'outgoing';
  threadId: string;
  threadName?: string;
  senderId?: string;
  senderName?: string;
  text?: string;
  timestamp?: string;
  isGroup?: boolean;
  attachments?: SignalBridgeAttachment[];
}

interface SignalBridgeThreadBatch {
  threads?: SignalBridgeThread[];
}

interface SignalBridgeEventBatch {
  events?: SignalBridgeEvent[];
  nextCursor?: string;
}

interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SignalChannel implements Channel {
  name = 'signal';

  private connected = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private cursor = '';
  private polling = false;

  constructor(
    private readonly bridgeUrl: string,
    private readonly bridgeToken: string,
    private readonly opts: SignalChannelOpts,
  ) {}

  async connect(): Promise<void> {
    await this.fetchJson('/health');
    this.connected = true;
    logger.info({ bridgeUrl: this.bridgeUrl }, 'Connected to Signal bridge');
    await this.syncGroups(true);
    await this.pollEvents();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const threadId = jid.replace(/^signal:/, '');
    await this.fetchJson('/messages', {
      method: 'POST',
      body: JSON.stringify({ threadId, text }),
    });
    logger.info({ jid, length: text.length }, 'Signal message sent');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Signal channel disconnected');
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Signal bridge v1 does not expose typing.
  }

  async syncGroups(_force = false): Promise<void> {
    try {
      const payload = await this.fetchJson<SignalBridgeThreadBatch>('/threads');
      const now = new Date().toISOString();
      for (const thread of payload.threads || []) {
        this.opts.onChatMetadata(
          `signal:${thread.id}`,
          thread.lastMessageAt || now,
          thread.name,
          'signal',
          thread.isGroup,
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to sync Signal thread metadata');
    }
  }

  private schedulePoll(delayMs: number): void {
    if (!this.connected) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      void this.pollEvents();
    }, delayMs);
  }

  private async pollEvents(): Promise<void> {
    if (!this.connected || this.polling) return;
    this.polling = true;

    try {
      const suffix = this.cursor
        ? `?cursor=${encodeURIComponent(this.cursor)}`
        : '';
      const payload =
        await this.fetchJson<SignalBridgeEventBatch>(`/events${suffix}`);

      if (payload.nextCursor) this.cursor = payload.nextCursor;
      for (const event of payload.events || []) {
        this.handleEvent(event);
      }

      this.schedulePoll(POLL_INTERVAL_MS);
    } catch (err) {
      logger.warn({ err }, 'Signal event poll failed');
      this.schedulePoll(RETRY_DELAY_MS);
    } finally {
      this.polling = false;
    }
  }

  private handleEvent(event: SignalBridgeEvent): void {
    if (event.type && event.type !== 'message') return;

    const chatJid = `signal:${event.threadId}`;
    const timestamp = event.timestamp || new Date().toISOString();
    const isBotMessage =
      event.direction === 'outgoing' || event.senderId === 'assistant';

    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      event.threadName,
      'signal',
      event.isGroup,
    );

    if (!this.opts.registeredGroups()[chatJid]) return;

    const content = formatSignalContent(event.text, event.attachments);
    if (!content) return;

    this.opts.onMessage(chatJid, {
      id: event.id || `${event.threadId}:${timestamp}`,
      chat_jid: chatJid,
      sender: event.senderId || (isBotMessage ? 'assistant' : 'unknown'),
      sender_name:
        event.senderName ||
        (isBotMessage ? ASSISTANT_NAME : event.senderId || 'Unknown'),
      content,
      timestamp,
      is_from_me: isBotMessage,
      is_bot_message: isBotMessage,
    });
  }

  private async fetchJson<T>(
    pathname: string,
    init?: RequestInit,
  ): Promise<T> {
    const response = await fetch(this.resolveUrl(pathname), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.bridgeToken}`,
        'Content-Type': 'application/json',
        ...(init?.headers || {}),
      },
    });

    if (!response.ok) {
      throw new Error(
        `Signal bridge request failed: ${response.status} ${response.statusText}`,
      );
    }

    if (response.status === 204) return {} as T;
    return (await response.json()) as T;
  }

  private resolveUrl(pathname: string): string {
    const base = this.bridgeUrl.endsWith('/')
      ? this.bridgeUrl
      : `${this.bridgeUrl}/`;
    return new URL(pathname.replace(/^\//, ''), base).toString();
  }
}

function formatSignalContent(
  text?: string,
  attachments?: SignalBridgeAttachment[],
): string {
  const placeholderText = (attachments || [])
    .map(formatAttachment)
    .filter(Boolean)
    .join(' ');
  return [placeholderText, text?.trim() || ''].filter(Boolean).join(' ').trim();
}

function formatAttachment(attachment: SignalBridgeAttachment): string {
  switch (attachment.kind) {
    case 'image':
      return '[Photo]';
    case 'video':
      return '[Video]';
    case 'voice':
      return '[Voice message]';
    case 'audio':
      return '[Audio]';
    case 'document':
      return attachment.name
        ? `[Document: ${attachment.name}]`
        : '[Document]';
    case 'sticker':
      return '[Sticker]';
    default:
      return attachment.kind ? `[${attachment.kind}]` : '[Attachment]';
  }
}

registerChannel('signal', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SIGNAL_BRIDGE_URL', 'SIGNAL_BRIDGE_TOKEN']);
  const bridgeUrl =
    process.env.SIGNAL_BRIDGE_URL || envVars.SIGNAL_BRIDGE_URL || '';
  const bridgeToken =
    process.env.SIGNAL_BRIDGE_TOKEN || envVars.SIGNAL_BRIDGE_TOKEN || '';

  if (!bridgeUrl || !bridgeToken) {
    logger.warn(
      'Signal: SIGNAL_BRIDGE_URL or SIGNAL_BRIDGE_TOKEN is not configured',
    );
    return null;
  }

  return new SignalChannel(bridgeUrl, bridgeToken, opts);
});
