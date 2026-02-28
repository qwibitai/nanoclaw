/**
 * Signal Channel for NanoClaw
 * Uses signal-cli REST API container for Signal messaging
 */
import { ASSISTANT_NAME } from '../config.js';
import { logger } from '../logger.js';
import {
  signalCheck,
  signalSendV2,
  signalSetTyping,
  signalCreatePoll,
  signalClosePoll,
  signalReact,
  signalRemoveReaction,
  signalDeleteMessage,
  signalSendReceipt,
  signalListGroups,
  signalGetGroupInfo,
  signalGetContacts,
  streamSignalEvents,
  SignalWsEvent,
  SignalMention,
  SignalGroup,
} from '../signal/client.js';
import { registerPoll, recordVote, closePollState } from '../signal/poll-store.js';
import { Channel, NewMessage, OnChatMetadata, OnInboundMessage, RegisteredGroup } from '../types.js';

// Signal envelope types from signal-cli
interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  sourceName?: string;
  timestamp?: number;
  dataMessage?: SignalDataMessage;
  editMessage?: {
    targetSentTimestamp: number;
    dataMessage: SignalDataMessage;
  };
  syncMessage?: unknown;
}

interface SignalAttachment {
  id?: string;
  contentType?: string;
  filename?: string;
  size?: number;
  voiceNote?: boolean;
}

interface SignalDataMessage {
  message?: string;
  timestamp?: number;
  groupInfo?: {
    groupId?: string;
    groupName?: string;
  };
  attachments?: SignalAttachment[];
  reaction?: {
    emoji: string;
    targetAuthor: string;
    targetAuthorNumber?: string;
    targetSentTimestamp: number;
    isRemove: boolean;
  };
  pollCreate?: {
    question?: string;
    options?: string[];
    allowMultiple?: boolean;
  };
  pollVote?: {
    authorNumber?: string;
    targetSentTimestamp?: number;
    optionIndexes?: number[];
  };
  pollTerminate?: {
    targetSentTimestamp?: number;
  };
  quote?: {
    text?: string;
  };
  mentions?: Array<{
    start?: number;
    length?: number;
    uuid?: string;
    number?: string;
    name?: string;
  }>;
}

interface SignalReceivePayload {
  envelope?: SignalEnvelope;
  exception?: { message?: string };
}

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  account: string;
  httpHost?: string;
  httpPort?: number;
  allowFrom?: string[];
}

export class SignalChannel implements Channel {
  name = 'signal';


  private opts: SignalChannelOpts;
  private baseUrl: string;
  private connected = false;
  private abortController: AbortController | null = null;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private contactNames: Map<string, string> = new Map();
  private contactRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SignalChannelOpts) {
    this.opts = opts;
    const host = opts.httpHost || '127.0.0.1';
    const port = opts.httpPort || 8080;
    this.baseUrl = `http://${host}:${port}`;
  }

  async connect(): Promise<void> {
    logger.info({ baseUrl: this.baseUrl }, 'Connecting to signal-cli container...');

    await this.waitForReady(30_000);

    this.connected = true;
    logger.info('Connected to Signal');

    // Load contact names for sender resolution
    await this.refreshContacts();
    this.contactRefreshTimer = setInterval(() => {
      this.refreshContacts().catch((err) =>
        logger.debug({ err }, 'Failed to refresh Signal contacts'),
      );
    }, 24 * 60 * 60 * 1000);

    // Sync group metadata so orchestrator discovers Signal groups at startup
    try {
      const groups = await signalListGroups({ baseUrl: this.baseUrl, account: this.opts.account });
      const now = new Date().toISOString();
      for (const group of groups) {
        if (group.isMember && group.internalId) {
          const signalJid = `signal:group:${group.internalId}`;
          this.opts.onChatMetadata(signalJid, now, group.name);
        }
      }
      logger.info({ count: groups.filter((g) => g.isMember).length }, 'Signal groups synced on startup');
    } catch (err) {
      logger.warn({ err }, 'Failed to sync Signal groups on startup');
    }

    // Flush any messages queued while disconnected
    this.flushOutgoingQueue().catch((err) =>
      logger.error({ err }, 'Failed to flush Signal outgoing queue'),
    );

    this.startEventLoop();
  }

  private async refreshContacts(): Promise<void> {
    try {
      const contacts = await signalGetContacts({ baseUrl: this.baseUrl, account: this.opts.account });
      this.contactNames.clear();
      for (const c of contacts) {
        if (c.number) {
          const displayName = c.profileName || c.name;
          if (displayName) this.contactNames.set(c.number, displayName);
        }
      }
      logger.debug({ count: this.contactNames.size }, 'Signal contact names loaded');
    } catch (err) {
      logger.debug({ err }, 'Failed to load Signal contacts');
    }
  }

  private async waitForReady(timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    const pollInterval = 500;

    while (Date.now() - startTime < timeoutMs) {
      const check = await signalCheck(this.baseUrl, 2000);
      if (check.ok) {
        logger.debug('signal-cli container is ready');
        return;
      }
      logger.debug({ error: check.error }, 'Waiting for signal-cli container...');
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    throw new Error(`signal-cli container not reachable within ${timeoutMs}ms`);
  }

  private startEventLoop(): void {
    this.abortController = new AbortController();

    const runLoop = async () => {
      let reconnectAttempts = 0;
      while (this.connected && !this.abortController?.signal.aborted) {
        try {
          await streamSignalEvents({
            baseUrl: this.baseUrl,
            account: this.opts.account,
            abortSignal: this.abortController?.signal,
            onEvent: (event) => this.handleEvent(event),
          });
          reconnectAttempts = 0; // Reset backoff on clean disconnect
        } catch (err) {
          if (this.abortController?.signal.aborted) {
            break;
          }
          const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 60_000);
          reconnectAttempts++;
          logger.error({ err, retryIn: delay }, 'Signal WebSocket stream error, reconnecting...');
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    };

    runLoop().catch((err) => {
      logger.error({ err }, 'Signal event loop failed');
    });
  }

  private handleEvent(event: SignalWsEvent): void {
    if (event.event !== 'receive' || !event.data) return;

    let payload: SignalReceivePayload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      logger.error('Failed to parse Signal event');
      return;
    }

    if (payload.exception?.message) {
      logger.error({ message: payload.exception.message }, 'Signal receive exception');
      return;
    }

    const envelope = payload.envelope;
    if (!envelope) return;
    if (envelope.syncMessage) return;

    // Edits arrive as envelope.editMessage, not envelope.dataMessage
    const isEdit = Boolean(envelope.editMessage);
    const dataMessage = isEdit ? envelope.editMessage!.dataMessage : envelope.dataMessage;
    if (!dataMessage) return;

    const senderNumber = envelope.sourceNumber || envelope.source;
    if (!senderNumber) return;

    if (this.normalizePhone(senderNumber) === this.normalizePhone(this.opts.account)) return;

    if (this.opts.allowFrom && this.opts.allowFrom.length > 0) {
      const normalized = this.normalizePhone(senderNumber);
      const allowed = this.opts.allowFrom.some(
        (num) => this.normalizePhone(num) === normalized,
      );
      if (!allowed) {
        logger.debug({ sender: senderNumber }, 'Blocked message from non-allowed sender');
        return;
      }
    }

    const groupId = dataMessage.groupInfo?.groupId;
    const groupName = dataMessage.groupInfo?.groupName;
    const isGroup = Boolean(groupId);
    const chatJid = isGroup ? `signal:group:${groupId}` : `signal:${senderNumber}`;

    const timestamp = new Date(
      (envelope.timestamp || dataMessage.timestamp || Date.now()),
    ).toISOString();

    const chatName = isGroup ? (groupName || `Group ${groupId?.slice(0, 8)}`) : (envelope.sourceName || senderNumber);
    this.opts.onChatMetadata(chatJid, timestamp, chatName);

    const groups = this.opts.registeredGroups();
    if (!groups[chatJid]) {
      logger.debug({ chatJid }, 'Message from unregistered chat, ignoring');
      return;
    }

    // -- Reaction events --
    if (dataMessage.reaction) {
      const r = dataMessage.reaction;
      const targetAuthorName = this.resolveContactName(r.targetAuthor || r.targetAuthorNumber || 'unknown');
      const reactionContent = r.isRemove
        ? `[Removed ${r.emoji} reaction from message by ${targetAuthorName}]`
        : `[Reacted ${r.emoji} to message from ${targetAuthorName}]`;

      const senderName = this.resolveContactName(senderNumber) || envelope.sourceName || senderNumber;
      this.opts.onMessage(chatJid, {
        id: String(envelope.timestamp || Date.now()),
        chat_jid: chatJid,
        sender: senderNumber,
        sender_name: senderName,
        content: reactionContent,
        timestamp,
        is_from_me: false,
      });
      return;
    }

    // -- Poll events: register metadata and accumulate votes --
    if (dataMessage.pollCreate) {
      const pc = dataMessage.pollCreate;
      if (pc.question && pc.options) {
        const ts = envelope.timestamp || dataMessage.timestamp || Date.now();
        registerPoll(chatJid, senderNumber, ts, pc.question, pc.options);
        logger.info({ chatJid, question: pc.question }, 'Signal poll registered from create event');
      }
      return;
    }

    if (dataMessage.pollVote) {
      const pv = dataMessage.pollVote;
      if (pv.targetSentTimestamp && pv.optionIndexes) {
        const recorded = recordVote(
          chatJid,
          pv.targetSentTimestamp,
          senderNumber,
          envelope.sourceName || senderNumber,
          pv.optionIndexes,
        );
        if (recorded) {
          logger.info({ chatJid, voter: senderNumber, options: pv.optionIndexes }, 'Signal poll vote recorded');
        } else {
          logger.debug({ chatJid, targetTs: pv.targetSentTimestamp }, 'Poll vote for unknown poll (missed create event)');
        }
      }
      return;
    }

    if (dataMessage.pollTerminate) {
      const pt = dataMessage.pollTerminate;
      if (pt.targetSentTimestamp) {
        closePollState(chatJid, pt.targetSentTimestamp);
        logger.info({ chatJid, pollTs: pt.targetSentTimestamp }, 'Signal poll closed via terminate event');
      }
      return;
    }

    // -- Attachment placeholders --
    let attachmentPrefix = '';
    if (dataMessage.attachments && dataMessage.attachments.length > 0) {
      const labels = dataMessage.attachments.map((att) => {
        const ct = att.contentType || '';
        const fname = att.filename || '';
        const idSuffix = att.id ? ` | id:${att.id}` : '';
        if (ct === 'audio/aac' && !fname) return `[Voice note${idSuffix}]`;
        if (ct.startsWith('image/')) return `[Image: ${fname || 'photo'}${idSuffix}]`;
        if (ct.startsWith('video/')) return `[Video: ${fname || 'clip'}${idSuffix}]`;
        if (ct.startsWith('audio/')) return `[Audio: ${fname || 'audio'}${idSuffix}]`;
        return `[Document: ${fname || 'file'}${idSuffix}]`;
      });
      attachmentPrefix = labels.join(' ') + '\n';
    }

    let messageText = (isEdit ? '[Edited] ' : '') + attachmentPrefix + (dataMessage.message || '');

    // Signal mentions replace the mention text with U+FFFC (Object Replacement Character).
    // Reconstruct the actual text by substituting each mention placeholder with @name.
    // Process mentions in reverse order so string indices stay valid.
    if (dataMessage.mentions && dataMessage.mentions.length > 0) {
      const sorted = [...dataMessage.mentions].sort(
        (a, b) => (b.start ?? 0) - (a.start ?? 0),
      );
      for (const mention of sorted) {
        const start = mention.start ?? 0;
        const length = mention.length ?? 1;
        // If the mention targets the bot's own number, use the assistant name
        // so the trigger pattern (@McClaw) matches correctly.
        const isSelf = mention.number && this.normalizePhone(mention.number) === this.normalizePhone(this.opts.account);
        const name = isSelf ? ASSISTANT_NAME : (mention.name || mention.number || 'unknown');
        messageText =
          messageText.slice(0, start) +
          `@${name}` +
          messageText.slice(start + length);
      }
    }

    messageText = messageText.trim();
    const quoteText = dataMessage.quote?.text?.trim() || '';
    const content = messageText || quoteText;

    if (!content) {
      logger.debug({ chatJid }, 'Empty message, ignoring');
      return;
    }

    const senderName = this.resolveContactName(senderNumber) || envelope.sourceName || senderNumber;

    const sourceTs = envelope.timestamp || dataMessage.timestamp || Date.now();
    this.opts.onMessage(chatJid, {
      id: String(sourceTs),
      chat_jid: chatJid,
      sender: senderNumber,
      sender_name: senderName,
      sender_id: senderNumber,
      content,
      timestamp,
      source_timestamp: sourceTs,
      is_from_me: false,
    });
  }

  private normalizePhone(phone: string): string {
    return phone.replace(/[^\d+]/g, '');
  }

  private resolveContactName(phoneOrUuid: string): string | undefined {
    return this.contactNames.get(phoneOrUuid) || this.contactNames.get(this.normalizePhone(phoneOrUuid));
  }

  async sendMessage(jid: string, text: string): Promise<{ timestamp?: number }> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info({ jid, length: text.length, queueSize: this.outgoingQueue.length }, 'Signal disconnected, message queued');
      return {};
    }
    try {
      return await this.sendMessageExtended(jid, text);
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text });
      logger.warn({ jid, err, queueSize: this.outgoingQueue.length }, 'Failed to send Signal message, queued');
      return {};
    }
  }

  async sendMessageExtended(
    jid: string,
    text: string,
    options?: {
      attachments?: string[];
      quoteTimestamp?: number;
      quoteAuthor?: string;
      quoteMessage?: string;
      mentions?: SignalMention[];
      editTimestamp?: number;
      viewOnce?: boolean;
    },
  ): Promise<{ timestamp?: number }> {
    const target = this.jidToTarget(jid);

    const result = await signalSendV2({
      baseUrl: this.baseUrl,
      account: this.opts.account,
      recipients: target.type === 'dm' ? [target.id] : undefined,
      groupId: target.type === 'group' ? target.id : undefined,
      message: text,
      textMode: 'styled',
      attachments: options?.attachments,
      quoteTimestamp: options?.quoteTimestamp,
      quoteAuthor: options?.quoteAuthor,
      quoteMessage: options?.quoteMessage,
      mentions: options?.mentions,
      editTimestamp: options?.editTimestamp,
      viewOnce: options?.viewOnce,
    });

    logger.info({ jid, length: text.length }, 'Signal message sent');
    return result;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info({ count: this.outgoingQueue.length }, 'Flushing Signal outgoing queue');
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.sendMessage(item.jid, item.text);
      }
    } finally {
      this.flushing = false;
    }
  }

  async createPoll(jid: string, question: string, answers: string[], allowMultiple = false): Promise<string | undefined> {
    if (!this.connected) { logger.warn({ jid }, 'Signal not connected'); return undefined; }
    try {
      const target = this.jidToTarget(jid);
      const result = await signalCreatePoll({ baseUrl: this.baseUrl, account: this.opts.account, recipient: target.id, question, answers, allowMultipleSelections: allowMultiple });
      logger.info({ jid, question }, 'Signal poll created');
      return result.pollTimestamp;
    } catch (err) { logger.error({ jid, err }, 'Failed to create Signal poll'); throw err; }
  }

  async closePoll(jid: string, pollTimestamp: string): Promise<void> {
    if (!this.connected) { logger.warn({ jid }, 'Signal not connected'); return; }
    try {
      const target = this.jidToTarget(jid);
      await signalClosePoll({ baseUrl: this.baseUrl, account: this.opts.account, recipient: target.id, pollTimestamp });
      logger.info({ jid, pollTimestamp }, 'Signal poll closed');
    } catch (err) { logger.error({ jid, err }, 'Failed to close Signal poll'); throw err; }
  }

  async react(jid: string, targetAuthor: string, targetTimestamp: number, reaction: string): Promise<void> {
    if (!this.connected) { logger.warn({ jid }, 'Signal not connected'); return; }
    try {
      const target = this.jidToTarget(jid);
      await signalReact({ baseUrl: this.baseUrl, account: this.opts.account, recipient: target.id, targetAuthor, targetTimestamp, reaction });
      logger.info({ jid, reaction }, 'Signal reaction sent');
    } catch (err) { logger.error({ jid, err }, 'Failed to send Signal reaction'); throw err; }
  }

  async removeReaction(jid: string, targetAuthor: string, targetTimestamp: number, reaction: string): Promise<void> {
    if (!this.connected) { logger.warn({ jid }, 'Signal not connected'); return; }
    try {
      const target = this.jidToTarget(jid);
      await signalRemoveReaction({ baseUrl: this.baseUrl, account: this.opts.account, recipient: target.id, targetAuthor, targetTimestamp, reaction });
      logger.info({ jid, reaction }, 'Signal reaction removed');
    } catch (err) { logger.error({ jid, err }, 'Failed to remove Signal reaction'); throw err; }
  }

  async deleteMessage(jid: string, timestamp: number): Promise<void> {
    if (!this.connected) { logger.warn({ jid }, 'Signal not connected'); return; }
    try {
      const target = this.jidToTarget(jid);
      await signalDeleteMessage({ baseUrl: this.baseUrl, account: this.opts.account, recipient: target.id, timestamp });
      logger.info({ jid, timestamp }, 'Signal message deleted');
    } catch (err) { logger.error({ jid, err }, 'Failed to delete Signal message'); throw err; }
  }

  async sendReceipt(jid: string, timestamp: number, type: 'read' | 'viewed' = 'read'): Promise<void> {
    if (!this.connected) return;
    try {
      const target = this.jidToTarget(jid);
      await signalSendReceipt({ baseUrl: this.baseUrl, account: this.opts.account, recipient: target.id, timestamp, receiptType: type });
    } catch (err) { logger.debug({ jid, err }, 'Failed to send Signal receipt'); }
  }

  async listGroups(): Promise<SignalGroup[]> {
    if (!this.connected) return [];
    try {
      return await signalListGroups({ baseUrl: this.baseUrl, account: this.opts.account });
    } catch (err) { logger.error({ err }, 'Failed to list Signal groups'); throw err; }
  }

  async getGroupInfo(groupId: string): Promise<SignalGroup | null> {
    if (!this.connected) return null;
    try {
      return await signalGetGroupInfo({ baseUrl: this.baseUrl, account: this.opts.account, groupId });
    } catch (err) { logger.error({ groupId, err }, 'Failed to get Signal group info'); throw err; }
  }

  private jidToTarget(jid: string): { type: 'group' | 'dm'; id: string } {
    if (jid.startsWith('signal:group:')) {
      // JIDs use the internal_id (raw base64 from signal-cli WebSocket events).
      // The REST API expects "group." + base64(internal_id) (double-encoded).
      const internalId = jid.replace('signal:group:', '');
      const restApiId = `group.${Buffer.from(internalId).toString('base64')}`;
      return { type: 'group', id: restApiId };
    }
    if (jid.startsWith('signal:')) return { type: 'dm', id: jid.replace('signal:', '') };
    return { type: 'dm', id: jid };
  }

  isConnected(): boolean { return this.connected; }
  ownsJid(jid: string): boolean { return jid.startsWith('signal:'); }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.abortController?.abort();
    if (this.contactRefreshTimer) {
      clearInterval(this.contactRefreshTimer);
      this.contactRefreshTimer = null;
    }
    logger.info('Disconnected from Signal');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected) return;
    try {
      const target = this.jidToTarget(jid);
      await signalSetTyping({
        baseUrl: this.baseUrl,
        account: this.opts.account,
        recipient: target.id,
        isTyping,
        timeoutMs: 5000,
      });
    } catch (err) { logger.debug({ jid, err }, 'Failed to send typing indicator'); }
  }
}
