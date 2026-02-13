import crypto from 'crypto';
import http, { IncomingMessage, Server, ServerResponse } from 'http';

import { logger } from '../logger.js';
import { toCanonicalConversationId } from '../conversation.js';
import {
  Channel,
  ChannelCapabilities,
  ChannelFactoryOpts,
  MessageAttachment,
} from '../types.js';

interface SlackConversation {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
}

interface SlackFile {
  mimetype?: string;
  name?: string;
  size?: number;
  url_private?: string;
}

interface SlackHistoryMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  files?: SlackFile[];
}

interface SlackEventMessage {
  type: string;
  channel?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  ts?: string;
  subtype?: string;
  files?: SlackFile[];
}

interface SlackEventEnvelope {
  type: string;
  challenge?: string;
  event?: SlackEventMessage;
}

interface SlackApiResponse<T> {
  ok: boolean;
  error?: string;
}

interface SlackAuthTestResponse extends SlackApiResponse<SlackAuthTestResponse> {
  user_id?: string;
}

interface SlackConversationsListResponse
  extends SlackApiResponse<SlackConversationsListResponse> {
  channels?: SlackConversation[];
  response_metadata?: { next_cursor?: string };
}

interface SlackConversationsHistoryResponse
  extends SlackApiResponse<SlackConversationsHistoryResponse> {
  messages?: SlackHistoryMessage[];
}

const SLACK_POLL_INTERVAL_MS = 5000;
const SLACK_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const SLACK_SIG_MAX_AGE_SECONDS = 60 * 5;

function slackTsToIso(ts: string): string {
  return new Date(parseFloat(ts) * 1000).toISOString();
}

function isSlackChannelId(id: string): boolean {
  return /^[CDG][A-Z0-9]+$/.test(id);
}

function parseDeliveryMode(
  value: string | undefined,
): 'polling' | 'webhook' {
  const mode = (value || 'polling').trim().toLowerCase();
  if (mode === 'events' || mode === 'webhook') return 'webhook';
  return 'polling';
}

function extractAttachments(files: SlackFile[] | undefined): MessageAttachment[] {
  if (!files || files.length === 0) return [];
  return files.map((file) => ({
    kind: 'file',
    mimeType: file.mimetype,
    fileName: file.name,
    sizeBytes: file.size,
    url: file.url_private,
  }));
}

export class SlackChannel implements Channel {
  name = 'slack';
  prefixAssistantName = false;
  capabilities: ChannelCapabilities;

  private readonly opts: ChannelFactoryOpts;
  private readonly token: string;
  private readonly signingSecret: string;
  private readonly deliveryMode: 'polling' | 'webhook';
  private readonly eventsPort: number;

  private connected = false;
  private stopRequested = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private cursors = new Map<string, string>();
  private conversations = new Map<string, SlackConversation>();
  private botUserId: string | null = null;
  private httpServer: Server | null = null;

  constructor(opts: ChannelFactoryOpts) {
    this.opts = opts;
    this.token = process.env.SLACK_BOT_TOKEN || '';
    this.signingSecret = process.env.SLACK_SIGNING_SECRET || '';
    this.deliveryMode = parseDeliveryMode(process.env.SLACK_DELIVERY_MODE);
    this.eventsPort = Number(process.env.SLACK_EVENTS_PORT || 3010);
    this.capabilities = {
      typing: false,
      metadataSync: true,
      groupDiscovery: true,
      attachments: true,
      deliveryMode: this.deliveryMode === 'webhook' ? 'webhook' : 'polling',
    };
  }

  async connect(): Promise<void> {
    if (!this.token) {
      throw new Error('SLACK_BOT_TOKEN is required when CHANNEL_PROVIDER=slack');
    }
    if (this.deliveryMode === 'webhook' && !this.signingSecret) {
      throw new Error(
        'SLACK_SIGNING_SECRET is required for webhook/event delivery mode',
      );
    }

    const auth = await this.apiCall<SlackAuthTestResponse>('auth.test');
    this.botUserId = auth.user_id || null;
    this.connected = true;
    this.stopRequested = false;

    await this.syncConversations();
    this.startSyncLoop();

    if (this.deliveryMode === 'webhook') {
      await this.startEventServer();
      logger.info(
        { port: this.eventsPort },
        'Connected to Slack Web API (event/webhook mode)',
      );
      return;
    }

    this.startPolling();
    logger.info({ botUserId: this.botUserId }, 'Connected to Slack Web API');
  }

  async disconnect(): Promise<void> {
    this.stopRequested = true;
    this.connected = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.pollTimer = null;
    this.syncTimer = null;

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
      });
      this.httpServer = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return isSlackChannelId(jid);
  }

  isGroupChat(jid: string): boolean {
    const known = this.conversations.get(jid);
    if (known) {
      return !!(known.is_channel || known.is_group);
    }
    return jid.startsWith('C') || jid.startsWith('G');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    await this.apiCall('chat.postMessage', {
      channel: jid,
      text,
      unfurl_links: false,
      unfurl_media: false,
    });
  }

  async syncGroupMetadata(force = false): Promise<void> {
    if (!force && this.conversations.size > 0) return;
    await this.syncConversations();
  }

  private startPolling(): void {
    if (this.stopRequested) return;
    this.pollTimer = setTimeout(() => {
      this.pollOnce().catch((err) => {
        logger.error({ err }, 'Slack poll cycle failed');
      });
    }, SLACK_POLL_INTERVAL_MS);
  }

  private startSyncLoop(): void {
    if (this.stopRequested) return;
    this.syncTimer = setTimeout(() => {
      this.syncConversations()
        .catch((err) => logger.error({ err }, 'Slack conversation sync failed'))
        .finally(() => this.startSyncLoop());
    }, SLACK_SYNC_INTERVAL_MS);
  }

  private async pollOnce(): Promise<void> {
    if (this.stopRequested) return;

    if (this.conversations.size === 0) {
      await this.syncConversations();
    }

    const chats = Array.from(this.conversations.values()).filter(
      (c) => c.is_member && !c.is_archived,
    );

    for (const chat of chats) {
      if (!chat.id) continue;
      await this.pollConversation(chat);
    }

    this.startPolling();
  }

  private async pollConversation(chat: SlackConversation): Promise<void> {
    const channelId = chat.id;
    const oldest = this.cursors.get(channelId);

    const response = await this.apiCall<SlackConversationsHistoryResponse>(
      'conversations.history',
      {
        channel: channelId,
        oldest,
        limit: 30,
        inclusive: false,
      },
    );

    const messages = (response.messages || [])
      .filter((m) => !!m.ts)
      .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

    for (const message of messages) {
      await this.handleInboundMessage({
        channelId,
        text: message.text || '',
        sender: message.user || message.bot_id || 'unknown',
        ts: message.ts,
        isFromMe:
          !!this.botUserId && message.user === this.botUserId,
        files: message.files,
      });
    }
  }

  private async syncConversations(): Promise<void> {
    let cursor = '';
    const seen = new Map<string, SlackConversation>();

    do {
      const response = await this.apiCall<SlackConversationsListResponse>(
        'conversations.list',
        {
          types: 'public_channel,private_channel,im,mpim',
          exclude_archived: true,
          limit: 200,
          cursor: cursor || undefined,
        },
      );

      for (const chat of response.channels || []) {
        if (!chat.id) continue;
        seen.set(chat.id, chat);
      }

      cursor = response.response_metadata?.next_cursor || '';
    } while (cursor);

    this.conversations = seen;
    logger.info(
      { count: this.conversations.size },
      'Synced Slack conversation metadata',
    );
  }

  private async startEventServer(): Promise<void> {
    if (this.httpServer) return;

    this.httpServer = http.createServer((req, res) => {
      this.handleEventRequest(req, res).catch((err) => {
        logger.error({ err }, 'Failed to handle Slack event request');
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end('internal error');
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer?.once('error', reject);
      this.httpServer?.listen(this.eventsPort, '0.0.0.0', () => resolve());
    });
  }

  private async handleEventRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('method not allowed');
      return;
    }

    const body = await this.readRawBody(req);
    if (!this.isValidSlackSignature(req, body)) {
      res.statusCode = 401;
      res.end('invalid signature');
      return;
    }

    const payload = JSON.parse(body) as SlackEventEnvelope;

    if (payload.type === 'url_verification' && payload.challenge) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain');
      res.end(payload.challenge);
      return;
    }

    if (payload.type === 'event_callback' && payload.event) {
      await this.handleEventMessage(payload.event);
    }

    res.statusCode = 200;
    res.end('ok');
  }

  private async handleEventMessage(event: SlackEventMessage): Promise<void> {
    if (event.type !== 'message') return;
    if (!event.channel || !event.ts) return;
    if (event.subtype && event.subtype !== 'file_share') return;

    await this.handleInboundMessage({
      channelId: event.channel,
      text: event.text || '',
      sender: event.user || event.bot_id || 'unknown',
      ts: event.ts,
      isFromMe: !!this.botUserId && event.user === this.botUserId,
      files: event.files,
    });
  }

  private async handleInboundMessage(params: {
    channelId: string;
    text: string;
    sender: string;
    ts: string;
    isFromMe: boolean;
    files?: SlackFile[];
  }): Promise<void> {
    const { channelId, text, sender, ts, isFromMe, files } = params;
    const timestamp = slackTsToIso(ts);
    const chatName = this.conversations.get(channelId)?.name || channelId;
    const attachments = extractAttachments(files);
    const canonicalChannelId = toCanonicalConversationId(this.name, channelId);

    this.opts.onChatMetadata(channelId, timestamp, chatName);

    const groups = this.opts.registeredGroups();
    if (!groups[canonicalChannelId]) {
      this.bumpCursor(channelId, ts);
      return;
    }

    this.opts.onMessage(channelId, {
      id: `${channelId}:${ts}`,
      chat_jid: channelId,
      sender,
      sender_name: sender,
      content: text,
      timestamp,
      is_from_me: isFromMe,
      attachments,
    });

    this.bumpCursor(channelId, ts);
  }

  private bumpCursor(channelId: string, ts: string): void {
    const cursor = this.cursors.get(channelId);
    if (!cursor || parseFloat(ts) > parseFloat(cursor)) {
      this.cursors.set(channelId, ts);
    }
  }

  private readRawBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let raw = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => resolve(raw));
      req.on('error', reject);
    });
  }

  private isValidSlackSignature(
    req: IncomingMessage,
    rawBody: string,
  ): boolean {
    const timestamp = req.headers['x-slack-request-timestamp'];
    const signature = req.headers['x-slack-signature'];
    if (
      typeof timestamp !== 'string' ||
      typeof signature !== 'string' ||
      !signature.startsWith('v0=')
    ) {
      return false;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const parsedTimestamp = Number(timestamp);
    if (
      !Number.isFinite(parsedTimestamp) ||
      Math.abs(nowSeconds - parsedTimestamp) > SLACK_SIG_MAX_AGE_SECONDS
    ) {
      return false;
    }

    const base = `v0:${timestamp}:${rawBody}`;
    const expected = `v0=${crypto
      .createHmac('sha256', this.signingSecret)
      .update(base)
      .digest('hex')}`;

    const signatureBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expected);
    if (signatureBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(signatureBuf, expectedBuf);
  }

  private async apiCall<T>(
    method: string,
    payload?: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(payload || {}),
    });

    if (!response.ok) {
      throw new Error(`Slack API HTTP ${response.status} for ${method}`);
    }

    const parsed = (await response.json()) as SlackApiResponse<T> & T;
    if (!parsed.ok) {
      throw new Error(`Slack API error for ${method}: ${parsed.error || 'unknown error'}`);
    }

    return parsed as T;
  }
}
