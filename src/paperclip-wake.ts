import crypto from 'crypto';
import http from 'http';

import { logger as defaultLogger } from './logger.js';

/**
 * Wake payload Paperclip delivers via the built-in `http` adapter.
 *
 * The adapter sends `{ agentId, runId, context, ...payloadTemplate }`.
 * `context` may contain `taskId`, `issueId`, `wakeReason`, `wakeCommentId`,
 * and whatever else Paperclip snapshotted at run-start time.
 *
 * We tolerate unknown fields — this type only names the ones we care about.
 */
export interface PaperclipWakePayload {
  agentId?: string;
  runId?: string;
  companyId?: string;
  context?: {
    taskId?: string;
    issueId?: string;
    wakeReason?: string;
    wakeCommentId?: string;
    chatJid?: string;
    groupFolder?: string;
    apiUrl?: string;
    apiKey?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type WakeLogger = Pick<
  typeof defaultLogger,
  'info' | 'warn' | 'error' | 'debug'
>;

export interface PaperclipWakeDeps {
  /** Shared secret used for bearer auth and/or HMAC verification. */
  secret: string;
  /** Accept signatures whose timestamp is within ± this many seconds of now. */
  replayWindowSeconds?: number;
  /** Callback for a verified wake. Errors are logged and swallowed. */
  onWake: (
    payload: PaperclipWakePayload,
    rawBody: string,
  ) => void | Promise<void>;
  /** Optional logger override (tests inject fakes). */
  logger?: WakeLogger;
  /** Optional clock override (tests pin the wall clock). Returns ms. */
  now?: () => number;
  /** Max body size in bytes. Requests above this are rejected with 413. */
  maxBodyBytes?: number;
}

export const WAKE_PATH = '/paperclip/wake';
const DEFAULT_REPLAY_WINDOW_SECONDS = 300;
const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MiB

interface ParsedSignature {
  timestampSeconds: number;
  mac: string;
}

/**
 * Parse a Stripe-style `X-Paperclip-Signature: t=<unix>,v1=<hex>` header.
 * Returns null if the header is missing or malformed.
 */
export function parseSignatureHeader(
  header: string | undefined,
): ParsedSignature | null {
  if (!header) return null;
  const parts = header.split(',').map((p) => p.trim());
  let t: number | null = null;
  let v1: string | null = null;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      const n = Number(value);
      if (Number.isFinite(n)) t = n;
    } else if (key === 'v1') {
      v1 = value;
    }
  }
  if (t == null || !v1) return null;
  return { timestampSeconds: t, mac: v1 };
}

/** Constant-time hex string comparison. */
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function computeSignature(
  secret: string,
  timestampSeconds: number,
  rawBody: string,
): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest('hex');
}

export type VerifyResult =
  | { ok: true; method: 'bearer' | 'hmac' }
  | { ok: false; status: 401 | 403; reason: string };

/**
 * Verify a wake request's auth. Accepts either:
 *   - `Authorization: Bearer <secret>` (exact match, constant-time)
 *   - `X-Paperclip-Signature: t=<unix>,v1=<hex>` where the HMAC-SHA256 of
 *     `${t}.${rawBody}` using `secret` equals `v1` and |now - t| is within
 *     the replay window.
 *
 * Bearer is enough today (the Paperclip built-in `http` adapter can carry a
 * static `Authorization` header via its `headers` config). HMAC support is
 * wired for the future `http`-adapter upgrade that will sign each request.
 */
export function verifyWakeAuth(params: {
  secret: string;
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  nowSeconds: number;
  replayWindowSeconds: number;
}): VerifyResult {
  const { secret, headers, rawBody, nowSeconds, replayWindowSeconds } = params;

  const authHeader = headerString(headers['authorization']);
  const sigHeader = headerString(headers['x-paperclip-signature']);

  if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
    const presented = authHeader.slice(7).trim();
    const expected = secret;
    if (
      presented.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
    ) {
      return { ok: true, method: 'bearer' };
    }
    // Fall through so a request that carries *both* headers still gets a
    // chance to pass via HMAC. If only bearer was supplied and it's wrong,
    // the HMAC branch below will fail with 401 too.
  }

  if (sigHeader) {
    const parsed = parseSignatureHeader(sigHeader);
    if (!parsed) {
      return { ok: false, status: 401, reason: 'malformed signature header' };
    }
    const skew = Math.abs(nowSeconds - parsed.timestampSeconds);
    if (skew > replayWindowSeconds) {
      return {
        ok: false,
        status: 401,
        reason: 'signature timestamp outside replay window',
      };
    }
    const expected = computeSignature(secret, parsed.timestampSeconds, rawBody);
    if (!safeEqualHex(expected, parsed.mac)) {
      return { ok: false, status: 401, reason: 'signature mismatch' };
    }
    return { ok: true, method: 'hmac' };
  }

  if (authHeader) {
    return { ok: false, status: 401, reason: 'bearer token mismatch' };
  }
  return { ok: false, status: 401, reason: 'missing auth' };
}

function headerString(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

async function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<{ ok: true; body: string } | { ok: false; status: 413 | 400 }> {
  return new Promise((resolve) => {
    let total = 0;
    let overflowed = false;
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (
      result: { ok: true; body: string } | { ok: false; status: 413 | 400 },
    ) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        // Drop bytes past the limit but keep draining so the client can
        // finish sending and still read our 413 response.
        overflowed = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (overflowed) {
        settle({ ok: false, status: 413 });
        return;
      }
      settle({ ok: true, body: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', () => {
      settle({ ok: false, status: 400 });
    });
  });
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

/**
 * Build an http handler that processes a Paperclip wake on `POST /paperclip/wake`.
 * All other method/path combinations return 404 (so operators can layer this
 * onto an existing server if they want).
 */
export function createPaperclipWakeHandler(
  deps: PaperclipWakeDeps,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const logger = deps.logger ?? defaultLogger;
  const now = deps.now ?? (() => Date.now());
  const replayWindowSeconds =
    deps.replayWindowSeconds ?? DEFAULT_REPLAY_WINDOW_SECONDS;
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const secret = deps.secret;
  if (!secret) {
    throw new Error(
      'paperclip-wake: secret is required (set PAPERCLIP_WAKE_SECRET)',
    );
  }

  return (req, res) => {
    const url = req.url || '';
    if (req.method !== 'POST' || !url.startsWith(WAKE_PATH)) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // readBody resolves once — fire-and-forget is fine here because the
    // body-reading callback terminates the response either way.
    void readBody(req, maxBodyBytes).then((result) => {
      if (!result.ok) {
        sendJson(res, result.status, {
          error: result.status === 413 ? 'payload too large' : 'bad request',
        });
        return;
      }
      const rawBody = result.body;

      const verification = verifyWakeAuth({
        secret,
        headers: req.headers,
        rawBody,
        nowSeconds: Math.floor(now() / 1000),
        replayWindowSeconds,
      });
      if (!verification.ok) {
        logger.warn(
          { reason: verification.reason },
          'paperclip-wake: auth failed',
        );
        sendJson(res, verification.status, { error: verification.reason });
        return;
      }

      let payload: PaperclipWakePayload;
      try {
        payload = JSON.parse(rawBody) as PaperclipWakePayload;
      } catch (err) {
        logger.warn({ err }, 'paperclip-wake: invalid JSON body');
        sendJson(res, 400, { error: 'invalid json' });
        return;
      }

      if (typeof payload !== 'object' || payload === null) {
        sendJson(res, 400, { error: 'payload must be an object' });
        return;
      }

      // Respond 202 immediately; do the work async.
      sendJson(res, 202, {
        accepted: true,
        runId: payload.runId ?? null,
        agentId: payload.agentId ?? null,
      });

      void (async () => {
        try {
          await deps.onWake(payload, rawBody);
        } catch (err) {
          logger.error(
            { err, runId: payload.runId, agentId: payload.agentId },
            'paperclip-wake: onWake handler threw',
          );
        }
      })();

      logger.info(
        {
          method: verification.method,
          runId: payload.runId,
          agentId: payload.agentId,
          wakeReason: payload.context?.wakeReason,
        },
        'paperclip-wake: accepted',
      );
    });
  };
}

export interface StartWakeServerOptions extends PaperclipWakeDeps {
  port: number;
  host: string;
}

/**
 * Start a dedicated HTTP server for /paperclip/wake. Returns the server so
 * callers can close it on shutdown.
 */
export async function startPaperclipWakeServer(
  opts: StartWakeServerOptions,
): Promise<http.Server> {
  const handler = createPaperclipWakeHandler(opts);
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(opts.port, opts.host);
  });
  (opts.logger ?? defaultLogger).info(
    { host: opts.host, port: opts.port, path: WAKE_PATH },
    'paperclip-wake: listening',
  );
  return server;
}
