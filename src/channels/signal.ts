/**
 * Signal channel adapter for NanoClaw v2.
 *
 * Uses signal-cli's TCP JSON-RPC daemon for bidirectional messaging.
 * Requires signal-cli (https://github.com/AsamK/signal-cli) installed
 * and a linked account.
 *
 * Ported from v1 — see v1 source for commit history.
 */
import { execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

// ---------------------------------------------------------------------------
// Signal CLI daemon management
// ---------------------------------------------------------------------------

interface DaemonHandle {
  stop: () => void;
  exited: Promise<void>;
  isExited: () => boolean;
}

function spawnSignalDaemon(cliPath: string, account: string, host: string, port: number): DaemonHandle {
  const args: string[] = [];
  if (account) args.push('-a', account);
  args.push('daemon', '--tcp', `${host}:${port}`, '--no-receive-stdout');
  args.push('--receive-mode', 'on-start');

  const child = spawn(cliPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let exited = false;

  const exitedPromise = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      if (code !== 0 && code !== null) {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        log.error('signal-cli daemon exited', { reason });
      }
      resolve();
    });
    child.on('error', (err) => {
      exited = true;
      log.error('signal-cli spawn error', { err });
      resolve();
    });
  });

  child.stdout?.on('data', (data: Buffer) => {
    for (const line of data.toString().split(/\r?\n/)) {
      if (line.trim()) log.debug('signal-cli stdout', { line: line.trim() });
    }
  });
  child.stderr?.on('data', (data: Buffer) => {
    for (const line of data.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (/\b(ERROR|WARN|FAILED|SEVERE)\b/i.test(line)) {
        log.warn('signal-cli stderr', { line: line.trim() });
      } else {
        log.debug('signal-cli stderr', { line: line.trim() });
      }
    }
  });

  return {
    stop: () => {
      if (!child.killed && !exited) child.kill('SIGTERM');
    },
    exited: exitedPromise,
    isExited: () => exited,
  };
}

// ---------------------------------------------------------------------------
// TCP JSON-RPC client for signal-cli daemon (--tcp mode)
//
// signal-cli 0.14.x --tcp exposes a newline-delimited JSON-RPC socket.
// Requests are sent as JSON + newline; responses and push notifications
// (inbound messages) arrive the same way.
// ---------------------------------------------------------------------------

const RPC_TIMEOUT_MS = 15_000;

class SignalTcpClient {
  private socket: Socket | null = null;
  private buffer = '';
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private onNotification: ((method: string, params: unknown) => void) | null = null;
  private onClose: (() => void) | null = null;

  constructor(
    private host: string,
    private port: number,
  ) {}

  connect(handlers?: {
    onNotification?: (method: string, params: unknown) => void;
    onClose?: () => void;
  }): Promise<void> {
    this.onNotification = handlers?.onNotification ?? null;
    this.onClose = handlers?.onClose ?? null;
    return new Promise((resolve, reject) => {
      const sock = createConnection(this.port, this.host, () => {
        this.socket = sock;
        resolve();
      });
      sock.on('error', (err) => {
        if (!this.socket) {
          reject(err);
          return;
        }
        log.warn('Signal TCP socket error', { err });
      });
      sock.on('data', (chunk) => this.onData(chunk));
      sock.on('close', () => {
        const wasConnected = this.socket !== null;
        this.socket = null;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('Signal TCP connection closed'));
        }
        this.pending.clear();
        if (wasConnected) this.onClose?.();
      });
    });
  }

  async rpc<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!this.socket) throw new Error('Signal TCP not connected');
    const id = Math.random().toString(36).slice(2);
    const msg = JSON.stringify({ jsonrpc: '2.0', method, params, id }) + '\n';

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Signal RPC timeout: ${method}`));
      }, RPC_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.socket!.write(msg);
    });
  }

  close() {
    this.socket?.destroy();
    this.socket = null;
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString();
    let newlineIdx = this.buffer.indexOf('\n');
    while (newlineIdx !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);
      if (line) this.handleLine(line);
      newlineIdx = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string) {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      log.debug('Signal TCP: unparseable line', { line: line.slice(0, 200) });
      return;
    }

    if (parsed.id && this.pending.has(parsed.id)) {
      const p = this.pending.get(parsed.id)!;
      this.pending.delete(parsed.id);
      clearTimeout(p.timer);
      if (parsed.error) {
        p.reject(new Error(parsed.error.message ?? 'Signal RPC error'));
      } else {
        p.resolve(parsed.result);
      }
      return;
    }

    if (parsed.method && this.onNotification) {
      this.onNotification(parsed.method, parsed.params);
    }
  }
}

async function signalTcpCheck(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(result);
    };
    const sock = createConnection(port, host, () => finish(true));
    sock.on('error', () => finish(false));
    const timer = setTimeout(() => finish(false), 5000);
  });
}

// ---------------------------------------------------------------------------
// Echo cache
// ---------------------------------------------------------------------------

const ECHO_TTL_MS = 10_000;

/**
 * Per-recipient dedup for messages we sent ourselves.
 *
 * signal-cli echoes our own outbound back via syncMessage (and, for Note to
 * Self, via sentMessage-with-self-destination). Without dedup, the agent sees
 * its own replies as new inbound and loops. We remember `(platformId, text)`
 * briefly after every send, and drop the first match within TTL.
 *
 * Keying on text alone is not enough: if we send "hi" to Alice and Bob then
 * sends "hi" from a different chat, Bob's real message gets silently dropped.
 */
class EchoCache {
  private entries = new Map<string, number>();

  private keyFor(platformId: string, text: string): string {
    return `${platformId}\x00${text.trim()}`;
  }

  remember(platformId: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.entries.set(this.keyFor(platformId, trimmed), Date.now());
    this.cleanup();
  }

  isEcho(platformId: string, text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const key = this.keyFor(platformId, trimmed);
    const ts = this.entries.get(key);
    if (!ts) return false;
    if (Date.now() - ts > ECHO_TTL_MS) {
      this.entries.delete(key);
      return false;
    }
    this.entries.delete(key);
    return true;
  }

  /**
   * Reaction-shaped echo entries. Keyed on `(platformId, emoji,
   * targetSentTimestamp)` rather than text — text-keying would either collide
   * with a real message or never match because reactions have no text body.
   */
  private reactionKey(platformId: string, emoji: string, targetTimestamp: number): string {
    return `${platformId}\x00reaction\x00${emoji}\x00${targetTimestamp}`;
  }

  rememberReaction(platformId: string, emoji: string, targetTimestamp: number): void {
    this.entries.set(this.reactionKey(platformId, emoji, targetTimestamp), Date.now());
    this.cleanup();
  }

  isEchoReaction(platformId: string, emoji: string, targetTimestamp: number): boolean {
    const key = this.reactionKey(platformId, emoji, targetTimestamp);
    const ts = this.entries.get(key);
    if (!ts) return false;
    if (Date.now() - ts > ECHO_TTL_MS) {
      this.entries.delete(key);
      return false;
    }
    this.entries.delete(key);
    return true;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, ts] of this.entries) {
      if (now - ts > ECHO_TTL_MS) this.entries.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Signal envelope types
// ---------------------------------------------------------------------------

interface SignalQuote {
  id?: number;
  author?: string;
  authorNumber?: string;
  authorUuid?: string;
  authorName?: string;
  text?: string;
}

interface SignalMention {
  start?: number;
  length?: number;
  uuid?: string;
  number?: string;
  name?: string;
}

interface SignalReaction {
  emoji?: string;
  targetAuthor?: string;
  targetAuthorNumber?: string;
  targetAuthorUuid?: string;
  targetSentTimestamp?: number;
  isRemove?: boolean;
}

interface SignalDataMessage {
  timestamp?: number;
  message?: string;
  mentions?: SignalMention[];
  groupInfo?: { groupId?: string; groupName?: string; type?: string };
  groupV2?: { id?: string };
  quote?: SignalQuote;
  reaction?: SignalReaction;
  attachments?: Array<{
    id?: string;
    contentType?: string;
    filename?: string;
    size?: number;
  }>;
}

interface SignalEnvelope {
  source?: string;
  sourceName?: string;
  sourceNumber?: string;
  sourceUuid?: string;
  dataMessage?: SignalDataMessage;
  syncMessage?: {
    sentMessage?: SignalDataMessage & {
      destination?: string;
      destinationNumber?: string;
    };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Replace inline `@<placeholder>` mention markers with display names so the
 * agent sees `@Alice` instead of a raw UUID. Signal's protocol uses a single
 * placeholder character (typically U+FFFC) at each mention's `start` offset.
 */
function resolveMentions(text: string, mentions?: SignalMention[]): string {
  if (!mentions || mentions.length === 0) return text;
  const sorted = [...mentions].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  let result = '';
  let cursor = 0;
  for (const m of sorted) {
    const start = m.start ?? 0;
    const length = m.length ?? 1;
    const name = m.name || m.number || (m.uuid ? m.uuid.slice(0, 8) : 'someone');
    if (start < cursor) continue;
    result += text.slice(cursor, start) + `@${name}`;
    cursor = start + length;
  }
  result += text.slice(cursor);
  return result;
}

/**
 * Optional voice-note transcription. Tries (in order):
 *   1. local whisper.cpp CLI when `WHISPER_BIN` is set
 *   2. OpenAI Whisper API when `OPENAI_API_KEY` is set
 * Returns null if neither path is configured or transcription fails — caller
 * falls back to a `[Voice Message]` placeholder.
 *
 * Signal voice notes are AAC/ADTS; whisper-cpp wants WAV. ffmpeg is invoked
 * if available to convert; if ffmpeg is missing the local path is skipped.
 */
async function transcribeAudioOptional(filePath: string): Promise<string | null> {
  const whisperBin = process.env.WHISPER_BIN;
  if (whisperBin) {
    try {
      const wavPath = `${filePath}.wav`;
      execSync(`ffmpeg -y -loglevel error -i "${filePath}" -ar 16000 -ac 1 "${wavPath}"`, { stdio: 'ignore' });
      const model = process.env.WHISPER_MODEL || `${homedir()}/.local/share/whisper/models/ggml-base.en.bin`;
      const out = execSync(`"${whisperBin}" -m "${model}" -f "${wavPath}" -nt -otxt -of "${wavPath}"`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      try {
        unlinkSync(wavPath);
        unlinkSync(`${wavPath}.txt`);
      } catch {}
      const text = out.replace(/\[[^\]]*\]/g, '').trim();
      if (text) return text;
    } catch (err) {
      log.debug('Signal: local whisper transcription failed, trying OpenAI', { err });
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    try {
      const buf = readFileSync(filePath);
      const boundary = `----nanoclaw-${Date.now()}`;
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.aac"\r\nContent-Type: audio/aac\r\n\r\n`,
        ),
        buf,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });
      if (res.ok) {
        const json = (await res.json()) as { text?: string };
        if (json.text) return json.text.trim();
      }
    } catch (err) {
      log.debug('Signal: OpenAI transcription failed', { err });
    }
  }

  return null;
}

function chunkText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Emoji shortcode → unicode
//
// The agent-runner's `add_reaction` MCP tool documents emoji as shortcode
// names (`thumbs_up`, `heart`, `white_check_mark`). signal-cli's sendReaction
// expects the literal unicode character. Chat SDK handles this internally for
// chat-sdk channels; native adapters need to do it themselves.
//
// Coverage focuses on the shortcodes the tool's instructions mention plus the
// most commonly-used reactions. Unknown shortcodes fall back to 👍 with a
// warning so the agent's intent ("react to acknowledge") still goes through
// rather than the call quietly dropping.
// ---------------------------------------------------------------------------

const DEFAULT_EMOJI = '👍';

const EMOJI_SHORTCODES: Record<string, string> = {
  thumbs_up: '👍',
  '+1': '👍',
  thumbsup: '👍',
  thumbs_down: '👎',
  '-1': '👎',
  thumbsdown: '👎',
  heart: '❤️',
  red_heart: '❤️',
  white_check_mark: '✅',
  check: '✅',
  check_mark: '✅',
  x: '❌',
  cross_mark: '❌',
  no_entry: '⛔',
  warning: '⚠️',
  eyes: '👀',
  fire: '🔥',
  hundred: '💯',
  '100': '💯',
  pray: '🙏',
  raised_hands: '🙌',
  clap: '👏',
  ok_hand: '👌',
  joy: '😂',
  laughing: '😂',
  smile: '😄',
  smiley: '😃',
  grin: '😁',
  wink: '😉',
  thinking: '🤔',
  thinking_face: '🤔',
  cry: '😢',
  sob: '😭',
  rage: '😡',
  angry: '😠',
  sweat_smile: '😅',
  shrug: '🤷',
  party: '🎉',
  tada: '🎉',
  rocket: '🚀',
  star: '⭐',
  sparkles: '✨',
  bulb: '💡',
  zap: '⚡',
  bell: '🔔',
  question: '❓',
  exclamation: '❗',
  wave: '👋',
  point_up: '☝️',
  point_right: '👉',
  muscle: '💪',
  brain: '🧠',
  robot: '🤖',
  see_no_evil: '🙈',
  hear_no_evil: '🙉',
  speak_no_evil: '🙊',
};

/**
 * Resolve an agent-supplied emoji argument to a single unicode emoji.
 *
 * Inputs in priority order:
 *   1. Already-unicode (anything that doesn't match `[a-z0-9_+-]+` ASCII) → pass through
 *   2. Known shortcode in EMOJI_SHORTCODES → mapped unicode
 *   3. Anything else → DEFAULT_EMOJI + warning
 *
 * Strips a leading/trailing colon so `:thumbs_up:` works alongside `thumbs_up`.
 */
function emojiToUnicode(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return DEFAULT_EMOJI;
  const stripped = trimmed.replace(/^:|:$/g, '');
  // ASCII-only shortcode pattern — anything containing non-ASCII is assumed
  // to already be a unicode emoji (or grapheme cluster).
  if (/^[a-z0-9_+-]+$/i.test(stripped)) {
    const mapped = EMOJI_SHORTCODES[stripped.toLowerCase()];
    if (mapped) return mapped;
    log.warn('Signal: unknown emoji shortcode, falling back to default', {
      shortcode: stripped,
      fallback: DEFAULT_EMOJI,
    });
    return DEFAULT_EMOJI;
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Signal text styles — convert Markdown to Signal's offset-based formatting
// ---------------------------------------------------------------------------

interface SignalTextStyle {
  style: 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'MONOSPACE' | 'SPOILER';
  start: number;
  length: number;
}

interface StyledText {
  text: string;
  textStyles: SignalTextStyle[];
}

/**
 * Convert Markdown-ish input to Signal's offset-based style ranges.
 *
 * Walks the input recursively: at each level we find the leftmost matching
 * pattern, descend into its captured inner text (so `**bold with \`code\`
 * inside**` stays bold-plus-monospace rather than leaking stripped markers),
 * then continue past the match. Style offsets are recorded against the
 * *output* text length as it's built, so nested styles always point at the
 * right span of the final plain text.
 */
function parseSignalStyles(input: string): StyledText {
  const styles: SignalTextStyle[] = [];

  // Ordering matters: longer/greedier delimiters first so `` ``` `` beats
  // `` ` ``, `**` beats `*`. The italic-`*` pattern refuses to start on
  // whitespace so `*` isn't mistakenly opened on " * " in list-like text.
  const patterns: Array<{ regex: RegExp; style: SignalTextStyle['style'] }> = [
    { regex: /```([\s\S]+?)```/, style: 'MONOSPACE' },
    { regex: /`([^`]+)`/, style: 'MONOSPACE' },
    { regex: /\*\*([^]+?)\*\*/, style: 'BOLD' },
    { regex: /~~([^]+?)~~/, style: 'STRIKETHROUGH' },
    { regex: /\|\|([^]+?)\|\|/, style: 'SPOILER' },
    { regex: /\*([^*\s][^*]*?)\*/, style: 'ITALIC' },
    { regex: /_([^_\s][^_]*?)_/, style: 'ITALIC' },
  ];

  function walk(segment: string, outputBase: number): string {
    let earliest: { start: number; match: RegExpExecArray; style: SignalTextStyle['style'] } | null = null;
    for (const { regex, style } of patterns) {
      const m = regex.exec(segment);
      if (!m) continue;
      if (earliest === null || m.index < earliest.start) {
        earliest = { start: m.index, match: m, style };
      }
    }
    if (!earliest) return segment;

    const before = segment.slice(0, earliest.start);
    const fullMatch = earliest.match[0];
    const inner = earliest.match[1];
    const afterStart = earliest.start + fullMatch.length;
    const after = segment.slice(afterStart);

    const innerOut = walk(inner, outputBase + before.length);
    styles.push({
      style: earliest.style,
      start: outputBase + before.length,
      length: innerOut.length,
    });
    const afterOut = walk(after, outputBase + before.length + innerOut.length);

    return before + innerOut + afterOut;
  }

  const text = walk(input, 0);
  return { text, textStyles: styles };
}

// ---------------------------------------------------------------------------
// SignalAdapter — v2 ChannelAdapter implementation
// ---------------------------------------------------------------------------

/**
 * Platform ID format:
 *   DM:    phone number or UUID (e.g. "+15555550123")
 *   Group: "group:<groupId>" (e.g. "group:abc123")
 *
 * channelType is always "signal". The router combines channelType + platformId
 * to look up or create the messaging_group.
 */
export function createSignalAdapter(config: {
  cliPath: string;
  account: string;
  tcpHost: string;
  tcpPort: number;
  manageDaemon: boolean;
  signalDataDir: string;
}): ChannelAdapter {
  let daemon: DaemonHandle | null = null;
  let tcp: SignalTcpClient | null = null;
  let connected = false;
  const echoCache = new EchoCache();
  let setup: ChannelSetup | null = null;

  // -- inbound handling --

  function handleNotification(method: string, params: unknown): void {
    if (method === 'receive') {
      const envelope = (params as any)?.envelope;
      if (envelope) {
        handleEnvelope(envelope).catch((err) => {
          log.error('Signal: error handling envelope', { err });
        });
      }
    }
  }

  async function handleEnvelope(envelope: SignalEnvelope): Promise<void> {
    if (!setup) return;

    // Sync messages (sent from another device)
    const syncSent = envelope.syncMessage?.sentMessage;
    if (syncSent) {
      // Reaction sync — drop if it's our own outbound reaction echoing back.
      // (Reactions sent from another linked device with a non-self destination
      // are also our outbound and likewise skipped — they aren't a separate
      // user event the agent needs to see.)
      if (syncSent.reaction) {
        const groupId = syncSent.groupV2?.id ?? syncSent.groupInfo?.groupId;
        const dest = (syncSent.destinationNumber ?? syncSent.destination ?? '').trim();
        const platformId = groupId ? `group:${groupId}` : dest;
        const r = syncSent.reaction;
        if (
          platformId &&
          r.emoji &&
          r.targetSentTimestamp &&
          echoCache.isEchoReaction(platformId, r.emoji, r.targetSentTimestamp)
        ) {
          log.debug('Signal: skipping echoed reaction', { platformId, emoji: r.emoji });
        }
        return;
      }
      const dest = (syncSent.destinationNumber ?? syncSent.destination ?? '').trim();
      // "Note to Self" — destination is our own account
      if (dest === config.account) {
        const text = (syncSent.message ?? '').trim();
        if (!text) return;
        const platformId = config.account;
        if (echoCache.isEcho(platformId, text)) return;
        const timestamp = syncSent.timestamp ? new Date(syncSent.timestamp).toISOString() : new Date().toISOString();

        setup.onMetadata(platformId, 'Note to Self', false);

        const msg: InboundMessage = {
          // Encode the sender into the id so a later add_reaction can recover
          // the targetAuthor. The router suffixes `:<agent-group-id>` for
          // fan-out uniqueness; sendReaction takes the second `:`-component.
          id: `${syncSent.timestamp ?? Date.now()}:${config.account}`,
          kind: 'chat',
          content: {
            text,
            sender: config.account,
            senderId: `signal:${config.account}`,
            senderName: 'Me',
            isFromMe: true,
            ...(syncSent.quote ? quoteToContent(syncSent.quote) : {}),
          },
          timestamp,
        };
        await setup.onInbound(platformId, null, msg);
        return;
      }
      // Other sync messages are our outbound — skip
      return;
    }

    const dataMessage = envelope.dataMessage;
    if (!dataMessage) return;

    // Reaction event — handle before text/voice/attachment processing so a
    // dataMessage that carries both `reaction` and `message` (rare) is treated
    // as the reaction it is, not as a text message from the same envelope.
    if (dataMessage.reaction) {
      await handleInboundReaction(envelope, dataMessage.reaction);
      return;
    }

    const rawText = (dataMessage.message ?? '').trim();
    const text = rawText ? resolveMentions(rawText, dataMessage.mentions) : '';

    const audioAttachment = dataMessage.attachments?.find((a) => a.contentType?.startsWith('audio/') && a.id);
    const imageAttachments = dataMessage.attachments?.filter((a) => a.contentType?.startsWith('image/') && a.id) ?? [];
    const hasVoice = !text && !!audioAttachment;

    if (!text && !hasVoice && imageAttachments.length === 0) return;

    const sender = (envelope.sourceNumber ?? envelope.sourceUuid ?? envelope.source ?? '').trim();
    if (!sender) return;

    const senderName = (envelope.sourceName?.trim() || sender).trim();

    // Modern Signal groups use groupV2; legacy groupInfo.groupId is the
    // pre-V2 fallback. Without the V2 read, V2-only groups appear as DMs
    // because `groupInfo` is undefined.
    const groupInfo = dataMessage.groupInfo;
    const groupId = dataMessage.groupV2?.id ?? groupInfo?.groupId;
    const isGroup = Boolean(groupId);

    const platformId = isGroup ? `group:${groupId}` : sender;

    if (text && echoCache.isEcho(platformId, text)) {
      log.debug('Signal: skipping echo', { platformId });
      return;
    }
    const timestamp = dataMessage.timestamp ? new Date(dataMessage.timestamp).toISOString() : new Date().toISOString();

    const chatName = groupInfo?.groupName ?? (isGroup ? `Group ${groupId?.slice(0, 8)}` : senderName);

    setup.onMetadata(platformId, chatName, isGroup);

    let content = text;

    // Voice attachment — try transcription if WHISPER_BIN or OPENAI_API_KEY
    // is configured; otherwise fall back to the original placeholder so
    // operators who don't want transcription get the same UX as before.
    if (hasVoice && audioAttachment?.id) {
      const attachmentPath = join(config.signalDataDir, 'attachments', audioAttachment.id);
      if (existsSync(attachmentPath)) {
        log.info('Signal: voice attachment received', {
          platformId,
          attachmentId: audioAttachment.id,
          path: attachmentPath,
        });
        const transcript = await transcribeAudioOptional(attachmentPath);
        if (transcript) {
          content = `[Voice: ${transcript}]`;
          log.info('Signal: voice transcribed', { platformId, length: transcript.length });
        } else {
          content = '[Voice Message]';
        }
      } else {
        log.warn('Signal: voice attachment file not found', {
          id: audioAttachment.id,
          path: attachmentPath,
        });
        content = '[Voice Message - file not found]';
      }
    }

    // Image attachments — emit `[Image: <path>]` lines so the agent's Read
    // tool can pick them up, and surface the structured `attachments` array
    // for consumers that prefer that shape. Without this, vision-capable
    // models never see images sent over Signal.
    const attachmentRefs: Array<{ path: string; contentType: string }> = [];
    for (const img of imageAttachments) {
      const imagePath = join(config.signalDataDir, 'attachments', img.id!);
      const imageLine = `[Image: ${imagePath}]`;
      content = content ? `${content}\n${imageLine}` : imageLine;
      attachmentRefs.push({ path: imagePath, contentType: img.contentType || 'image/jpeg' });
    }

    const msg: InboundMessage = {
      // Encode the sender so sendReaction can recover targetAuthor — see
      // syncSent path above for the full rationale.
      id: `${dataMessage.timestamp ?? Date.now()}:${sender}`,
      kind: 'chat',
      content: {
        text: content,
        sender,
        senderId: `signal:${sender}`,
        senderName,
        ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
        ...(dataMessage.quote ? quoteToContent(dataMessage.quote) : {}),
      },
      timestamp,
    };
    await setup.onInbound(platformId, null, msg);

    log.info('Signal message received', { platformId, sender: senderName });
  }

  /**
   * Translate a Signal reaction event into an InboundMessage. The structured
   * `reaction` object mirrors Chat SDK's `ReactionEvent` shape (emoji,
   * isAdded, targetMessageId) so the eventual chat-sdk-bridge implementation
   * can reuse the same `messages_in.content` schema. The synthesized `text`
   * field keeps the existing agent-runner formatter rendering something
   * meaningful with no formatter changes.
   */
  async function handleInboundReaction(envelope: SignalEnvelope, reaction: SignalReaction): Promise<void> {
    if (!setup) return;
    if (!reaction.emoji || !reaction.targetSentTimestamp) {
      log.debug('Signal: ignoring reaction with missing emoji or targetSentTimestamp', { reaction });
      return;
    }

    const sender = (envelope.sourceNumber ?? envelope.sourceUuid ?? envelope.source ?? '').trim();
    if (!sender) return;
    const senderName = (envelope.sourceName?.trim() || sender).trim();

    const dataMessage = envelope.dataMessage!;
    const groupInfo = dataMessage.groupInfo;
    const groupId = dataMessage.groupV2?.id ?? groupInfo?.groupId;
    const isGroup = Boolean(groupId);
    const platformId = isGroup ? `group:${groupId}` : sender;

    if (echoCache.isEchoReaction(platformId, reaction.emoji, reaction.targetSentTimestamp)) {
      log.debug('Signal: skipping echoed reaction', { platformId, emoji: reaction.emoji });
      return;
    }

    const isAdded = !reaction.isRemove;
    const targetAuthor =
      reaction.targetAuthor || reaction.targetAuthorUuid || reaction.targetAuthorNumber || '';
    const targetMessageId = `${reaction.targetSentTimestamp}:${targetAuthor}`;
    const marker = isAdded ? '➕' : '➖';
    const text = `[reacted ${marker} ${reaction.emoji} to message]`;
    const timestamp = dataMessage.timestamp
      ? new Date(dataMessage.timestamp).toISOString()
      : new Date().toISOString();

    const chatName = groupInfo?.groupName ?? (isGroup ? `Group ${groupId?.slice(0, 8)}` : senderName);
    setup.onMetadata(platformId, chatName, isGroup);

    const msg: InboundMessage = {
      // Encode sender so reactions stay reactable — same rationale as the
      // text path. The reaction's own timestamp keeps the row distinct from
      // the original message it reacted to.
      id: `${dataMessage.timestamp ?? Date.now()}:${sender}`,
      kind: 'chat',
      content: {
        text,
        sender,
        senderId: `signal:${sender}`,
        senderName,
        reaction: {
          emoji: reaction.emoji,
          isAdded,
          targetMessageId,
        },
      },
      timestamp,
    };
    await setup.onInbound(platformId, null, msg);
    log.info('Signal reaction received', {
      platformId,
      sender: senderName,
      emoji: reaction.emoji,
      isAdded,
    });
  }

  /**
   * Build the `replyTo` object the agent-runner formatter expects (see
   * `container/agent-runner/src/formatter.ts:formatReplyContext`). The
   * formatter requires both `sender` and `text` to render the
   * `<quoted_message>` block; absent either, it omits the block entirely.
   *
   * The previous shape (`replyToSenderName` / `replyToMessageContent` /
   * `replyToMessageId` flat keys) did not match the formatter contract, so
   * quote-reply context was silently dropped end-to-end.
   */
  function quoteToContent(quote: SignalQuote): Record<string, unknown> {
    const sender = quote.authorName || quote.authorNumber || quote.author || quote.authorUuid || 'someone';
    const text = quote.text || '';
    return {
      replyTo: {
        id: quote.id ? String(quote.id) : undefined,
        sender,
        text,
      },
    };
  }

  // -- send helpers --

  /**
   * Send `text` as one or more Signal messages, returning the timestamp of
   * the first chunk's send response (so callers can record it as the
   * platform message id). The first chunk is the head of the reply, which
   * is what later edits / reactions / replies want to target.
   */
  async function sendText(platformId: string, text: string): Promise<number | null> {
    if (!connected || !tcp) return null;

    echoCache.remember(platformId, text);

    const MAX_CHUNK = 4000;
    const chunks = text.length <= MAX_CHUNK ? [text] : chunkText(text, MAX_CHUNK);

    let firstTimestamp: number | null = null;

    for (const chunk of chunks) {
      try {
        const { text: plainText, textStyles } = parseSignalStyles(chunk);
        const params: Record<string, unknown> = { message: plainText };
        if (config.account) params.account = config.account;
        if (textStyles.length > 0) {
          params.textStyle = textStyles.map((s) => `${s.start}:${s.length}:${s.style}`);
        }

        if (platformId.startsWith('group:')) {
          params.groupId = platformId.slice('group:'.length);
        } else {
          params.recipient = [platformId];
        }

        let result: unknown;
        try {
          result = await tcp.rpc('send', params);
        } catch (styledErr) {
          if (textStyles.length > 0) {
            log.debug('Signal: textStyle rejected, retrying with markup');
            delete params.textStyle;
            params.message = chunk;
            result = await tcp.rpc('send', params);
          } else {
            throw styledErr;
          }
        }
        if (firstTimestamp === null && result && typeof result === 'object') {
          const ts = (result as Record<string, unknown>).timestamp;
          if (typeof ts === 'number') firstTimestamp = ts;
        }
      } catch (err) {
        log.error('Signal: send failed', { platformId, err });
      }
    }

    log.info('Signal message sent', { platformId, length: text.length });
    return firstTimestamp;
  }

  /**
   * Send one or more file attachments via signal-cli's `send` JSON-RPC, which
   * accepts an `attachments` array of host filesystem paths. The OutboundFile
   * Buffer is materialized to an OS temp file so signal-cli can read it, then
   * removed in the finally block.
   *
   * Caption text, if any, is sent first via `sendText` (which handles chunking
   * + textStyles) — keeps this function single-purpose and avoids a long
   * caption colliding with signal-cli's per-message size limits.
   */
  async function sendAttachments(platformId: string, files: { filename: string; data: Buffer }[]): Promise<void> {
    if (!connected || !tcp) return;
    if (files.length === 0) return;

    const tempPaths: string[] = [];
    for (const file of files) {
      const safeName = file.filename.replace(/[/\\\0]/g, '_');
      const tempPath = join(tmpdir(), `signal-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`);
      writeFileSync(tempPath, file.data);
      tempPaths.push(tempPath);
    }

    try {
      const params: Record<string, unknown> = { attachments: tempPaths };
      if (config.account) params.account = config.account;
      if (platformId.startsWith('group:')) {
        params.groupId = platformId.slice('group:'.length);
      } else {
        params.recipient = [platformId];
      }
      await tcp.rpc('send', params);
      log.info('Signal attachments sent', { platformId, count: files.length, filenames: files.map((f) => f.filename) });
    } catch (err) {
      log.error('Signal: attachment send failed', { platformId, count: files.length, err });
    } finally {
      for (const p of tempPaths) {
        try {
          unlinkSync(p);
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  }

  /**
   * Send a reaction via signal-cli's `sendReaction` JSON-RPC. The encoded
   * `messageId` carries both the target timestamp and the target author —
   * see the inbound `id` and outbound `deliver()` return value, both of which
   * use the same `<timestamp>:<authorIdent>` format. Legacy ids without a
   * suffix default targetAuthor to our own account (covers reactions on the
   * agent's own outbound from before this encoding was introduced).
   */
  async function sendReaction(
    platformId: string,
    encodedMessageId: string,
    rawEmoji: string,
    remove: boolean,
  ): Promise<string | undefined> {
    if (!connected || !tcp) return undefined;

    // messageId encoding (see handleEnvelope and deliver):
    //   - `<ts>`                      — legacy / no-author fallback
    //   - `<ts>:<author>`             — outbound reply (deliver())
    //   - `<ts>:<author>:<ag-id>`     — inbound message after the router's
    //                                   per-agent fan-out suffix in router.ts
    //                                   `messageIdForAgent`
    // Author is always the SECOND `:`-segment when present; trailing
    // segments (e.g. agent-group id) are dropped. Without an author segment,
    // fall back to our own account so reactions on the agent's own outbound
    // still resolve.
    const parts = encodedMessageId.split(':');
    const tsRaw = parts[0];
    const targetAuthor = parts[1] && parts[1].length > 0 ? parts[1] : config.account;
    const targetTimestamp = Number(tsRaw);
    if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
      log.error('Signal: sendReaction got unparseable messageId', { encodedMessageId });
      return undefined;
    }
    if (!targetAuthor) {
      log.error('Signal: sendReaction missing targetAuthor', { encodedMessageId });
      return undefined;
    }

    const emoji = emojiToUnicode(rawEmoji);

    const params: Record<string, unknown> = {
      emoji,
      targetAuthor,
      targetTimestamp,
    };
    if (config.account) params.account = config.account;
    if (remove) params.remove = true;
    if (platformId.startsWith('group:')) {
      params.groupId = platformId.slice('group:'.length);
    } else {
      params.recipient = [platformId];
    }

    echoCache.rememberReaction(platformId, emoji, targetTimestamp);

    try {
      const result = await tcp.rpc('sendReaction', params);
      log.info('Signal reaction sent', { platformId, emoji, targetTimestamp, remove });
      if (result && typeof result === 'object') {
        const ts = (result as Record<string, unknown>).timestamp;
        if (typeof ts === 'number') return `${ts}:${config.account}`;
      }
      return undefined;
    } catch (err) {
      log.error('Signal: sendReaction failed', { platformId, emoji, targetTimestamp, err });
      return undefined;
    }
  }

  async function waitForDaemon(): Promise<boolean> {
    const maxWait = 30_000;
    const pollInterval = 1000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      if (daemon?.isExited()) return false;
      const ok = await signalTcpCheck(config.tcpHost, config.tcpPort);
      if (ok) return true;
      await sleep(pollInterval);
    }
    return false;
  }

  // -- adapter --

  const adapter: ChannelAdapter = {
    name: 'signal',
    channelType: 'signal',
    supportsThreads: false,

    async setup(cfg: ChannelSetup): Promise<void> {
      setup = cfg;

      if (config.manageDaemon) {
        daemon = spawnSignalDaemon(config.cliPath, config.account, config.tcpHost, config.tcpPort);
        const ready = await waitForDaemon();
        if (!ready) {
          daemon.stop();
          throw new Error('Signal daemon failed to start. Is signal-cli installed and your account linked?');
        }
      } else {
        const ok = await signalTcpCheck(config.tcpHost, config.tcpPort);
        if (!ok) {
          const err = new Error(
            `Signal daemon not reachable at ${config.tcpHost}:${config.tcpPort}. Start it manually or set SIGNAL_MANAGE_DAEMON=true`,
          );
          (err as any).name = 'NetworkError';
          throw err;
        }
      }

      tcp = new SignalTcpClient(config.tcpHost, config.tcpPort);
      await tcp.connect({
        onNotification: handleNotification,
        // Signal the adapter that the daemon dropped us. No auto-reconnect yet
        // — subsequent deliver/setTyping calls short-circuit on `connected`
        // and log rather than throw into the retry loop. Operators see this in
        // logs/nanoclaw.log and can restart the service.
        onClose: () => {
          if (!connected) return;
          connected = false;
          log.warn('Signal channel lost TCP connection to signal-cli daemon', {
            account: config.account,
            host: config.tcpHost,
            port: config.tcpPort,
          });
        },
      });

      try {
        await tcp.rpc('updateProfile', {
          name: 'NanoClaw',
          account: config.account,
        });
      } catch {
        log.debug('Signal: could not set profile name');
      }

      try {
        await tcp.rpc('updateConfiguration', {
          typingIndicators: true,
          account: config.account,
        });
      } catch {
        log.debug('Signal: could not enable typing indicators');
      }

      connected = true;
      log.info('Signal channel connected', {
        account: config.account,
        host: config.tcpHost,
        port: config.tcpPort,
      });
    },

    async teardown(): Promise<void> {
      connected = false;
      tcp?.close();
      tcp = null;
      if (daemon && config.manageDaemon) {
        daemon.stop();
        await daemon.exited;
      }
      daemon = null;
      log.info('Signal channel disconnected');
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const content = message.content as Record<string, unknown> | string | undefined;

      // Reaction operation — mirrors the chat-sdk-bridge contour so an agent
      // calling `add_reaction` works the same on Signal as on Discord/Slack.
      if (
        content &&
        typeof content === 'object' &&
        content.operation === 'reaction' &&
        typeof content.messageId === 'string' &&
        typeof content.emoji === 'string'
      ) {
        return await sendReaction(platformId, content.messageId, content.emoji, content.remove === true);
      }

      let text: string | null = null;
      if (typeof content === 'string') {
        text = content;
      } else if (content && typeof content === 'object' && typeof content.text === 'string') {
        text = content.text;
      }

      const files = message.files ?? [];

      // Send accompanying text first so it lands above the attachment(s) in
      // the recipient's chat. Both branches no-op cleanly if their input is
      // empty, so any combination of (text, files) works.
      let sentTimestamp: number | null = null;
      if (text) sentTimestamp = await sendText(platformId, text);
      if (files.length > 0) await sendAttachments(platformId, files);
      // Return the head-of-reply id so the host can record it in
      // delivered.platform_message_id. The encoded form `<ts>:<account>`
      // round-trips through `add_reaction` / future edit support to the
      // sendReaction helper, which decodes it back into targetTimestamp +
      // targetAuthor.
      if (sentTimestamp !== null) return `${sentTimestamp}:${config.account}`;
      return undefined;
    },

    async setTyping(platformId: string, _threadId: string | null): Promise<void> {
      if (!connected || !tcp) return;
      if (platformId.startsWith('group:')) return;

      try {
        const params: Record<string, unknown> = { recipient: [platformId] };
        if (config.account) params.account = config.account;
        await tcp.rpc('sendTyping', params);
      } catch (err) {
        log.debug('Signal: typing indicator failed', { platformId, err });
      }
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

const DEFAULT_TCP_HOST = '127.0.0.1';
const DEFAULT_TCP_PORT = 7583;

registerChannelAdapter('signal', {
  factory: () => {
    const envVars = readEnvFile([
      'SIGNAL_ACCOUNT',
      'SIGNAL_TCP_HOST',
      'SIGNAL_TCP_PORT',
      'SIGNAL_CLI_PATH',
      'SIGNAL_MANAGE_DAEMON',
      'SIGNAL_DATA_DIR',
    ]);

    const account = process.env.SIGNAL_ACCOUNT || envVars.SIGNAL_ACCOUNT || '';
    if (!account) {
      log.debug('Signal: SIGNAL_ACCOUNT not set, skipping channel');
      return null;
    }

    const cliPath = process.env.SIGNAL_CLI_PATH || envVars.SIGNAL_CLI_PATH || 'signal-cli';
    const tcpHost = process.env.SIGNAL_TCP_HOST || envVars.SIGNAL_TCP_HOST || DEFAULT_TCP_HOST;
    const tcpPort = parseInt(process.env.SIGNAL_TCP_PORT || envVars.SIGNAL_TCP_PORT || String(DEFAULT_TCP_PORT), 10);
    const manageDaemon = (process.env.SIGNAL_MANAGE_DAEMON || envVars.SIGNAL_MANAGE_DAEMON || 'true') === 'true';

    const signalDataDir =
      process.env.SIGNAL_DATA_DIR || envVars.SIGNAL_DATA_DIR || join(homedir(), '.local', 'share', 'signal-cli');

    // Only check for `signal-cli` on PATH when the operator left cliPath at
    // the default AND asked us to manage the daemon. A custom absolute path
    // is treated as an explicit promise and spawn will surface its own ENOENT.
    if (manageDaemon && cliPath === 'signal-cli') {
      try {
        execFileSync('which', ['signal-cli'], { stdio: 'ignore' });
      } catch {
        log.debug('Signal: signal-cli binary not found, skipping channel');
        return null;
      }
    }

    return createSignalAdapter({
      cliPath,
      account,
      tcpHost,
      tcpPort,
      manageDaemon,
      signalDataDir,
    });
  },
});
