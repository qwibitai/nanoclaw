import { execSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { ASSISTANT_NAME, SIGNAL_CLI_TCP_HOST, SIGNAL_CLI_TCP_PORT, SIGNAL_PHONE_NUMBER } from '../config.js';
import { reportError, clearAlert } from '../health.js';
import { log } from '../log.js';
import { transcribeAudio } from '../transcription.js';
import type { ChannelAdapter, ChannelRegistration, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const SIGNAL_CLI_ATTACHMENTS_DIR = path.join(os.homedir(), '.local', 'share', 'signal-cli', 'attachments');

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
    groupInfo?: { groupId?: string; type?: string };
    groupV2?: { id?: string };
    groupContext?: { title?: string; groupId?: string };
    quote?: {
      id?: number;
      author?: string;
      authorNumber?: string;
      authorName?: string;
      text?: string;
    };
  };
  syncMessage?: {
    sentMessage?: {
      message?: string;
      destination?: string;
      destinationNumber?: string;
      groupInfo?: { groupId?: string };
      groupV2?: { id?: string };
    };
  };
}

function resolveMentions(text: string, mentions?: SignalMention[]): string {
  if (!mentions || mentions.length === 0) return text;
  const sorted = [...mentions].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  let mentionIdx = 0;
  let result = '';
  for (const ch of text) {
    if (ch === '\uFFFC' && mentionIdx < sorted.length) {
      const m = sorted[mentionIdx++]!;
      result += `@${m.name || m.number || m.uuid || 'unknown'}`;
    } else {
      result += ch;
    }
  }
  return result;
}

function createSignalAdapter(): ChannelAdapter | null {
  if (!SIGNAL_PHONE_NUMBER) return null;

  let config: ChannelSetup;
  let socket: net.Socket | null = null;
  let connected = false;
  let buffer = '';
  let rpcId = 1;
  let outgoingQueue: Array<{ platformId: string; text: string; attachments?: string[] }> = [];
  let flushing = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let lastGroupDataMessage = Date.now();
  let lastSignalCliRestart = Date.now();
  let lastReceiveEvent = Date.now();

  const pendingRpc = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timeout: ReturnType<typeof setTimeout> }
  >();
  const RPC_TIMEOUT_MS = 60000;

  function sendRpc(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!socket || !connected) return Promise.reject(new Error('Signal not connected'));
    const id = rpcId++;
    const msg: JsonRpcRequest = { jsonrpc: '2.0', method, params, id };
    socket.write(JSON.stringify(msg) + '\n');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRpc.delete(id);
        reject(new Error(`RPC ${method} (id=${id}) timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);
      pendingRpc.set(id, { resolve, reject, timeout });
    });
  }

  function sendRpcFireAndForget(method: string, params?: Record<string, unknown>): void {
    sendRpc(method, params).catch((err) => log.warn('RPC fire-and-forget error', { method, err }));
  }

  function sendToSignal(platformId: string, text: string, attachments?: string[]): Promise<unknown> {
    const isGroup = platformId.startsWith('group.');
    const params: Record<string, unknown> = {
      account: SIGNAL_PHONE_NUMBER,
      message: text,
    };
    if (attachments?.length) params.attachment = attachments;
    if (isGroup) {
      params.groupId = platformId.slice('group.'.length);
    } else {
      params.recipient = [platformId];
    }
    return sendRpc('send', params);
  }

  async function flushOutgoingQueue(): Promise<void> {
    if (flushing || outgoingQueue.length === 0) return;
    flushing = true;
    try {
      log.info('Flushing outgoing Signal queue', { count: outgoingQueue.length });
      while (outgoingQueue.length > 0) {
        const item = outgoingQueue.shift()!;
        try {
          await sendToSignal(item.platformId, item.text, item.attachments);
        } catch (err) {
          log.error('Failed to send queued Signal message', { platformId: item.platformId, err });
        }
      }
    } finally {
      flushing = false;
    }
  }

  function scheduleReconnect(): void {
    if (reconnectTimer) return;
    reconnectAttempts++;
    if (reconnectAttempts === 3) {
      reportError('signal-disconnect', `Signal connection lost. Failed to reconnect ${reconnectAttempts} times.`);
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      log.info('Reconnecting to signal-cli...');
      connectInternal();
    }, 5000);
  }

  async function handleReceiveEvent(obj: JsonRpcMessage): Promise<void> {
    const params = obj.params as
      | { account?: string; envelope?: SignalEnvelope; result?: { envelope?: SignalEnvelope } }
      | undefined;
    const envelope = params?.envelope ?? params?.result?.envelope;
    if (!envelope) return;
    lastReceiveEvent = Date.now();
    const timestamp = envelope.timestamp ? new Date(envelope.timestamp).toISOString() : new Date().toISOString();

    // Sync messages (sent from another device)
    if (envelope.syncMessage?.sentMessage) {
      const sent = envelope.syncMessage.sentMessage;
      const content = sent.message || '';
      if (!content) return;

      let platformId: string;
      let isGroup: boolean;
      const sentGroupId = sent.groupV2?.id || sent.groupInfo?.groupId;
      if (sentGroupId) {
        platformId = `group.${sentGroupId}`;
        isGroup = true;
      } else {
        const dest = sent.destinationNumber || sent.destination || '';
        if (!dest) return;
        platformId = dest;
        isGroup = false;
      }

      config.onMetadata(platformId, undefined, isGroup);
      return;
    }

    // Data messages from others
    const dataMsg = envelope.dataMessage;
    if (!dataMsg) return;

    const audioAttachment = dataMsg.attachments?.find((a) => a.contentType?.startsWith('audio/') && a.id);
    const imageAttachments = dataMsg.attachments?.filter((a) => a.contentType?.startsWith('image/') && a.id) ?? [];
    if (!dataMsg.message && !audioAttachment && imageAttachments.length === 0) return;

    const senderId = envelope.source || envelope.sourceNumber || '';
    const senderPhone = envelope.sourceNumber || envelope.source || '';
    const senderName = envelope.sourceName || senderPhone;

    let content: string;
    if (dataMsg.message) {
      content = resolveMentions(dataMsg.message, dataMsg.mentions);
    } else if (audioAttachment) {
      const filePath = audioAttachment.localPath || path.join(SIGNAL_CLI_ATTACHMENTS_DIR, audioAttachment.id!);
      try {
        const transcript = await transcribeAudio(filePath);
        content = `[Voice: ${transcript}]`;
        log.info('Voice note transcribed', { sender: senderId });
      } catch (err) {
        log.warn('Failed to transcribe voice note', { err });
        content = '[Voice message - transcription failed]';
      }
    } else {
      content = '';
    }

    // Append image references
    const attachmentPaths: Array<{ path: string; contentType: string }> = [];
    for (const img of imageAttachments) {
      const imageLine = `[Image: /workspace/attachments/${img.id}]`;
      content = content ? `${content}\n${imageLine}` : imageLine;
      attachmentPaths.push({
        path: `/workspace/attachments/${img.id}`,
        contentType: img.contentType || 'image/jpeg',
      });
    }

    let platformId: string;
    let isGroup: boolean;
    let groupName: string | undefined;

    const groupId = dataMsg.groupV2?.id || dataMsg.groupInfo?.groupId;
    if (groupId) {
      platformId = `group.${groupId}`;
      isGroup = true;
      groupName = dataMsg.groupContext?.title;
      lastGroupDataMessage = Date.now();
    } else {
      platformId = senderId;
      isGroup = false;
    }

    const chatName = isGroup ? groupName : senderName || undefined;
    config.onMetadata(platformId, chatName, isGroup);

    const quote = dataMsg.quote;
    const inbound: InboundMessage = {
      id: `${envelope.timestamp || Date.now()}`,
      kind: 'chat',
      content: {
        text: content,
        sender: senderPhone,
        senderId: `signal:${senderId}`,
        senderName,
        quotedMessageId: quote?.id ? String(quote.id) : undefined,
        quotedText: quote?.text,
        quotedAuthor: quote?.authorName || quote?.authorNumber || quote?.author,
        attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined,
      },
      timestamp,
    };

    void config.onInbound(platformId, null, inbound);
  }

  function connectInternal(onFirstOpen?: () => void): void {
    const sock = new net.Socket();
    socket = sock;

    sock.on('connect', () => {
      connected = true;
      reconnectAttempts = 0;
      clearAlert('signal-disconnect');
      log.info('Connected to signal-cli', { host: SIGNAL_CLI_TCP_HOST, port: SIGNAL_CLI_TCP_PORT });

      sendRpcFireAndForget('subscribeReceive', { account: SIGNAL_PHONE_NUMBER });
      flushOutgoingQueue().catch((err) => log.error('Failed to flush outgoing queue', { err }));

      if (onFirstOpen) {
        onFirstOpen();
        onFirstOpen = undefined;
      }
    });

    sock.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as JsonRpcMessage;
          if (obj.id != null && pendingRpc.has(obj.id)) {
            const pending = pendingRpc.get(obj.id)!;
            pendingRpc.delete(obj.id);
            clearTimeout(pending.timeout);
            if (obj.error) {
              pending.reject(new Error(`signal-cli RPC error: ${JSON.stringify(obj.error)}`));
            } else {
              pending.resolve(obj.result);
            }
          } else if (obj.method === 'receive') {
            handleReceiveEvent(obj).catch((err) => log.error('Error handling receive event', { err }));
          }
        } catch (err) {
          log.warn('Failed to parse signal-cli message', { err, line: trimmed.slice(0, 100) });
        }
      }
    });

    sock.on('close', () => {
      connected = false;
      for (const [id, pending] of pendingRpc) {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Signal socket closed'));
      }
      pendingRpc.clear();
      log.info('signal-cli socket closed, reconnecting in 5s', { queuedMessages: outgoingQueue.length });
      scheduleReconnect();
    });

    sock.on('error', (err) => {
      log.error('signal-cli socket error', { err });
    });

    sock.connect(SIGNAL_CLI_TCP_PORT, SIGNAL_CLI_TCP_HOST);
  }

  function startWatchdog(): void {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(
      () => {
        const now = Date.now();

        const minSinceReceive = (now - lastReceiveEvent) / (1000 * 60);
        const minSinceConnect = (now - lastSignalCliRestart) / (1000 * 60);
        if (connected && minSinceConnect >= 10 && minSinceReceive >= 10) {
          log.warn('Watchdog: no receive events for 10+ min — reconnecting', {
            minSinceReceive: minSinceReceive.toFixed(1),
          });
          lastReceiveEvent = now;
          socket?.destroy();
          return;
        }

        const hoursSinceGroupMsg = (now - lastGroupDataMessage) / (1000 * 60 * 60);
        const hoursSinceRestart = (now - lastSignalCliRestart) / (1000 * 60 * 60);
        if (hoursSinceGroupMsg >= 6 || hoursSinceRestart >= 8) {
          log.info('Watchdog: restarting signal-cli', {
            hoursSinceGroupMsg: hoursSinceGroupMsg.toFixed(1),
            hoursSinceRestart: hoursSinceRestart.toFixed(1),
          });
          try {
            lastSignalCliRestart = Date.now();
            lastGroupDataMessage = Date.now();
            execSync('systemctl --user restart signal-cli', { timeout: 15000 });
            log.info('signal-cli restarted by watchdog');
          } catch (err) {
            log.error('Watchdog failed to restart signal-cli', { err });
            reportError('signal-cli-watchdog', 'Failed to restart signal-cli via watchdog');
          }
        }
      },
      5 * 60 * 1000,
    );
  }

  const adapter: ChannelAdapter = {
    name: 'Signal',
    channelType: 'signal',
    supportsThreads: false,

    async setup(cfg: ChannelSetup): Promise<void> {
      config = cfg;
      await new Promise<void>((resolve) => {
        connectInternal(resolve);
      });
      startWatchdog();
    },

    async teardown(): Promise<void> {
      connected = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (watchdogTimer) {
        clearInterval(watchdogTimer);
        watchdogTimer = null;
      }
      socket?.destroy();
      socket = null;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const content = message.content as Record<string, unknown> | string | undefined;

      // Handle reaction messages
      if (message.kind === 'reaction') {
        const rc = content as { emoji?: string; messageId?: string; targetAuthor?: string } | undefined;
        if (rc?.emoji && rc?.messageId) {
          const targetTimestamp = parseInt(rc.messageId, 10);
          if (!isNaN(targetTimestamp)) {
            const isGroup = platformId.startsWith('group.');
            const params: Record<string, unknown> = {
              account: SIGNAL_PHONE_NUMBER,
              emoji: rc.emoji,
              targetAuthor: rc.targetAuthor || SIGNAL_PHONE_NUMBER,
              targetTimestamp,
            };
            if (isGroup) {
              params.groupId = platformId.slice('group.'.length);
            } else {
              params.recipient = [platformId];
            }
            await sendRpc('sendReaction', params);
            log.info('Signal reaction sent', { platformId, emoji: rc.emoji, messageId: rc.messageId });
          }
        }
        return undefined;
      }

      // Extract text
      let text: string | undefined;
      if (typeof content === 'string') {
        text = content;
      } else if (content && typeof content.text === 'string') {
        text = content.text;
      }

      // Handle file attachments
      const tmpFiles: string[] = [];
      if (message.files?.length) {
        for (const file of message.files) {
          const tmpPath = path.join(os.tmpdir(), `signal-attach-${Date.now()}-${file.filename}`);
          fs.writeFileSync(tmpPath, file.data);
          tmpFiles.push(tmpPath);
        }
      }

      if (!text && tmpFiles.length === 0) return undefined;

      if (!connected) {
        outgoingQueue.push({ platformId, text: text || '', attachments: tmpFiles.length > 0 ? tmpFiles : undefined });
        log.info('Signal disconnected, message queued', { platformId, queueSize: outgoingQueue.length });
        return undefined;
      }

      const isGroup = platformId.startsWith('group.');
      const params: Record<string, unknown> = {
        account: SIGNAL_PHONE_NUMBER,
        message: text || '',
      };
      if (tmpFiles.length > 0) params.attachment = tmpFiles;
      if (isGroup) {
        params.groupId = platformId.slice('group.'.length);
      } else {
        params.recipient = [platformId];
      }
      try {
        const result = (await sendRpc('send', params)) as { timestamp?: number } | undefined;
        log.info('Signal message sent', {
          platformId,
          textLen: text?.length ?? 0,
          timestamp: (result as any)?.timestamp,
        });

        // Clean up temp files after signal-cli confirms send
        if (tmpFiles.length > 0) {
          for (const f of tmpFiles) fs.unlink(f, () => {});
        }

        const ts = (result as any)?.timestamp;
        return ts ? String(ts) : undefined;
      } catch (err) {
        log.error('Signal send failed', { platformId, err });
        // Clean up temp files on failure too
        if (tmpFiles.length > 0) {
          for (const f of tmpFiles) fs.unlink(f, () => {});
        }
        throw err;
      }
    },
  };

  return adapter;
}

const registration: ChannelRegistration = {
  factory: createSignalAdapter,
  containerConfig: {
    mounts: [
      {
        hostPath: path.join(os.homedir(), '.local', 'share', 'signal-cli', 'attachments'),
        containerPath: '/workspace/attachments',
        readonly: true,
      },
    ],
  },
};

registerChannelAdapter('signal', registration);
