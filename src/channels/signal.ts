/**
 * Signal channel for NanoClaw via signal-cli JSON-RPC daemon.
 *
 * Requires:
 *   - signal-cli running in daemon mode: signal-cli -a <account> daemon --http 0.0.0.0:8581
 *   - Environment: SIGNAL_ACCOUNT (phone number, e.g. +17733409232)
 *   - Optional:    SIGNAL_CLI_URL  (default: http://127.0.0.1:8581)
 */

import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/** Delay before reconnecting SSE after disconnect (ms). */
const SSE_RECONNECT_DELAY = 3000;

/** Signal has no hard limit, but keep chunks reasonable. */
const SIGNAL_MAX_MESSAGE_LENGTH = 4000;

// ---------- Markdown → Signal native textStyle conversion ----------

/**
 * Signal text style range: { style, start, length }.
 * signal-cli JSON-RPC accepts these as the `textStyle` param,
 * formatted as "start:length:STYLE".
 */
interface SignalTextStyle {
  style: 'BOLD' | 'ITALIC' | 'MONOSPACE' | 'STRIKETHROUGH' | 'SPOILER';
  start: number;
  length: number;
}

/**
 * Strip markdown markers and produce Signal-native textStyle ranges.
 *
 * Handles (in priority order):
 *   ```code blocks``` → MONOSPACE (fenced, multi-line)
 *   `inline code`     → MONOSPACE
 *   **bold**          → BOLD
 *   *bold*            → BOLD  (single asterisk = bold in Signal convention)
 *   _italic_          → ITALIC
 *   ~~strikethrough~~ → STRIKETHROUGH
 *   ||spoiler||       → SPOILER
 *
 * Code blocks are processed first and their interiors are protected from
 * further marker substitution.
 */
function parseSignalStyles(input: string): {
  text: string;
  textStyle: SignalTextStyle[];
} {
  const styles: SignalTextStyle[] = [];

  // Track protected ranges (code blocks) so we don't double-parse inside them
  const protectedRanges: Array<{ start: number; end: number }> = [];

  // Phase 1: Strip fenced code blocks  ```...```
  let text = input.replace(
    /```(?:\w*\n)?([\s\S]*?)```/g,
    (_match, code: string, offset: number) => {
      // We'll fix offsets after all replacements — collect raw for now
      return `\x00FENCED\x00${code}\x00ENDFENCED\x00`;
    },
  );

  // Phase 2: Strip inline code  `...`
  text = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    return `\x00INLINE\x00${code}\x00ENDINLINE\x00`;
  });

  // Phase 3: Process non-code markers in order
  // Bold: **text** or *text* (Signal uses single * for bold, unlike Markdown)
  // Italic: _text_
  // Strikethrough: ~~text~~
  // Spoiler: ||text||
  const markerPatterns: Array<{
    regex: RegExp;
    style: SignalTextStyle['style'];
  }> = [
    { regex: /\*\*(.+?)\*\*/g, style: 'BOLD' },
    { regex: /\*(.+?)\*/g, style: 'BOLD' },
    { regex: /_(.+?)_/g, style: 'ITALIC' },
    { regex: /~~(.+?)~~/g, style: 'STRIKETHROUGH' },
    { regex: /\|\|(.+?)\|\|/g, style: 'SPOILER' },
  ];

  for (const { regex, style } of markerPatterns) {
    // Rebuild text after each marker pass so offsets stay correct
    let result = '';
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const localRegex = new RegExp(regex.source, regex.flags);

    while ((match = localRegex.exec(text)) !== null) {
      const fullMatch = match[0];
      const inner = match[1];
      const matchStart = match.index;

      // Skip if inside a protected sentinel range
      const inProtected = fullMatch.includes('\x00');
      if (inProtected) continue;

      result += text.slice(lastIndex, matchStart);
      const styleStart = result.length;
      result += inner;
      styles.push({ style, start: styleStart, length: inner.length });
      lastIndex = matchStart + fullMatch.length;
    }

    result += text.slice(lastIndex);
    text = result;
  }

  // Phase 4: Restore code blocks with MONOSPACE styles
  // Fenced blocks
  text = text.replace(
    /\x00FENCED\x00([\s\S]*?)\x00ENDFENCED\x00/g,
    (_match, code: string) => {
      // We need the offset in the current text — use a placeholder approach
      return `\x00CODEFINAL\x00${code}\x00ENDCODEFINAL\x00`;
    },
  );

  // Inline code
  text = text.replace(
    /\x00INLINE\x00([\s\S]*?)\x00ENDINLINE\x00/g,
    (_match, code: string) => {
      return `\x00CODEFINAL\x00${code}\x00ENDCODEFINAL\x00`;
    },
  );

  // Final pass: extract code positions and remove sentinels
  let finalText = '';
  let i = 0;
  const SENTINEL_START = '\x00CODEFINAL\x00';
  const SENTINEL_END = '\x00ENDCODEFINAL\x00';

  while (i < text.length) {
    const startIdx = text.indexOf(SENTINEL_START, i);
    if (startIdx === -1) {
      finalText += text.slice(i);
      break;
    }

    finalText += text.slice(i, startIdx);
    const contentStart = startIdx + SENTINEL_START.length;
    const endIdx = text.indexOf(SENTINEL_END, contentStart);
    if (endIdx === -1) {
      // Malformed — just dump the rest
      finalText += text.slice(startIdx);
      break;
    }

    const code = text.slice(contentStart, endIdx);
    const styleStart = finalText.length;
    finalText += code;
    styles.push({ style: 'MONOSPACE', start: styleStart, length: code.length });
    i = endIdx + SENTINEL_END.length;
  }

  return { text: finalText, textStyle: styles };
}

/**
 * Convert SignalTextStyle array to signal-cli's string format: "start:length:STYLE"
 */
function formatTextStyles(styles: SignalTextStyle[]): string[] {
  return styles.map((s) => `${s.start}:${s.length}:${s.style}`);
}

// ---------- signal-cli envelope types ----------

interface SignalEnvelope {
  source?: string;
  sourceNumber?: string;
  sourceName?: string;
  sourceUuid?: string;
  timestamp?: number;
  dataMessage?: SignalDataMessage;
  typingMessage?: { action?: string; groupId?: string };
  receiptMessage?: { type?: string; timestamps?: number[] };
}

interface SignalDataMessage {
  message?: string;
  timestamp?: number;
  groupInfo?: { groupId?: string; type?: string };
  attachments?: Array<{
    contentType?: string;
    filename?: string;
    id?: string;
    size?: number;
  }>;
  quote?: {
    id?: number;
    author?: string;
    authorNumber?: string;
    text?: string;
  };
}

// ---------- channel implementation ----------

export class SignalChannel implements Channel {
  name = 'signal';

  private baseUrl: string;
  private account: string;
  private connected = false;
  private sseAbort: AbortController | null = null;
  private sseReconnectTimer: NodeJS.Timeout | null = null;
  private rpcId = 0;
  private opts: {
    onMessage: OnInboundMessage;
    onChatMetadata: OnChatMetadata;
    registeredGroups: () => Record<string, RegisteredGroup>;
  };

  constructor(account: string, baseUrl: string, opts: ChannelOpts) {
    this.account = account;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.opts = opts;
    this.ensureNoProxy();
  }

  /**
   * Ensure signal-cli host is in no_proxy so Node's fetch doesn't route
   * through any HTTP proxy (e.g. OneCLI gateway) for local daemon calls.
   * Without this, SSE streaming hangs because the proxy buffers events.
   */
  private ensureNoProxy(): void {
    try {
      const host = new URL(this.baseUrl).hostname;
      for (const key of ['no_proxy', 'NO_PROXY']) {
        const current = process.env[key] || '';
        const hosts = current
          .split(',')
          .map((h) => h.trim())
          .filter(Boolean);
        if (!hosts.includes(host)) {
          process.env[key] = current ? `${current},${host}` : host;
        }
      }
    } catch {
      // URL parse failure — baseUrl is invalid, connect() will fail later
    }
  }

  // ---- JSON-RPC 2.0 helper ----

  private async rpc(
    method: string,
    params: Record<string, unknown>,
  ): Promise<any> {
    const id = String(++this.rpcId);
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      id,
      params: { account: this.account, ...params },
    });

    const resp = await fetch(`${this.baseUrl}/api/v1/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(
        `signal-cli RPC ${method} failed: ${resp.status} ${text}`,
      );
    }

    const json = (await resp.json()) as {
      result?: unknown;
      error?: unknown;
    };
    if (json.error) {
      throw new Error(
        `signal-cli RPC ${method} error: ${JSON.stringify(json.error)}`,
      );
    }

    return json.result;
  }

  // ---- Channel interface ----

  async connect(): Promise<void> {
    try {
      // Verify daemon is reachable — listGroups is a safe probe
      await this.rpc('listGroups', {});
      this.connected = true;
      logger.info(
        { account: this.account, url: this.baseUrl },
        'Signal channel connected',
      );
      console.log(`\n  Signal: ${this.account}`);
      console.log(`  Daemon: ${this.baseUrl}\n`);

      this.startSSE();
    } catch (err) {
      // Don't throw — let NanoClaw start without Signal if daemon isn't running.
      // This mirrors Telegram's pattern: disabled if creds missing.
      logger.warn(
        { account: this.account, url: this.baseUrl, err },
        'Signal: cannot reach signal-cli daemon (channel disabled)',
      );
      this.connected = false;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.connected) {
      logger.warn('Signal channel not connected');
      return;
    }

    try {
      const chunks = this.splitMessage(text);

      for (const chunk of chunks) {
        const { text: plainText, textStyle } = parseSignalStyles(chunk);
        const styleStrings = formatTextStyles(textStyle);

        const params: Record<string, unknown> = {
          message: plainText,
        };

        // Only include textStyle if there are styles to apply
        if (styleStrings.length > 0) {
          params.textStyle = styleStrings;
        }

        if (this.isGroupJid(jid)) {
          params.groupId = jid.replace('signal:group:', '');
          await this.rpc('sendGroupMessage', params);
        } else {
          params.recipient = [jid.replace('signal:', '')];
          await this.rpc('send', params);
        }
      }

      logger.info({ jid, length: text.length }, 'Signal message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal message');
    }
  }

  async sendImage(
    jid: string,
    imagePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.connected) return;

    try {
      const params: Record<string, unknown> = {
        attachment: [imagePath],
        message: caption || '',
      };

      if (this.isGroupJid(jid)) {
        params.groupId = jid.replace('signal:group:', '');
        await this.rpc('sendGroupMessage', params);
      } else {
        params.recipient = [jid.replace('signal:', '')];
        await this.rpc('send', params);
      }

      logger.info({ jid, imagePath }, 'Signal image sent');
    } catch (err) {
      logger.error({ jid, imagePath, err }, 'Failed to send Signal image');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async disconnect(): Promise<void> {
    if (this.sseAbort) {
      this.sseAbort.abort();
      this.sseAbort = null;
    }
    if (this.sseReconnectTimer) {
      clearTimeout(this.sseReconnectTimer);
      this.sseReconnectTimer = null;
    }
    this.connected = false;
    logger.info('Signal channel disconnected');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected || !isTyping) return;
    try {
      if (this.isGroupJid(jid)) {
        await this.rpc('sendTyping', {
          groupId: jid.replace('signal:group:', ''),
        });
      } else {
        await this.rpc('sendTyping', {
          recipient: [jid.replace('signal:', '')],
        });
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Signal typing indicator');
    }
  }

  // Signal doesn't support editing sent messages, so streaming falls back
  // to sendMessage() automatically (no sendMessageReturningId / editMessage).

  // ---- internals ----

  /**
   * Connect to the signal-cli SSE endpoint (GET /api/v1/events).
   * The daemon pushes incoming messages as Server-Sent Events.
   * On disconnect, automatically reconnect after a short delay.
   */
  private startSSE(): void {
    if (this.sseAbort) return;

    const controller = new AbortController();
    this.sseAbort = controller;
    const url = `${this.baseUrl}/api/v1/events`;

    logger.info({ url }, 'Signal SSE: connecting');

    fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/event-stream' },
    })
      .then(async (resp) => {
        if (!resp.ok || !resp.body) {
          throw new Error(`SSE connect failed: ${resp.status}`);
        }

        logger.info('Signal SSE: stream connected');

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // SSE format: "data: <json>\n\n"
          const parts = buffer.split('\n\n');
          // Keep the last (possibly incomplete) chunk in the buffer
          buffer = parts.pop() || '';

          for (const part of parts) {
            const lines = part.split('\n');
            let data = '';
            for (const line of lines) {
              if (line.startsWith('data:')) {
                data += line.slice(5).trimStart();
              }
            }
            if (data) {
              logger.debug(
                { dataLength: data.length },
                'Signal SSE: event received',
              );
              this.handleSSEData(data);
            }
          }
        }

        // Stream ended normally — reconnect
        logger.info('Signal SSE: stream ended, reconnecting');
        this.scheduleSSEReconnect();
      })
      .catch((err) => {
        if (controller.signal.aborted) return; // Intentional disconnect
        logger.warn({ err }, 'Signal SSE: connection error, reconnecting');
        this.scheduleSSEReconnect();
      });
  }

  private handleSSEData(data: string): void {
    try {
      const parsed = JSON.parse(data);

      // signal-cli sends JSON-RPC notifications with method "receive"
      // Format: { "jsonrpc":"2.0", "method":"receive", "params": { "envelope": {...}, "account": "..." } }
      const envelope =
        parsed?.params?.envelope ||
        parsed?.params?.result?.envelope ||
        parsed?.envelope;

      if (envelope) {
        this.handleEnvelope(envelope);
      }
    } catch (err) {
      logger.debug(
        { err, data: data.slice(0, 200) },
        'Signal SSE: failed to parse event',
      );
    }
  }

  private scheduleSSEReconnect(): void {
    this.sseAbort = null;
    if (!this.connected) return;
    if (this.sseReconnectTimer) return;

    this.sseReconnectTimer = setTimeout(() => {
      this.sseReconnectTimer = null;
      if (this.connected) {
        this.startSSE();
      }
    }, SSE_RECONNECT_DELAY);
  }

  private handleEnvelope(envelope: SignalEnvelope): void {
    // Only handle data messages (not receipts, typing, etc.)
    if (!envelope.dataMessage) return;

    const dm = envelope.dataMessage;
    const content = dm.message;
    if (!content) return; // No text content (e.g. attachment-only or reaction)

    const sourceNumber = envelope.source || envelope.sourceNumber || '';
    const sourceName = envelope.sourceName || sourceNumber;
    const sourceUuid = envelope.sourceUuid || '';
    const timestamp = envelope.timestamp
      ? new Date(envelope.timestamp).toISOString()
      : new Date().toISOString();

    // Determine JID: group or DM
    const groupId = dm.groupInfo?.groupId;
    const chatJid = groupId
      ? `signal:group:${groupId}`
      : `signal:${sourceNumber}`;

    const isGroup = !!groupId;
    const msgId = `${envelope.timestamp || Date.now()}`;

    // Handle quotes/replies
    const quote = dm.quote;
    const replyToMessageId = quote?.id?.toString();
    const replyToContent = quote?.text;
    const replyToSender = quote?.author || quote?.authorNumber;

    // Chat metadata discovery
    this.opts.onChatMetadata(
      chatJid,
      timestamp,
      isGroup ? undefined : sourceName,
      'signal',
      isGroup,
    );

    // Only deliver for registered groups/chats
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, sourceName },
        'Message from unregistered Signal chat',
      );
      return;
    }

    // Download attachments if present
    const attachments = dm.attachments?.map((att) => ({
      type: this.inferAttachmentType(att.contentType),
      path: att.id || '',
      mimeType: att.contentType,
    }));

    // Deliver message — startMessageLoop() will pick it up
    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: sourceUuid || sourceNumber,
      sender_name: sourceName,
      content,
      timestamp,
      is_from_me: false,
      reply_to_message_id: replyToMessageId,
      reply_to_message_content: replyToContent,
      reply_to_sender_name: replyToSender,
      attachments:
        attachments && attachments.length > 0 ? attachments : undefined,
    });

    logger.info({ chatJid, sender: sourceName }, 'Signal message stored');
  }

  private inferAttachmentType(
    contentType?: string,
  ): 'image' | 'video' | 'audio' | 'document' {
    if (!contentType) return 'document';
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('video/')) return 'video';
    if (contentType.startsWith('audio/')) return 'audio';
    return 'document';
  }

  private isGroupJid(jid: string): boolean {
    return jid.startsWith('signal:group:');
  }

  private splitMessage(text: string): string[] {
    if (text.length <= SIGNAL_MAX_MESSAGE_LENGTH) return [text];
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += SIGNAL_MAX_MESSAGE_LENGTH) {
      chunks.push(text.slice(i, i + SIGNAL_MAX_MESSAGE_LENGTH));
    }
    return chunks;
  }
}

// ---- self-registration ----

registerChannel('signal', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SIGNAL_ACCOUNT', 'SIGNAL_CLI_URL']);
  const account = process.env.SIGNAL_ACCOUNT || envVars.SIGNAL_ACCOUNT || '';
  const baseUrl =
    process.env.SIGNAL_CLI_URL ||
    envVars.SIGNAL_CLI_URL ||
    'http://127.0.0.1:8581';

  if (!account) {
    logger.warn('Signal: SIGNAL_ACCOUNT not set — channel disabled');
    return null;
  }

  return new SignalChannel(account, baseUrl, opts);
});
