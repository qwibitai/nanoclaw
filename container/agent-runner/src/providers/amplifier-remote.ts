/**
 * Amplifier-remote provider — forwards prompts to amplifierd (Microsoft
 * Amplifier daemon) over HTTP instead of running Claude SDK locally.
 *
 * Two endpoints are used:
 *   POST /sessions             → create a new session
 *   POST /sessions/{id}/execute → run a single turn
 *
 * Configuration is read from the container's environment (set by the
 * host-side `src/providers/amplifier-remote.ts` registration, which parses
 * `~/.config/amplifierd/credentials.env` on the host and ferries the values
 * in as -e flags):
 *
 *   AMPLIFIERD_API_KEY        — bearer token (required)
 *   AMPLIFIERD_BASE_URL       — e.g. http://172.27.158.235:8410 (required)
 *   AMPLIFIERD_BUNDLE         — bundle name on amplifierd (default 'joi')
 *   AMPLIFIERD_WORKING_DIR    — optional; sent verbatim as session working_dir
 *   AMPLIFIERD_MAX_PROMPT_BYTES — optional override for the 256KB cap
 *   AMPLIFIERD_TIMEOUT_MS     — optional override for the 90s per-turn timeout
 *   AMPLIFIERD_ATTACH_PULL_URL — optional. When set, before each
 *                                executePrompt: (1) scan prompt for
 *                                /workspace/attachments/<basename>
 *                                mentions, (2) POST {file} to this URL
 *                                (blocking) so the puller daemon on the
 *                                amplifierd host rsyncs the file from the
 *                                NanoClaw host, (3) rewrite the prompt
 *                                from "/workspace/attachments/X" to
 *                                "workspace/attachments/X". The relative
 *                                form resolves against amplifierd's
 *                                session working_dir (which has a symlink
 *                                "workspace/attachments" → puller cache),
 *                                whereas the absolute form would fail
 *                                since /workspace doesn't exist at root
 *                                on the amplifierd host. Unset = no-op
 *                                (provider behaves as before).
 *
 * Ported 2026-05 from src/runners/amplifier-remote/{client,index}.ts (1.x).
 * The legacy safety.ts is intentionally not ported — its 4-layer dispatch
 * predicate is superseded by 2.0's `src/modules/permissions/`.
 */

import http from 'http';
import { URL } from 'url';

import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

function log(msg: string): void {
  console.error(`[amplifier-remote-provider] ${msg}`);
}

const DEFAULT_MAX_PROMPT_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_BUNDLE = 'joi';

interface AmplifierdConfig {
  apiKey: string;
  baseUrl: string;
  bundle: string;
  workingDir?: string;
  maxPromptBytes: number;
  timeoutMs: number;
  attachPullUrl?: string;
}

function readConfig(envOverride?: Record<string, string | undefined>): AmplifierdConfig {
  const env = envOverride ?? process.env;
  const apiKey = env.AMPLIFIERD_API_KEY;
  const baseUrl = env.AMPLIFIERD_BASE_URL;
  if (!apiKey) {
    throw new Error('amplifier-remote: AMPLIFIERD_API_KEY not set in container env');
  }
  if (!baseUrl) {
    throw new Error('amplifier-remote: AMPLIFIERD_BASE_URL not set in container env');
  }
  const max = parseInt(env.AMPLIFIERD_MAX_PROMPT_BYTES ?? '', 10);
  const timeout = parseInt(env.AMPLIFIERD_TIMEOUT_MS ?? '', 10);
  const attachPullUrl = env.AMPLIFIERD_ATTACH_PULL_URL?.trim();
  return {
    apiKey,
    baseUrl,
    bundle: env.AMPLIFIERD_BUNDLE || DEFAULT_BUNDLE,
    workingDir: env.AMPLIFIERD_WORKING_DIR,
    maxPromptBytes: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_PROMPT_BYTES,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
    attachPullUrl: attachPullUrl ? attachPullUrl : undefined,
  };
}

interface HttpResult {
  status: number;
  body: string;
}

/**
 * POST JSON to an arbitrary URL. Uses node:http directly with a fresh
 * ad-hoc Agent (no shared keep-alive pool) — long-running NanoClaw
 * containers surfaced "fetch failed" errors when undici's pool entered a
 * bad state; a fresh Agent per call eliminates that class of issue.
 */
function postJsonAt(
  url: URL,
  headers: Record<string, string>,
  bodyObj: unknown,
  timeoutMs: number,
  timeoutLabel: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(bodyObj);
    const opts: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'application/json',
      },
      agent: new http.Agent({ keepAlive: false }),
      timeout: timeoutMs,
    };
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') });
      });
      res.on('error', (err) => reject(err));
    });
    req.on('timeout', () => {
      req.destroy(new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      reject(new Error(`${err.message}${code ? ` [${code}]` : ''}`));
    });
    req.write(body);
    req.end();
  });
}

function postJson(
  cfg: AmplifierdConfig,
  pathSuffix: string,
  bodyObj: unknown,
  timeoutMs: number,
): Promise<HttpResult> {
  return postJsonAt(
    new URL(cfg.baseUrl + pathSuffix),
    { Authorization: `Bearer ${cfg.apiKey}` },
    bodyObj,
    timeoutMs,
    'amplifierd request',
  );
}

function extractErrorDetail(body: string, fallback: string): string {
  if (!body) return fallback;
  try {
    const json = JSON.parse(body) as { detail?: unknown; error?: unknown };
    if (typeof json.detail === 'string') return json.detail;
    if (json.detail && typeof json.detail === 'object') {
      const d = json.detail as { detail?: unknown; title?: unknown };
      if (typeof d.detail === 'string') return d.detail;
      if (typeof d.title === 'string') return d.title;
    }
    if (typeof json.error === 'string') return json.error;
  } catch {
    /* not JSON */
  }
  return body.slice(0, 500);
}

interface CreateSessionResponse {
  session_id: string;
  status?: string;
  bundle_name?: string;
  working_dir?: string;
}

interface ExecuteResponse {
  response?: string;
}

async function createSession(cfg: AmplifierdConfig, metadata?: Record<string, unknown>): Promise<string> {
  const body: Record<string, unknown> = { bundle_name: cfg.bundle };
  if (cfg.workingDir) body.working_dir = cfg.workingDir;
  if (metadata) body.metadata = metadata;

  let result: HttpResult;
  try {
    result = await postJson(cfg, '/sessions', body, 30_000);
  } catch (err) {
    throw new Error(`amplifierd network error on createSession: ${(err as Error).message}`);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`amplifierd ${result.status} on createSession: ${extractErrorDetail(result.body, `HTTP ${result.status}`)}`);
  }
  let data: CreateSessionResponse;
  try {
    data = JSON.parse(result.body) as CreateSessionResponse;
  } catch {
    throw new Error(`amplifierd createSession returned non-JSON: ${result.body.slice(0, 200)}`);
  }
  if (!data.session_id) {
    throw new Error(`amplifierd createSession returned no session_id (response: ${result.body.slice(0, 200)})`);
  }
  return data.session_id;
}

async function executePrompt(cfg: AmplifierdConfig, sessionId: string, prompt: string): Promise<string> {
  const promptBytes = Buffer.byteLength(prompt, 'utf8');
  if (promptBytes > cfg.maxPromptBytes) {
    throw new Error(
      `amplifierd executePrompt: prompt size ${promptBytes} bytes exceeds limit ${cfg.maxPromptBytes} bytes (set AMPLIFIERD_MAX_PROMPT_BYTES to raise)`,
    );
  }
  let result: HttpResult;
  try {
    result = await postJson(cfg, `/sessions/${encodeURIComponent(sessionId)}/execute`, { prompt }, cfg.timeoutMs);
  } catch (err) {
    throw new Error(`amplifierd network error on executePrompt: ${(err as Error).message}`);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`amplifierd ${result.status} on executePrompt: ${extractErrorDetail(result.body, `HTTP ${result.status}`)}`);
  }
  let data: ExecuteResponse;
  try {
    data = JSON.parse(result.body) as ExecuteResponse;
  } catch {
    throw new Error(`amplifierd executePrompt returned non-JSON: ${result.body.slice(0, 200)}`);
  }
  if (typeof data.response !== 'string') {
    throw new Error(`amplifierd executePrompt returned unexpected shape: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return data.response;
}

// Matches /workspace/attachments/<basename> as it appears in the prompt
// (e.g. "[Image: /workspace/attachments/foo.jpg]" or "[File: Letter to
// Banks.pdf at /workspace/attachments/line-...-Letter to Banks.pdf]").
// Basenames may contain spaces and other punctuation — channel adapters
// validate via isSafeAttachmentName which only forbids /, \, NUL, '.',
// '..'. Stop at ']' (the marker terminator) or newline so we don't
// over-greedy-match into surrounding text. Free-form inline mentions
// without a closing bracket are rare; channel adapters always wrap
// attachments in [Image:…]/[File:…] markers.
const ATTACHMENT_PATH_RE = /\/workspace\/attachments\/([^\]\n\r]+)/g;
const ATTACHMENT_PATH_PREFIX = '/workspace/attachments/';
const ATTACHMENT_PATH_PREFIX_REL = 'workspace/attachments/';
const PREFETCH_TIMEOUT_MS = 30_000;

function extractAttachmentBasenames(prompt: string): string[] {
  const seen = new Set<string>();
  ATTACHMENT_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTACHMENT_PATH_RE.exec(prompt))) {
    if (m[1]) seen.add(m[1]);
  }
  return Array.from(seen);
}

/**
 * Replace every absolute /workspace/attachments/ prefix in the prompt
 * with the relative form workspace/attachments/. Amplifierd's Read tool
 * only prefixes RELATIVE paths with the session working_dir; an absolute
 * path is taken literally and would fail (no /workspace at root on the
 * amplifierd host). The session working_dir on macazbd has a symlink
 * "workspace/attachments" → puller cache, so the relative form resolves.
 */
function rewriteAttachmentPaths(prompt: string): string {
  return prompt.split(ATTACHMENT_PATH_PREFIX).join(ATTACHMENT_PATH_PREFIX_REL);
}

/**
 * Ferry referenced attachment files to the amplifierd host before
 * forwarding the prompt. Throws on any non-2xx response or network
 * error — the agent shouldn't proceed if files didn't ferry, since a
 * downstream Read will fail in a way that's harder to diagnose.
 *
 * Only fires when AMPLIFIERD_ATTACH_PULL_URL is configured. Other
 * NanoClaw providers (claude SDK, opencode, etc.) Read attachments from
 * the same bind-mount the host wrote them to and don't need this hop.
 */
async function prefetchAttachments(cfg: AmplifierdConfig, prompt: string): Promise<void> {
  if (!cfg.attachPullUrl) return;
  const files = extractAttachmentBasenames(prompt);
  if (files.length === 0) return;
  const url = new URL(cfg.attachPullUrl);
  for (const file of files) {
    let result: HttpResult;
    try {
      result = await postJsonAt(url, {}, { file }, PREFETCH_TIMEOUT_MS, 'attachment-puller request');
    } catch (err) {
      throw new Error(`attachment ferry failed for "${file}": ${(err as Error).message}`);
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(
        `attachment ferry failed for "${file}": puller HTTP ${result.status} ${extractErrorDetail(result.body, '')}`.trim(),
      );
    }
  }
  log(`prefetched ${files.length} attachment(s): ${files.join(', ')}`);
}

// Conditions where the cached continuation can't be reused and we should
// drop it for a fresh session:
//   404 / "session not found" — daemon restarted, daily cleanup, hot-replace
//   409 / "already executing" — the prior turn never returned (host
//                               killed the container mid-call, network
//                               drop, etc.) and amplifierd has no cancel
//                               primitive we can use, so the session is
//                               effectively wedged. Surfaced 2026-05-07
//                               as a hung joi-dm container that left a
//                               leaked session behind.
const STALE_SESSION_RE = /\b404\b|\b409\b|session.*not.*found|already executing/i;

function isStaleSessionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return STALE_SESSION_RE.test(msg);
}

/**
 * Run one turn against amplifierd: ensure a session exists (creating one
 * if needed), execute the prompt, return the new continuation + response.
 *
 * If a cached `continuation` is supplied and the execute call fails with
 * a stale-session error (daemon restarted, hot-replaced, daily cleanup),
 * drop the stale id and retry once with a fresh session.
 */
async function runTurn(
  cfg: AmplifierdConfig,
  prompt: string,
  continuation: string | undefined,
): Promise<{ continuation: string; response: string }> {
  // Ferry attachments to amplifierd's host first; if any fail, abort
  // the turn rather than send a prompt referencing files that aren't
  // there. Then rewrite absolute → relative so the amplifierd-side
  // Read resolves through the working_dir symlink. Both steps are
  // no-ops when AMPLIFIERD_ATTACH_PULL_URL is unset.
  await prefetchAttachments(cfg, prompt);
  const sendPrompt = cfg.attachPullUrl ? rewriteAttachmentPaths(prompt) : prompt;

  let sessionId = continuation;
  if (!sessionId) {
    sessionId = await createSession(cfg);
  }
  try {
    const response = await executePrompt(cfg, sessionId, sendPrompt);
    return { continuation: sessionId, response };
  } catch (err) {
    if (continuation && isStaleSessionError(err)) {
      log(`stale session ${continuation} — rotating to fresh session and retrying once`);
      const fresh = await createSession(cfg);
      const response = await executePrompt(cfg, fresh, sendPrompt);
      return { continuation: fresh, response };
    }
    throw err;
  }
}

export class AmplifierRemoteProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private envOverride?: Record<string, string | undefined>;

  constructor(options: ProviderOptions = {}) {
    this.envOverride = options.env;
  }

  isSessionInvalid(err: unknown): boolean {
    return isStaleSessionError(err);
  }

  query(input: QueryInput): AgentQuery {
    const cfg = readConfig(this.envOverride);

    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    let currentContinuation: string | undefined = input.continuation;

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        const turns = [input.prompt];

        for (let i = 0; i < turns.length; i++) {
          if (aborted) return;
          yield { type: 'activity' };
          let result: { continuation: string; response: string };
          try {
            result = await runTurn(cfg, turns[i]!, currentContinuation);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            yield { type: 'error', message: msg, retryable: !isStaleSessionError(err) };
            return;
          }
          // First turn yields init with the session id (so the poll-loop
          // can persist it as the continuation token for next time).
          if (currentContinuation !== result.continuation) {
            yield { type: 'init', continuation: result.continuation };
          }
          currentContinuation = result.continuation;
          yield { type: 'activity' };
          yield { type: 'result', text: result.response };
        }

        // Process any follow-ups pushed via push()
        while (!ended && !aborted) {
          if (pending.length > 0) {
            const msg = pending.shift()!;
            yield { type: 'activity' };
            let result: { continuation: string; response: string };
            try {
              result = await runTurn(cfg, msg, currentContinuation);
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              yield { type: 'error', message: errMsg, retryable: !isStaleSessionError(err) };
              return;
            }
            if (currentContinuation !== result.continuation) {
              yield { type: 'init', continuation: result.continuation };
            }
            currentContinuation = result.continuation;
            yield { type: 'activity' };
            yield { type: 'result', text: result.response };
            continue;
          }
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        // Drain remaining
        while (pending.length > 0 && !aborted) {
          const msg = pending.shift()!;
          yield { type: 'activity' };
          let result: { continuation: string; response: string };
          try {
            result = await runTurn(cfg, msg, currentContinuation);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            yield { type: 'error', message: errMsg, retryable: !isStaleSessionError(err) };
            return;
          }
          currentContinuation = result.continuation;
          yield { type: 'result', text: result.response };
        }
      },
    };

    return {
      push: (message: string) => {
        pending.push(message);
        waiting?.();
      },
      end: () => {
        ended = true;
        waiting?.();
      },
      events,
      abort: () => {
        aborted = true;
        ended = true;
        waiting?.();
      },
    };
  }
}

// Internal helpers exported for unit tests only.
export const __test = {
  readConfig,
  isStaleSessionError,
  extractErrorDetail,
  extractAttachmentBasenames,
  rewriteAttachmentPaths,
  STALE_SESSION_RE,
  DEFAULT_MAX_PROMPT_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_BUNDLE,
};

registerProvider('amplifier-remote', (opts) => new AmplifierRemoteProvider(opts));
