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

const WATCH_UPLOADS_DIR = path.join(STORE_DIR, 'watch-uploads');
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB cap on POST body (5s WAV is ~160KB)
const POLL_QUEUE_MAX = 20;

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
      await new Promise<void>((resolve) =>
        this.server!.close(() => resolve()),
      );
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
    return text
      .replace(/[\u2014\u2013]/g, '-')     // em-dash, en-dash
      .replace(/[\u201C\u201D]/g, '"')     // smart double quotes
      .replace(/[\u2018\u2019]/g, "'")     // smart single quotes
      .replace(/\u2026/g, '...')           // ellipsis
      .replace(/\u2022/g, '*')             // bullet
      .replace(/\u2192/g, '->')            // right arrow
      .replace(/\u00A0/g, ' ')             // non-breaking space
      // Anything still non-ASCII (emoji, currency, accented chars) becomes
      // empty rather than a white box.
      .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
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

    if (req.method === 'POST' && url.pathname === '/api/watch/message') {
      await this.handleMessagePost(req, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/watch/poll') {
      this.handlePoll(res);
      return;
    }

    this.sendJson(res, 404, { error: 'not found' });
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

  private injectAndAwaitReply(
    text: string,
    deviceId: string,
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      // Register a pending resolver BEFORE injecting — eliminates the race
      // where the agent's first sendMessage fires before we're listening.
      const timer = setTimeout(() => {
        const idx = this.pendingResolvers.findIndex((r) => r.resolve === wrappedResolve);
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
