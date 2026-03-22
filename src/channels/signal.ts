import { execSync } from 'child_process';
import net from 'net';
import os from 'os';
import path from 'path';

import {
  ASSISTANT_NAME,
  SIGNAL_CLI_TCP_HOST,
  SIGNAL_CLI_TCP_PORT,
  SIGNAL_PHONE_NUMBER,
} from '../config.js';
import { logger } from '../logger.js';

// Optional voice transcription — available if the voice-transcription skill is installed
let transcribeAudio: ((filePath: string) => Promise<string>) | null = null;
import('../transcription.js')
  .then((mod) => { transcribeAudio = mod.transcribeAudio; })
  .catch(() => { /* voice transcription not available */ });
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

interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id?: number;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
  id?: number;
}

interface SignalAttachment {
  contentType?: string;
  id?: string;
  localPath?: string;
  voiceNote?: boolean;
  filename?: string;
  size?: number;
}

const SIGNAL_CLI_ATTACHMENTS_DIR = path.join(
  os.homedir(),
  '.local',
  'share',
  'signal-cli',
  'attachments',
);

interface SignalMention {
  start?: number;
  length?: number;
  uuid?: string;
  number?: string;
  name?: string;
}

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceName?: string;
  timestamp?: number;
  dataMessage?: {
    timestamp?: number;
    message?: string;
    mentions?: SignalMention[];
    attachments?: SignalAttachment[];
    groupInfo?: {
      groupId?: string;
      type?: string;
    };
    groupContext?: {
      title?: string;
      groupId?: string;
    };
  };
  syncMessage?: {
    sentMessage?: {
      message?: string;
      destination?: string;
      destinationNumber?: string;
      groupInfo?: {
        groupId?: string;
      };
    };
  };
}

/**
 * Resolve Signal mention placeholders (U+FFFC) to readable "@name" text.
 * Signal replaces each @mention in the message body with a single U+FFFC character.
 * signal-cli provides a `mentions` array with the name/number for each.
 * We replace each U+FFFC with "@name" so trigger detection and display work correctly.
 */
function resolveMentions(text: string, mentions?: SignalMention[]): string {
  if (!mentions || mentions.length === 0) return text;

  // Build a name lookup for each mention by start position.
  // We process U+FFFC characters left-to-right, matching to mentions sorted by position.
  const sorted = [...mentions].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  let mentionIdx = 0;
  let result = '';
  for (const ch of text) {
    if (ch === '\uFFFC' && mentionIdx < sorted.length) {
      const m = sorted[mentionIdx++];
      const name = m.name || m.number || m.uuid || 'unknown';
      result += `@${name}`;
    } else {
      result += ch;
    }
  }
  return result;
}

function jidFromPhone(phone: string): string {
  return `signal:${phone}`;
}

function jidFromGroupId(groupId: string): string {
  return `signal:group.${groupId}`;
}

function parseJid(
  jid: string,
):
  | { type: 'individual'; phone: string }
  | { type: 'group'; groupId: string }
  | null {
  if (jid.startsWith('signal:group.')) {
    return { type: 'group', groupId: jid.slice('signal:group.'.length) };
  }
  if (jid.startsWith('signal:')) {
    return { type: 'individual', phone: jid.slice('signal:'.length) };
  }
  return null;
}

export class SignalChannel implements Channel {
  name = 'signal';

  private socket: net.Socket | null = null;
  private connected = false;
  private buffer = '';
  private rpcId = 1;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastGroupDataMessage = Date.now();
  private lastSignalCliRestart = Date.now();

  private opts: SignalChannelOpts;

  constructor(opts: SignalChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.connectInternal(resolve);
    });
    this.startWatchdog();
  }

  private connectInternal(onFirstOpen?: () => void): void {
    const socket = new net.Socket();
    this.socket = socket;

    socket.on('connect', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      logger.info('Signal connection restored');
      logger.info(
        { host: SIGNAL_CLI_TCP_HOST, port: SIGNAL_CLI_TCP_PORT },
        'Connected to signal-cli',
      );

      // Subscribe to incoming messages
      this.sendRpc('subscribeReceive', { account: SIGNAL_PHONE_NUMBER });

      // Flush queued messages
      this.flushOutgoingQueue().catch((err) =>
        logger.error({ err }, 'Failed to flush outgoing queue'),
      );

      if (onFirstOpen) {
        onFirstOpen();
        onFirstOpen = undefined;
      }
    });

    socket.on('data', (chunk) => {
      this.buffer += chunk.toString();
      // Process all complete newline-delimited JSON objects
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as JsonRpcMessage;
          if (obj.method === 'receive') {
            this.handleReceiveEvent(obj).catch((err) =>
              logger.error({ err }, 'Error handling receive event'),
            );
          }
        } catch (err) {
          logger.warn(
            { err, line: trimmed.slice(0, 100) },
            'Failed to parse signal-cli message',
          );
        }
      }
    });

    socket.on('close', () => {
      this.connected = false;
      logger.info(
        { queuedMessages: this.outgoingQueue.length },
        'signal-cli socket closed, reconnecting in 5s',
      );
      this.scheduleReconnect();
    });

    socket.on('error', (err) => {
      logger.error({ err }, 'signal-cli socket error');
      // 'close' fires after 'error', reconnect handled there
    });

    socket.connect(SIGNAL_CLI_TCP_PORT, SIGNAL_CLI_TCP_HOST);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    if (this.reconnectAttempts === 3) {
      logger.warn(
        `Signal connection lost. Failed to reconnect ${this.reconnectAttempts} times.`,
      );
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      logger.info('Reconnecting to signal-cli...');
      this.connectInternal();
    }, 5000);
  }

  private sendRpc(method: string, params?: Record<string, unknown>): void {
    if (!this.socket || !this.connected) return;
    const msg: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id: this.rpcId++,
    };
    this.socket.write(JSON.stringify(msg) + '\n');
  }

  private async handleReceiveEvent(obj: JsonRpcMessage): Promise<void> {
    // signal-cli sends receive events in two forms:
    // - broadcast: params.envelope (all connected clients)
    // - subscription response: params.result.envelope (subscribed client only)
    const params = obj.params as
      | {
          account?: string;
          envelope?: SignalEnvelope;
          result?: { envelope?: SignalEnvelope };
        }
      | undefined;
    const envelope = params?.envelope ?? params?.result?.envelope;
    if (!envelope) return;
    const timestamp = envelope.timestamp
      ? new Date(envelope.timestamp).toISOString()
      : new Date().toISOString();

    // Sync messages: sent by us from another device
    if (envelope.syncMessage?.sentMessage) {
      const sent = envelope.syncMessage.sentMessage;
      const content = sent.message || '';
      if (!content) return;

      let chatJid: string;
      let isGroup: boolean;
      if (sent.groupInfo?.groupId) {
        chatJid = jidFromGroupId(sent.groupInfo.groupId);
        isGroup = true;
      } else {
        const dest = sent.destinationNumber || sent.destination || '';
        if (!dest) return;
        chatJid = jidFromPhone(dest);
        isGroup = false;
      }

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'signal',
        isGroup,
      );

      const groups = this.opts.registeredGroups();
      if (groups[chatJid]) {
        this.opts.onMessage(chatJid, {
          id: `${envelope.timestamp || Date.now()}`,
          chat_jid: chatJid,
          sender: SIGNAL_PHONE_NUMBER,
          sender_name: ASSISTANT_NAME,
          content,
          timestamp,
          is_from_me: true,
          is_bot_message: true,
        });
      }
      return;
    }

    // Data messages: received from others
    const dataMsg = envelope.dataMessage;
    if (!dataMsg) return;

    // Detect audio attachments by contentType; localPath and voiceNote fields
    // are not always present in signal-cli 0.13.x JSON-RPC output.
    const audioAttachment = dataMsg.attachments?.find(
      (a) => a.contentType?.startsWith('audio/') && a.id,
    );
    const imageAttachments =
      dataMsg.attachments?.filter(
        (a) => a.contentType?.startsWith('image/') && a.id,
      ) ?? [];
    if (!dataMsg.message && !audioAttachment && imageAttachments.length === 0)
      return;

    // Prefer ACI/UUID over phone number for stable JID routing.
    // Signal users may have phone number privacy on (sourceNumber will be null).
    const senderId = envelope.source || envelope.sourceNumber || '';
    const senderPhone = envelope.sourceNumber || envelope.source || '';
    const senderName = envelope.sourceName || senderPhone;

    let content: string;
    if (dataMsg.message) {
      content = resolveMentions(dataMsg.message, dataMsg.mentions);
    } else if (audioAttachment) {
      // signal-cli stores attachments as ~/.local/share/signal-cli/attachments/<id>
      const filePath =
        audioAttachment.localPath ||
        path.join(SIGNAL_CLI_ATTACHMENTS_DIR, audioAttachment.id!);
      if (transcribeAudio) {
        try {
          const transcript = await transcribeAudio(filePath);
          content = `[Voice: ${transcript}]`;
          logger.info({ jid: `signal:${senderId}` }, 'Voice note transcribed');
        } catch (err) {
          logger.warn({ err }, 'Failed to transcribe voice note');
          content = '[Voice message - transcription failed]';
        }
      } else {
        content = '[Voice message received - transcription not available]';
      }
    } else {
      content = '';
    }

    // Append image references — mounted at /workspace/attachments inside the container
    for (const img of imageAttachments) {
      const imageLine = `[Image: /workspace/attachments/${img.id}]`;
      content = content ? `${content}\n${imageLine}` : imageLine;
    }

    let chatJid: string;
    let isGroup: boolean;
    let groupName: string | undefined;

    if (dataMsg.groupInfo?.groupId) {
      chatJid = jidFromGroupId(dataMsg.groupInfo.groupId);
      isGroup = true;
      groupName = dataMsg.groupContext?.title;
      this.lastGroupDataMessage = Date.now();
    } else {
      chatJid = jidFromPhone(senderId);
      isGroup = false;
    }

    // For individual DMs, use the sender's display name as the chat name
    const chatName = isGroup ? groupName : senderName || undefined;
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'signal', isGroup);

    const groups = this.opts.registeredGroups();
    const isFromMe = senderPhone === SIGNAL_PHONE_NUMBER;
    // Always store individual DMs (even from unregistered contacts) so the
    // admin can be notified and approve them. Only store group messages if
    // the group is already registered.
    if (groups[chatJid] || !isGroup) {
      this.opts.onMessage(chatJid, {
        id: `${envelope.timestamp || Date.now()}`,
        chat_jid: chatJid,
        sender: senderPhone,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: isFromMe,
        is_bot_message: isFromMe,
      });
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, length: text.length, queueSize: this.outgoingQueue.length },
        'Signal disconnected, message queued',
      );
      return;
    }
    try {
      this.sendMessageToSignal(jid, text);
      logger.info({ jid, length: text.length }, 'Signal message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send Signal message, queued',
      );
    }
  }

  private sendMessageToSignal(jid: string, text: string): void {
    const parsed = parseJid(jid);
    if (!parsed) {
      logger.warn({ jid }, 'Cannot send: invalid Signal JID');
      return;
    }
    if (parsed.type === 'group') {
      this.sendRpc('send', {
        account: SIGNAL_PHONE_NUMBER,
        groupId: parsed.groupId,
        message: text,
      });
    } else {
      this.sendRpc('send', {
        account: SIGNAL_PHONE_NUMBER,
        recipient: [parsed.phone],
        message: text,
      });
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.socket?.destroy();
  }

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // signal-cli doesn't expose typing indicators via JSON-RPC daemon
  }

  async sendReaction(
    jid: string,
    messageId: string,
    emoji: string,
    targetAuthor?: string,
  ): Promise<void> {
    if (!this.connected) return;
    const parsed = parseJid(jid);
    if (!parsed) return;
    const targetTimestamp = parseInt(messageId, 10);
    if (isNaN(targetTimestamp)) {
      logger.warn(
        { jid, messageId },
        'Signal reaction skipped: messageId is not a valid timestamp',
      );
      return;
    }
    const params: Record<string, unknown> = {
      account: SIGNAL_PHONE_NUMBER,
      emoji,
      targetAuthor:
        targetAuthor ||
        (parsed.type === 'individual' ? parsed.phone : undefined) ||
        SIGNAL_PHONE_NUMBER,
      targetTimestamp,
    };
    if (parsed.type === 'group') {
      params.groupId = parsed.groupId;
    } else {
      params.recipient = [parsed.phone];
    }
    this.sendRpc('sendReaction', params);
    logger.info({ jid, emoji, messageId }, 'Signal reaction sent');
  }

  async sendImage(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.connected) {
      logger.warn({ jid, filePath }, 'Signal disconnected, cannot send image');
      return;
    }
    const parsed = parseJid(jid);
    if (!parsed) {
      logger.warn({ jid }, 'Cannot send image: invalid Signal JID');
      return;
    }
    const params: Record<string, unknown> = {
      account: SIGNAL_PHONE_NUMBER,
      message: caption || '',
      attachment: [filePath],
    };
    if (parsed.type === 'group') {
      params.groupId = parsed.groupId;
    } else {
      params.recipient = [parsed.phone];
    }
    this.sendRpc('send', params);
    logger.info({ jid, filePath, hasCaption: !!caption }, 'Signal image sent');
  }

  /**
   * Periodic watchdog that restarts signal-cli when group messages stop arriving.
   * signal-cli's TCP daemon can go stale for group delivery after long uptime
   * while DMs and receipts continue working normally.
   */
  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    // Check every 10 minutes
    this.watchdogTimer = setInterval(
      () => {
        const now = Date.now();
        const hasRegisteredGroups = Object.keys(
          this.opts.registeredGroups(),
        ).some((jid) => jid.startsWith('signal:group.'));
        if (!hasRegisteredGroups) return;

        const hoursSinceGroupMsg =
          (now - this.lastGroupDataMessage) / (1000 * 60 * 60);
        const hoursSinceRestart =
          (now - this.lastSignalCliRestart) / (1000 * 60 * 60);

        // Restart if no group messages for 2+ hours, or every 8 hours as a safety net
        if (hoursSinceGroupMsg >= 2 || hoursSinceRestart >= 8) {
          logger.info(
            {
              hoursSinceGroupMsg: hoursSinceGroupMsg.toFixed(1),
              hoursSinceRestart: hoursSinceRestart.toFixed(1),
            },
            'Watchdog: restarting signal-cli to prevent stale group delivery',
          );
          this.restartSignalCli();
        }
      },
      10 * 60 * 1000,
    );
  }

  private restartSignalCli(): void {
    try {
      this.lastSignalCliRestart = Date.now();
      this.lastGroupDataMessage = Date.now(); // Reset to avoid immediate re-trigger
      execSync('systemctl --user restart signal-cli', { timeout: 15000 });
      logger.info('signal-cli restarted by watchdog');
      // The TCP socket close event will trigger reconnection automatically
    } catch (err) {
      logger.error({ err }, 'Watchdog failed to restart signal-cli');
      logger.warn('Failed to restart signal-cli via watchdog');
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing Signal message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        this.sendMessageToSignal(item.jid, item.text);
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued Signal message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}
