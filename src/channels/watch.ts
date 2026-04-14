// Watch channel — HTTP server for the NanoClaw T-Watch S3 firmware.
//
// Contract (driven by the firmware in ~/projects/nanoclaw-watch/src/network.cpp):
//
//   POST /api/watch/message
//     Headers:
//       X-Watch-Token: <shared secret>   (required)
//       X-Device-Id:   <device id>       (audio only — text uses JSON body field)
//       Content-Type:  application/json  -> JSON body { text, device_id }
//                   or audio/wav         -> raw WAV bytes
//     Response: 200 { reply: string }  — watch blocks for up to ~15s
//
//   GET /api/watch/poll?device_id=<id>
//     Headers:
//       X-Watch-Token: <shared secret>
//     Response: 200 { has_new: bool, reply?: string }
//
// Fast path vs slow path:
//   The firmware's HTTP client times out at HTTP_TIMEOUT_MS = 15000. We race
//   the agent's first text output against a 12-second timer. If the agent
//   replies in time, it goes back in the POST response synchronously. If it
//   doesn't, we return `{ reply: "" }` and the text eventually lands in the
//   poll queue, which the watch picks up on its next 60-second poll cycle.

import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  GROUPS_DIR,
  STORE_DIR,
  WATCH_AUTH_TOKEN,
  WATCH_GROUP_FOLDER,
  WATCH_HTTP_BIND,
  WATCH_HTTP_PORT,
  WATCH_JID,
  WATCH_SYNC_TIMEOUT_MS,
} from '../config.js';
import { getRegisteredGroup, setRegisteredGroup } from '../db.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import {
  Channel,
  IpcMedia,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface WatchChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface PendingResolver {
  resolve: (text: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface QueuedReply {
  ts: number;
  text: string;
}

export interface WatchNotification {
  id: string;
  type: 'email' | 'signal';
  from: string;
  preview: string;
  full_text: string;
  timestamp: string;
}

const WATCH_UPLOADS_DIR = path.join(STORE_DIR, 'watch-uploads');
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB cap on POST body (5s WAV is ~160KB)
const POLL_QUEUE_MAX = 20;
const NOTIF_QUEUE_MAX = 50;
const NOTIF_PREVIEW_LEN = 60;
const NOTIF_MAX_AGE_MS = 3600_000; // drop notifications older than 1 hour

export class WatchChannel implements Channel {
  public readonly name = 'watch';

  private readonly opts: WatchChannelOpts;
  private readonly jid: string;
  private readonly groupFolder: string;
  private readonly token: string;
  private readonly port: number;
  private readonly bind: string;
  private readonly syncTimeoutMs: number;

  private server?: http.Server;
  private pendingResolvers: PendingResolver[] = [];
  private pollQueue: QueuedReply[] = [];
  private notificationQueue: WatchNotification[] = [];

  // Optional Signal mirror — set by index.ts after channels are constructed.
  // When wired, every watch exchange is also forwarded to a Signal JID so
  // Scott can read the conversation on his phone.
  private mirrorChannel: Channel | null = null;
  private mirrorJid: string | null = null;

  constructor(opts: WatchChannelOpts) {
    this.opts = opts;
    this.jid = WATCH_JID;
    this.groupFolder = WATCH_GROUP_FOLDER;
    this.token = WATCH_AUTH_TOKEN;
    this.port = WATCH_HTTP_PORT;
    this.bind = WATCH_HTTP_BIND;
    this.syncTimeoutMs = WATCH_SYNC_TIMEOUT_MS;
  }

  // Wire a downstream channel + jid that watch conversations should be
  // mirrored to. Called from index.ts after both channels are constructed.
  setMirrorTarget(channel: Channel, jid: string): void {
    this.mirrorChannel = channel;
    this.mirrorJid = jid;
    logger.info(
      { mirrorChannel: channel.name, mirrorJid: jid },
      'watch: signal mirror enabled',
    );
  }

  // Best-effort fire-and-forget mirror send. Failures are logged but never
  // bubble up — a broken mirror must not break the watch loop.
  private mirrorSend(text: string): void {
    if (!this.mirrorChannel || !this.mirrorJid) return;
    this.mirrorChannel.sendMessage(this.mirrorJid, text).catch((err) => {
      logger.warn({ err }, 'watch: signal mirror send failed');
    });
  }

  async connect(): Promise<void> {
    fs.mkdirSync(WATCH_UPLOADS_DIR, { recursive: true });
    this.ensureRegisteredGroup();

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        logger.error({ err }, 'watch: unhandled HTTP handler error');
        if (!res.headersSent) this.sendJson(res, 500, { error: 'internal' });
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        this.server?.removeListener('error', onError);
        reject(err);
      };
      this.server!.once('error', onError);
      this.server!.listen(this.port, this.bind, () => {
        this.server!.removeListener('error', onError);
        logger.info(
          { port: this.port, bind: this.bind, jid: this.jid },
          'watch: HTTP server listening',
        );
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    for (const r of this.pendingResolvers) {
      clearTimeout(r.timer);
      r.resolve('');
    }
    this.pendingResolvers = [];
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = undefined;
    }
  }

  isConnected(): boolean {
    return !!this.server?.listening;
  }

  ownsJid(jid: string): boolean {
    return jid === this.jid;
  }

  // Normalize a reply for the T-Watch's LVGL font set. The default
  // Montserrat fonts shipped with LVGL only contain ASCII glyphs, so any
  // smart-quote, em-dash, ellipsis, bullet, etc. that Jorgenclaw uses in
  // her prose renders as a white "missing glyph" rectangle on the watch.
  // Map the most common Unicode punctuation back to ASCII equivalents,
  // then strip anything still outside printable ASCII as a safety net.
  private normalizeForWatch(text: string): string {
    return (
      text
        .replace(/[\u2014\u2013]/g, '-') // em-dash, en-dash
        .replace(/[\u201C\u201D]/g, '"') // smart double quotes
        .replace(/[\u2018\u2019]/g, "'") // smart single quotes
        .replace(/\u2026/g, '...') // ellipsis
        .replace(/\u2022/g, '*') // bullet
        .replace(/\u2192/g, '->') // right arrow
        .replace(/\u00A0/g, ' ') // non-breaking space
        // Anything still non-ASCII (emoji, currency, accented chars) becomes
        // empty rather than a white box.
        .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '')
    );
  }

  async sendMessage(
    jid: string,
    text: string,
    _media?: IpcMedia,
  ): Promise<void> {
    if (jid !== this.jid || !text) {
      logger.debug(
        { jid, textLen: text?.length ?? 0 },
        'watch: sendMessage skipped (wrong jid or empty text)',
      );
      return;
    }
    // Mirror the agent's reply to Signal BEFORE we ASCII-normalize for the
    // watch's font. Signal supports full Unicode, so the mirrored copy keeps
    // the em-dashes, smart quotes, etc.
    this.mirrorSend(`↳ ${text}`);
    text = this.normalizeForWatch(text);

    // Fast path: fulfill the oldest pending synchronous request
    const resolver = this.pendingResolvers.shift();
    if (resolver) {
      clearTimeout(resolver.timer);
      logger.info(
        { textLen: text.length },
        'watch: reply delivered via fast path',
      );
      resolver.resolve(text);
      return;
    }

    // Slow path: push onto the ring buffer the poll endpoint drains
    this.pollQueue.push({ ts: Date.now(), text });
    while (this.pollQueue.length > POLL_QUEUE_MAX) this.pollQueue.shift();
    logger.info(
      { textLen: text.length, queueSize: this.pollQueue.length },
      'watch: reply queued for poll endpoint',
    );
  }

  // -----------------------------------------------------------------------
  // Proactive notifications — pushed by external sources, polled by watch
  // -----------------------------------------------------------------------

  /**
   * Push a notification for the watch to pick up on its next poll.
   * Called from index.ts when a Signal message or email arrives from a
   * known contact. The watch polls GET /api/watch/notifications?since=...
   * to fetch new items.
   */
  addNotification(
    type: 'email' | 'signal',
    from: string,
    fullText: string,
  ): void {
    const normalized = this.normalizeForWatch(fullText);
    const preview =
      normalized.length > NOTIF_PREVIEW_LEN
        ? normalized.slice(0, NOTIF_PREVIEW_LEN - 3) + '...'
        : normalized;
    const notif: WatchNotification = {
      id: `notif-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      type,
      from: this.normalizeForWatch(from),
      preview,
      full_text: normalized.slice(0, 1024),
      timestamp: new Date().toISOString(),
    };
    this.notificationQueue.push(notif);
    // Trim old items.
    const cutoff = Date.now() - NOTIF_MAX_AGE_MS;
    this.notificationQueue = this.notificationQueue.filter(
      (n) => new Date(n.timestamp).getTime() > cutoff,
    );
    while (this.notificationQueue.length > NOTIF_QUEUE_MAX)
      this.notificationQueue.shift();
    logger.info(
      {
        type,
        from,
        previewLen: preview.length,
        queueSize: this.notificationQueue.length,
      },
      'watch: notification queued',
    );
  }

  private async handleNotifyPost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const body = await this.readBody(req);
      const parsed = JSON.parse(body.toString('utf-8')) as {
        type?: string;
        from?: string;
        text?: string;
      };
      const type = (parsed.type === 'email' ? 'email' : 'signal') as
        | 'email'
        | 'signal';
      const from = parsed.from || 'System';
      const text = parsed.text || '';
      if (!text) {
        this.sendJson(res, 400, { error: 'missing text field' });
        return;
      }
      this.addNotification(type, from, text);
      this.sendJson(res, 200, { ok: true });
    } catch {
      this.sendJson(res, 400, { error: 'bad request' });
    }
  }

  private handleNotifications(url: URL, res: http.ServerResponse): void {
    const since = url.searchParams.get('since') || '1970-01-01T00:00:00.000Z';
    const sinceMs = new Date(since).getTime();
    const items = this.notificationQueue.filter(
      (n) => new Date(n.timestamp).getTime() > sinceMs,
    );
    this.sendJson(res, 200, { notifications: items });
  }

  // -----------------------------------------------------------------------
  // HTTP request handling
  // -----------------------------------------------------------------------

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || 'localhost'}`,
    );

    if (!this.checkAuth(req)) {
      this.sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    // Agent-pushed notifications: POST { type, from, text } to buzz the watch.
    // Called from the container via curl or the agent's tools when something
    // is worth Scott's attention (email, calendar reminder, task completion).
    if (req.method === 'POST' && url.pathname === '/api/watch/notify') {
      await this.handleNotifyPost(req, res);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/watch/message') {
      await this.handleMessagePost(req, res);
      return;
    }

    // Voice memo — tap + speak + send, the host transcribes and files
    // the text to a daily memo without running the agent. Response is
    // just a terse confirmation ("Saved (42 chars)"). The watch hands
    // this off via the "Capture" grid tile.
    if (req.method === 'POST' && url.pathname === '/api/watch/memo') {
      await this.handleMemoPost(req, res);
      return;
    }

    // Voice reminder — tap + "remind me in 10 minutes to call mom",
    // host parses the time phrase and schedules a notification that
    // fires via addNotification() at the parsed time. Response is a
    // confirmation with the parsed time, or a "could not parse" error.
    if (req.method === 'POST' && url.pathname === '/api/watch/reminder') {
      await this.handleReminderPost(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/watch/poll') {
      this.handlePoll(res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/watch/notifications') {
      this.handleNotifications(url, res);
      return;
    }

    this.sendJson(res, 404, { error: 'not found' });
  }

  // -----------------------------------------------------------------------
  // Voice memo — /api/watch/memo
  // -----------------------------------------------------------------------

  // Appends a transcribed voice memo to groups/<folder>/memos/YYYY-MM-DD.md.
  // No agent round-trip — the intent is "capture, don't chat." Returns a
  // terse confirmation so the watch can show "Saved" without waiting for
  // a long response.
  private async handleMemoPost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (!ct.includes('audio/')) {
        this.sendJson(res, 415, { error: `unsupported Content-Type: ${ct}` });
        return;
      }
      const body = await this.readBody(req);
      if (body.length === 0) {
        this.sendJson(res, 400, { error: 'empty audio body' });
        return;
      }
      const cleaned = await this.transcribeAndClean(body);
      if (!cleaned) {
        this.sendJson(res, 200, { reply: '(no speech detected)' });
        return;
      }

      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
      const timeStr = now.toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
      const memosDir = path.join(GROUPS_DIR, this.groupFolder, 'memos');
      fs.mkdirSync(memosDir, { recursive: true });
      const memoFile = path.join(memosDir, `${dateStr}.md`);

      // Create the daily file with a date heading if it doesn't exist,
      // then append each memo as a timestamped sub-entry.
      if (!fs.existsSync(memoFile)) {
        const header = `# Memos — ${dateStr}\n\n`;
        fs.writeFileSync(memoFile, header);
      }
      const entry = `## ${timeStr}\n\n${cleaned}\n\n`;
      fs.appendFileSync(memoFile, entry);

      logger.info(
        { file: memoFile, len: cleaned.length, preview: cleaned.slice(0, 60) },
        'watch: memo saved',
      );

      // Mirror to Signal so Scott's phone conversation thread shows
      // what was captured — helps him scan recent memos without
      // opening the daily file.
      this.mirrorSend(`[Memo] ${cleaned}`);

      // Response must fit the watch's response screen without scrolling
      // too far. Keep it short: confirmation + byte/char count + the
      // memo itself echoed back so Scott can verify he was heard right.
      const reply = `Saved (${cleaned.length} chars)\n\n${cleaned}`;
      this.sendJson(res, 200, { reply });
    } catch (err) {
      logger.warn({ err }, 'watch: memo error');
      if (!res.headersSent) this.sendJson(res, 500, { error: 'internal' });
    }
  }

  // -----------------------------------------------------------------------
  // Voice reminder — /api/watch/reminder
  // -----------------------------------------------------------------------

  // The watch captures audio for the Remind tile and POSTs it here. The
  // host transcribes, wraps the transcript in a short system framing, and
  // routes it through injectAndAwaitReply() exactly like a normal watch
  // message. Jorgenclaw (the agent) parses the natural-language time using
  // Claude's own language understanding, calls schedule_task to create a
  // one-shot task at the parsed time, and replies with a short confirmation
  // that the watch shows on its response screen.
  //
  // Why this is better than the old on-device regex parser (rewritten
  // 2026-04-14): regex parsers only handle phrasings you thought of ahead
  // of time and every missed phrasing is a silent user-facing failure.
  // Claude parses natural language correctly on the first try —
  // "tomorrow at noon", "in an hour and a half", "at 3:30 in the afternoon",
  // "half past eight" all just work. Cost is one agent turn per reminder,
  // which is an acceptable tradeoff for a rarely-used feature that used
  // to fail loudly on anything outside the two documented phrasings.
  private async handleReminderPost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (!ct.includes('audio/')) {
        this.sendJson(res, 415, { error: `unsupported Content-Type: ${ct}` });
        return;
      }
      const body = await this.readBody(req);
      if (body.length === 0) {
        this.sendJson(res, 400, { error: 'empty audio body' });
        return;
      }
      const cleaned = await this.transcribeAndClean(body);
      if (!cleaned) {
        this.sendJson(res, 200, { reply: '(no speech detected)' });
        return;
      }

      const deviceId =
        (req.headers['x-device-id'] as string | undefined) || 'unknown';

      logger.info(
        { deviceId, preview: cleaned.slice(0, 100) },
        'watch: reminder request — routing to agent',
      );

      // Mirror the user side of the exchange to Signal so Scott's phone
      // thread shows what was captured.
      this.mirrorSend(`⌚ [Watch reminder] Scott: ${cleaned}`);

      // System framing: kept short to minimize agent context noise. The
      // agent is expected to (a) parse the time from the quoted transcript,
      // (b) call schedule_task with schedule_type "once", and (c) reply
      // with a brief confirmation that fits on the watch's response screen.
      const framed =
        `SYSTEM: Scott tapped the 'Remind' tile on his watch and said: ` +
        `"${cleaned}". Parse the time from his statement and schedule a ` +
        `one-shot task for that exact time using the schedule_task tool ` +
        `with schedule_type "once". The scheduled task's prompt should ` +
        `send Scott a Signal reminder of the action. Reply with only a ` +
        `short confirmation, e.g. "Reminder set for 3:45 PM: call Mom".`;

      const reply = await this.injectAndAwaitReply(framed, deviceId);
      this.sendJson(res, 200, { reply });
    } catch (err) {
      logger.warn({ err }, 'watch: reminder error');
      if (!res.headersSent) this.sendJson(res, 500, { error: 'internal' });
    }
  }

  // Shared: transcribe a WAV body and strip Whisper's non-speech annotations.
  // Returns the cleaned transcript, or empty string if there was no real
  // speech. Extracted so memo + reminder handlers don't duplicate the
  // cleanup regex from handleMessagePost.
  private async transcribeAndClean(body: Buffer): Promise<string> {
    const transcribed = await this.transcribe(body);
    if (!transcribed) return '';
    const cleaned = transcribed
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned;
  }

  private async handleMessagePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    const deviceId =
      (req.headers['x-device-id'] as string | undefined) || 'unknown';

    let text: string;
    try {
      if (ct.includes('application/json')) {
        const body = await this.readBody(req);
        const parsed = JSON.parse(body.toString('utf-8')) as {
          text?: unknown;
        };
        if (typeof parsed.text !== 'string' || !parsed.text.trim()) {
          this.sendJson(res, 400, { error: 'missing text field' });
          return;
        }
        text = parsed.text.trim();
      } else if (ct.includes('audio/')) {
        const body = await this.readBody(req);
        if (body.length === 0) {
          this.sendJson(res, 400, { error: 'empty audio body' });
          return;
        }
        const transcribed = await this.transcribe(body);
        if (!transcribed) {
          this.sendJson(res, 200, { reply: '(could not transcribe audio)' });
          return;
        }
        // Strip Whisper's non-speech annotations. Whisper describes ambient
        // sounds in parentheses or brackets — "(keyboard clicking)",
        // "[click]", "(chair squeaking)". If what remains is empty, the
        // capture was pure ambient noise and should NOT reach the agent.
        // If some speech is mixed in, strip the noise labels and forward
        // only the actual words.
        const cleaned = transcribed
          .replace(/\([^)]*\)/g, ' ')
          .replace(/\[[^\]]*\]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!cleaned) {
          logger.info(
            { deviceId, original: transcribed.slice(0, 100) },
            'watch: dropped non-speech capture (Whisper annotation only)',
          );
          this.sendJson(res, 200, { reply: '(no speech detected)' });
          return;
        }
        text = cleaned;
      } else {
        this.sendJson(res, 415, { error: `unsupported Content-Type: ${ct}` });
        return;
      }
    } catch (err) {
      logger.warn({ err, ct }, 'watch: bad inbound body');
      if (!res.headersSent) this.sendJson(res, 400, { error: 'bad request' });
      return;
    }

    logger.info(
      { deviceId, textLen: text.length, preview: text.slice(0, 100) },
      'watch: inbound message',
    );

    // Mirror the user side of the exchange to Signal (no-op if not wired).
    // Done after the noise filter so dropped captures aren't mirrored, and
    // before injectAndAwaitReply so it fires immediately rather than after
    // the agent finishes thinking.
    this.mirrorSend(`⌚ [Watch] Scott: ${text}`);

    const reply = await this.injectAndAwaitReply(text, deviceId);
    this.sendJson(res, 200, { reply });
  }

  private handlePoll(res: http.ServerResponse): void {
    const next = this.pollQueue.shift();
    if (next) {
      this.sendJson(res, 200, { has_new: true, reply: next.text });
    } else {
      this.sendJson(res, 200, { has_new: false });
    }
  }

  // -----------------------------------------------------------------------
  // Message injection + sync/slow path
  // -----------------------------------------------------------------------

  private injectAndAwaitReply(text: string, deviceId: string): Promise<string> {
    return new Promise<string>((resolve) => {
      // Register a pending resolver BEFORE injecting — eliminates the race
      // where the agent's first sendMessage fires before we're listening.
      const timer = setTimeout(() => {
        const idx = this.pendingResolvers.findIndex(
          (r) => r.resolve === wrappedResolve,
        );
        if (idx >= 0) this.pendingResolvers.splice(idx, 1);
        logger.info(
          { textLen: text.length },
          'watch: sync reply timeout — reply will go through poll queue',
        );
        resolve('');
      }, this.syncTimeoutMs);

      const wrappedResolve = (replyText: string) => {
        clearTimeout(timer);
        resolve(replyText);
      };

      this.pendingResolvers.push({ resolve: wrappedResolve, timer });

      const now = new Date();
      const msg: NewMessage = {
        id: `watch-${now.getTime()}-${crypto.randomBytes(4).toString('hex')}`,
        chat_jid: this.jid,
        sender: this.jid,
        sender_name: 'Scott (watch)',
        content: text,
        timestamp: now.toISOString(),
        is_from_me: true,
      };

      this.opts.onChatMetadata(
        this.jid,
        now.toISOString(),
        `NanoClaw Watch (${deviceId})`,
        this.name,
        false,
      );
      this.opts.onMessage(this.jid, msg);
    });
  }

  private async transcribe(wavBuf: Buffer): Promise<string> {
    const fname = `watch-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`;
    const fpath = path.join(WATCH_UPLOADS_DIR, fname);
    fs.writeFileSync(fpath, wavBuf);
    try {
      const text = await transcribeAudio(fpath);
      return text.trim();
    } catch (err) {
      logger.warn({ err }, 'watch: transcription failed');
      return '';
    } finally {
      fs.unlink(fpath, () => {});
    }
  }

  // -----------------------------------------------------------------------
  // Bootstrap helpers
  // -----------------------------------------------------------------------

  private ensureRegisteredGroup(): void {
    if (getRegisteredGroup(this.jid)) return;

    const group: RegisteredGroup = {
      name: `NanoClaw Watch`,
      folder: this.groupFolder,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    };
    setRegisteredGroup(this.jid, group);

    // Mutate the live in-memory map so index.ts picks it up without a restart
    const liveGroups = this.opts.registeredGroups();
    liveGroups[this.jid] = group;

    logger.info(
      { jid: this.jid, folder: this.groupFolder },
      'watch: auto-registered group',
    );
  }

  // -----------------------------------------------------------------------
  // Low-level helpers
  // -----------------------------------------------------------------------

  private checkAuth(req: http.IncomingMessage): boolean {
    const provided = req.headers['x-watch-token'];
    if (typeof provided !== 'string' || !this.token) return false;
    const a = Buffer.from(provided, 'utf-8');
    const b = Buffer.from(this.token, 'utf-8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  private async readBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_UPLOAD_BYTES) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  private sendJson(
    res: http.ServerResponse,
    status: number,
    body: Record<string, unknown>,
  ): void {
    const buf = Buffer.from(JSON.stringify(body), 'utf-8');
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': String(buf.length),
      Connection: 'close',
    });
    res.end(buf);
  }
}
