import net from 'net';

import { ASSISTANT_NAME } from '../config.js';
import { getLatestMessage, getMessageById, storeReaction } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

// ---------------------------------------------------------------------------
// Signal rich-text types and parser (self-contained — no dependency on the
// channel-formatting skill or text-styles.ts)
// ---------------------------------------------------------------------------

interface SignalTextStyle {
  style: 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE' | 'SPOILER';
  /** Start position in the final string, in UTF-16 code units. */
  start: number;
  /** Length of the styled range, in UTF-16 code units. */
  length: number;
}

/**
 * Strip Claude's Markdown markers and return plain text + Signal style ranges.
 * Handles **bold**, *italic*, _italic_, ~~strike~~, `code`, ```blocks```,
 * ## headings (→ BOLD), [text](url) (→ "text (url)"), and --- (removed).
 */
function parseSignalStyles(rawText: string): {
  text: string;
  textStyle: SignalTextStyle[];
} {
  const textStyle: SignalTextStyle[] = [];
  let out = '';
  let i = 0;
  const s = rawText;
  const n = s.length;

  function addStyle(
    style: SignalTextStyle['style'],
    startOut: number,
    endOut: number,
  ): void {
    const length = endOut - startOut;
    if (length > 0) textStyle.push({ style, start: startOut, length });
  }

  while (i < n) {
    // Fenced code block  ```[lang]\n...\n```
    if (s[i] === '`' && s[i + 1] === '`' && s[i + 2] === '`') {
      const langNl = s.indexOf('\n', i + 3);
      if (langNl !== -1) {
        const closeAt = s.indexOf('\n```', langNl);
        if (closeAt !== -1) {
          const content = s.slice(langNl + 1, closeAt);
          const startOut = out.length;
          out += content;
          addStyle('MONOSPACE', startOut, out.length);
          const afterClose = s.indexOf('\n', closeAt + 4);
          if (afterClose !== -1) {
            out += '\n';
            i = afterClose + 1;
          } else {
            i = n;
          }
          continue;
        }
      }
      out += s[i++];
      continue;
    }

    // Inline code  `text`
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1);
      const nl = s.indexOf('\n', i + 1);
      if (end !== -1 && (nl === -1 || end < nl)) {
        const startOut = out.length;
        out += s.slice(i + 1, end);
        addStyle('MONOSPACE', startOut, out.length);
        i = end + 1;
        continue;
      }
    }

    // Bold  **text**
    if (s[i] === '*' && s[i + 1] === '*' && s[i + 2] && s[i + 2] !== ' ') {
      const end = s.indexOf('**', i + 2);
      if (end !== -1 && s[end - 1] !== ' ') {
        const startOut = out.length;
        out += s.slice(i + 2, end);
        addStyle('BOLD', startOut, out.length);
        i = end + 2;
        continue;
      }
    }

    // Strikethrough  ~~text~~
    if (s[i] === '~' && s[i + 1] === '~' && s[i + 2] && s[i + 2] !== ' ') {
      const end = s.indexOf('~~', i + 2);
      if (end !== -1) {
        const startOut = out.length;
        out += s.slice(i + 2, end);
        addStyle('STRIKETHROUGH', startOut, out.length);
        i = end + 2;
        continue;
      }
    }

    // Italic  *text*
    if (s[i] === '*' && s[i + 1] !== '*' && s[i + 1] !== ' ' && s[i + 1]) {
      const end = findClosingStar(s, i + 1);
      if (end !== -1) {
        const startOut = out.length;
        out += s.slice(i + 1, end);
        addStyle('ITALIC', startOut, out.length);
        i = end + 1;
        continue;
      }
    }

    // Italic  _text_  (word boundaries only — guards snake_case)
    if (s[i] === '_' && s[i + 1] !== '_' && s[i + 1] !== ' ' && s[i + 1]) {
      const prevChar = i > 0 ? s[i - 1] : '';
      if (!/\w/.test(prevChar)) {
        const end = findClosingUnderscore(s, i + 1);
        if (end !== -1) {
          const startOut = out.length;
          out += s.slice(i + 1, end);
          addStyle('ITALIC', startOut, out.length);
          i = end + 1;
          continue;
        }
      }
    }

    // ATX Heading  ## text → BOLD
    if ((i === 0 || s[i - 1] === '\n') && s[i] === '#') {
      let j = i;
      while (j < n && s[j] === '#') j++;
      if (j < n && s[j] === ' ') {
        const lineEnd = s.indexOf('\n', j + 1);
        const headingText =
          lineEnd !== -1 ? s.slice(j + 1, lineEnd) : s.slice(j + 1);
        const startOut = out.length;
        out += headingText;
        addStyle('BOLD', startOut, out.length);
        if (lineEnd !== -1) {
          out += '\n';
          i = lineEnd + 1;
        } else {
          i = n;
        }
        continue;
      }
    }

    // Links  [text](url) → text (url)
    if (s[i] === '[') {
      const closeBracket = s.indexOf(']', i + 1);
      if (closeBracket !== -1 && s[closeBracket + 1] === '(') {
        const closeParen = s.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          out += `${s.slice(i + 1, closeBracket)} (${s.slice(closeBracket + 2, closeParen)})`;
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Horizontal rule  --- / *** / ___
    if (i === 0 || s[i - 1] === '\n') {
      const hrMatch = /^(-{3,}|\*{3,}|_{3,}) *(\n|$)/.exec(s.slice(i));
      if (hrMatch) {
        i += hrMatch[0].length;
        continue;
      }
    }

    // Default: copy character, preserving surrogate pairs
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < n) {
      out += s[i] + s[i + 1];
      i += 2;
    } else {
      out += s[i++];
    }
  }

  return { text: out, textStyle };
}

function findClosingStar(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\n') return -1;
    if (s[i] === '*' && s[i + 1] !== '*' && s[i - 1] !== ' ') return i;
  }
  return -1;
}

function findClosingUnderscore(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\n') return -1;
    if (s[i] === '_' && s[i + 1] !== '_' && !/\w/.test(s[i + 1] ?? ''))
      return i;
  }
  return -1;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface SignalQuote {
  id?: number;
  author?: string;
  authorName?: string;
  text?: string;
}

interface SignalDataMessage {
  timestamp?: number;
  message?: string;
  groupInfo?: { groupId: string; type?: string };
  quote?: SignalQuote;
}

interface SignalEnvelope {
  source?: string;
  sourceName?: string;
  sourceNumber?: string;
  timestamp?: number;
  dataMessage?: SignalDataMessage;
  syncMessage?: {
    sentMessage?: SignalDataMessage;
  };
  typingMessage?: {
    action?: string;
    groupId?: string;
  };
}

const DEFAULT_SOCKET_PATH = '/tmp/signal-cli.sock';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 60000;

export class SignalChannel implements Channel {
  name = 'signal';

  private socket: net.Socket | null = null;
  private connected = false;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private registeredGroups: () => Record<string, RegisteredGroup>;
  private accountNumber: string;
  private socketPath: string;
  private rpcId = 0;
  private pendingRpc = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = '';
  private lastSentTimestamps: Map<string, number> = new Map();
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shuttingDown = false;

  constructor(
    opts: ChannelOpts,
    accountNumber: string,
    socketPath?: string,
  ) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.registeredGroups = opts.registeredGroups;
    this.accountNumber = accountNumber;
    this.socketPath = socketPath || DEFAULT_SOCKET_PATH;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve, reject);
    });
  }

  private connectInternal(
    onFirstOpen?: () => void,
    onFirstError?: (err: Error) => void,
  ): void {
    const sock = net.createConnection({ path: this.socketPath });
    this.socket = sock;

    sock.on('connect', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      logger.info(
        { socketPath: this.socketPath },
        'Connected to signal-cli daemon',
      );

      // Sync group metadata on connect
      this.syncGroupMetadata().catch((err) =>
        logger.warn({ err }, 'Signal group sync failed'),
      );

      if (onFirstOpen) {
        onFirstOpen();
        onFirstOpen = undefined;
        onFirstError = undefined;
      }
    });

    sock.on('data', (data) => {
      this.buffer += data.toString();
      this.processBuffer();
    });

    sock.on('error', (err) => {
      logger.error({ err }, 'Signal socket error');
      if (onFirstError) {
        onFirstError(err);
        onFirstError = undefined;
        onFirstOpen = undefined;
      }
    });

    sock.on('close', () => {
      this.connected = false;
      // Reject any pending RPCs
      for (const [id, pending] of this.pendingRpc) {
        pending.reject(new Error('Socket closed'));
        this.pendingRpc.delete(id);
      }

      if (!this.shuttingDown) {
        this.scheduleReconnect();
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const prefix = `${ASSISTANT_NAME}: `;
    const { text: cleanText, textStyle } = parseSignalStyles(text);
    const prefixed = prefix + cleanText;

    // Shift style ranges to account for the "Name: " prefix.
    // Prefix is ASCII so prefix.length === its UTF-16 code unit count.
    const prefixLen = prefix.length;
    const offsetStyles: SignalTextStyle[] = textStyle.map((s) => ({
      ...s,
      start: s.start + prefixLen,
    }));

    const extra = jid.startsWith('signal:group:')
      ? { groupId: jid.slice('signal:group:'.length) }
      : { recipient: [jid.slice('signal:'.length)] };

    const baseParams: Record<string, unknown> = {
      account: this.accountNumber,
      message: prefixed,
      ...extra,
    };
    if (offsetStyles.length > 0) {
      // signal-cli JSON-RPC expects "textStyles" (plural) as "start:length:STYLE" strings.
      baseParams.textStyles = offsetStyles.map(
        (s) => `${s.start}:${s.length}:${s.style}`,
      );
    }

    let result: { timestamp?: number } | null = null;
    try {
      result = (await this.rpcCall('send', baseParams)) as {
        timestamp?: number;
      } | null;
    } catch (err) {
      if (offsetStyles.length > 0) {
        // signal-cli rejected textStyles — retry as plain text.
        logger.warn(
          { jid, err },
          'Signal send with textStyles failed, retrying without',
        );
        result = (await this.rpcCall('send', {
          account: this.accountNumber,
          message: prefixed,
          ...extra,
        })) as { timestamp?: number } | null;
      } else {
        throw err;
      }
    }

    if (result?.timestamp) {
      this.lastSentTimestamps.set(jid, result.timestamp);
    }
    logger.info(
      { jid, length: prefixed.length, styles: offsetStyles.length },
      'Signal message sent',
    );
  }

  async editMessage(
    jid: string,
    newText: string,
    originalTimestamp?: number,
  ): Promise<number> {
    const editTimestamp = originalTimestamp ?? this.lastSentTimestamps.get(jid);
    if (!editTimestamp) {
      throw new Error('No message to edit — no stored timestamp for this chat');
    }

    const prefix = `${ASSISTANT_NAME}: `;
    const { text: cleanText, textStyle } = parseSignalStyles(newText);
    const prefixLen = prefix.length;
    const offsetStyles: SignalTextStyle[] = textStyle.map((s) => ({
      ...s,
      start: s.start + prefixLen,
    }));

    const params: Record<string, unknown> = {
      account: this.accountNumber,
      message: prefix + cleanText,
      editTimestamp,
    };
    if (offsetStyles.length > 0) {
      params.textStyles = offsetStyles.map(
        (s) => `${s.start}:${s.length}:${s.style}`,
      );
    }

    if (jid.startsWith('signal:group:')) {
      params.groupId = jid.slice('signal:group:'.length);
    } else {
      params.recipient = [jid.slice('signal:'.length)];
    }

    await this.rpcCall('send', params);
    logger.info({ jid, editTimestamp }, 'Signal message edited');
    return editTimestamp;
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async disconnect(): Promise<void> {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connected = false;
    this.socket?.destroy();
    this.socket = null;
    logger.info('Signal channel disconnected');
  }

  async sendReaction(
    jid: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    // messageId format: "signal-{timestamp}"
    const ts = messageId.startsWith('signal-')
      ? parseInt(messageId.slice('signal-'.length), 10)
      : parseInt(messageId, 10);
    if (!ts || isNaN(ts)) {
      logger.warn(
        { jid, messageId },
        'Cannot send Signal reaction: invalid message ID',
      );
      return;
    }

    const msg = getMessageById(messageId);
    const targetAuthor = msg
      ? msg.is_from_me
        ? this.accountNumber
        : msg.sender
      : this.accountNumber;

    await this.cliSendReaction(jid, emoji, targetAuthor, ts, messageId);
  }

  private async cliSendReaction(
    jid: string,
    emoji: string,
    targetAuthor: string,
    targetTimestamp: number,
    messageId: string,
  ): Promise<void> {
    const params: Record<string, unknown> = {
      account: this.accountNumber,
      emoji,
      targetAuthor,
      targetTimestamp,
    };

    if (jid.startsWith('signal:group:')) {
      params.groupId = jid.slice('signal:group:'.length);
    } else {
      params.recipient = [jid.slice('signal:'.length)];
    }

    try {
      await this.rpcCall('sendReaction', params);
      storeReaction({
        chatJid: jid,
        messageId,
        emoji,
        timestamp: new Date().toISOString(),
      });
      logger.debug({ jid, messageId, emoji }, 'Signal reaction sent');
    } catch (err) {
      logger.warn(
        { jid, messageId, emoji, err },
        'Failed to send Signal reaction',
      );
    }
  }

  async reactToLatestMessage(jid: string, emoji: string): Promise<void> {
    const latest = getLatestMessage(jid);
    if (!latest) {
      logger.warn({ jid }, 'No latest message in DB for reaction');
      return;
    }

    // Determine the author of the message being reacted to
    const targetAuthor = latest.is_from_me
      ? this.accountNumber
      : latest.sender;

    const ts = latest.id.startsWith('signal-')
      ? parseInt(latest.id.slice('signal-'.length), 10)
      : parseInt(latest.id, 10);
    if (!ts || isNaN(ts)) {
      logger.warn(
        { jid, id: latest.id },
        'Cannot parse timestamp from message ID',
      );
      return;
    }

    await this.cliSendReaction(jid, emoji, targetAuthor, ts, latest.id);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      if (jid.startsWith('signal:group:')) {
        const groupId = jid.slice('signal:group:'.length);
        await this.rpcCall('sendTyping', {
          account: this.accountNumber,
          groupId,
          stop: !isTyping,
        });
      } else {
        const recipient = jid.slice('signal:'.length);
        await this.rpcCall('sendTyping', {
          account: this.accountNumber,
          recipient: [recipient],
          stop: !isTyping,
        });
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Signal typing indicator');
    }
  }

  // --- Private ---

  private async syncGroupMetadata(): Promise<void> {
    try {
      const result = (await this.rpcCall('listGroups', {
        account: this.accountNumber,
      })) as Array<{ id: string; name?: string }>;

      if (!Array.isArray(result)) return;

      for (const group of result) {
        if (group.id && group.name) {
          const chatJid = `signal:group:${group.id}`;
          this.onChatMetadata(
            chatJid,
            new Date().toISOString(),
            group.name,
            'signal',
            true,
          );
        }
      }
      logger.info({ count: result.length }, 'Signal group metadata synced');
    } catch (err) {
      logger.warn({ err }, 'Failed to list Signal groups');
    }
  }

  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    // Keep the last (potentially incomplete) line in the buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.id !== undefined && this.pendingRpc.has(parsed.id)) {
          // RPC response
          const pending = this.pendingRpc.get(parsed.id)!;
          this.pendingRpc.delete(parsed.id);
          const resp = parsed as JsonRpcResponse;
          if (resp.error) {
            pending.reject(
              new Error(`RPC error ${resp.error.code}: ${resp.error.message}`),
            );
          } else {
            pending.resolve(resp.result);
          }
        } else if (parsed.method) {
          // Notification
          this.handleNotification(parsed as JsonRpcNotification);
        }
      } catch (err) {
        logger.debug({ line: trimmed, err }, 'Failed to parse signal-cli JSON');
      }
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method !== 'receive' && notification.method !== 'sync')
      return;

    const envelope = notification.params?.envelope as
      | SignalEnvelope
      | undefined;
    if (!envelope) return;

    // Handle both regular messages and sync messages (self-sent)
    let dataMessage;
    let source;
    let senderName;

    if (envelope.syncMessage?.sentMessage) {
      // Sync message (your own message from another device)
      dataMessage = envelope.syncMessage.sentMessage;
      source = this.accountNumber; // It's from you
      senderName = 'You';
    } else if (envelope.dataMessage) {
      // Regular message from someone else
      dataMessage = envelope.dataMessage;
      source = envelope.sourceNumber || envelope.source || '';
      senderName = envelope.sourceName || source;
    } else {
      return;
    }

    if (!dataMessage?.message) return;

    const groupId = dataMessage.groupInfo?.groupId;
    const chatJid = groupId ? `signal:group:${groupId}` : `signal:${source}`;
    const isGroup = !!groupId;

    const timestamp = dataMessage.timestamp
      ? new Date(dataMessage.timestamp).toISOString()
      : new Date().toISOString();

    // Always emit chat metadata for discovery
    this.onChatMetadata(chatJid, timestamp, undefined, 'signal', isGroup);

    // Extract reply-threading quote fields if present
    const quote = dataMessage.quote;
    const quotedMessageId =
      quote?.id != null ? `signal-${quote.id}` : undefined;
    const quoteSenderName = quote?.authorName || quote?.author || undefined;
    const quoteContent = quote?.text || undefined;

    // Deliver message for registered groups
    const groups = this.registeredGroups();
    if (groups[chatJid]) {
      this.onMessage(chatJid, {
        id: `signal-${dataMessage.timestamp || Date.now()}`,
        chat_jid: chatJid,
        sender: source,
        sender_name: senderName,
        content: dataMessage.message,
        timestamp,
        is_from_me: source === this.accountNumber,
        is_bot_message: false,
        quoted_message_id: quotedMessageId,
        quote_sender_name: quoteSenderName,
        quote_content: quoteContent,
      });
    }
  }

  private rpcCall(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        reject(new Error('Signal socket not connected'));
        return;
      }

      const id = ++this.rpcId;
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params,
      });

      this.pendingRpc.set(id, { resolve, reject });

      this.socket.write(request + '\n', (err) => {
        if (err) {
          this.pendingRpc.delete(id);
          reject(err);
        }
      });

      // Timeout pending RPCs after 30s
      setTimeout(() => {
        if (this.pendingRpc.has(id)) {
          this.pendingRpc.delete(id);
          reject(new Error(`RPC timeout for ${method}`));
        }
      }, 30000);
    });
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;

    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;

    logger.info(
      { attempt: this.reconnectAttempts, delayMs: delay },
      'Scheduling Signal reconnect',
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      logger.info('Reconnecting to signal-cli daemon...');
      this.connectInternal();
    }, delay);
  }
}

registerChannel('signal', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SIGNAL_ACCOUNT_NUMBER', 'SIGNAL_SOCKET_PATH']);
  const accountNumber = envVars.SIGNAL_ACCOUNT_NUMBER;
  if (!accountNumber) {
    logger.info('SIGNAL_ACCOUNT_NUMBER not set, skipping Signal channel');
    return null;
  }
  return new SignalChannel(opts, accountNumber, envVars.SIGNAL_SOCKET_PATH);
});
