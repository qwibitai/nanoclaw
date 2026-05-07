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
  return {
    apiKey,
    baseUrl,
    bundle: env.AMPLIFIERD_BUNDLE || DEFAULT_BUNDLE,
    workingDir: env.AMPLIFIERD_WORKING_DIR,
    maxPromptBytes: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_PROMPT_BYTES,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

interface HttpResult {
  status: number;
  body: string;
}

/**
 * POST JSON to amplifierd. Uses node:http directly with a fresh ad-hoc
 * Agent (no shared keep-alive pool) — long-running NanoClaw containers
 * surfaced "fetch failed" errors when undici's pool entered a bad state;
 * a fresh Agent per call eliminates that class of issue.
 */
function postJson(
  cfg: AmplifierdConfig,
  pathSuffix: string,
  bodyObj: unknown,
  timeoutMs: number,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(cfg.baseUrl + pathSuffix);
    const body = JSON.stringify(bodyObj);
    const opts: http.RequestOptions = {
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
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
      req.destroy(new Error(`amplifierd request timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      reject(new Error(`${err.message}${code ? ` [${code}]` : ''}`));
    });
    req.write(body);
    req.end();
  });
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
  let sessionId = continuation;
  if (!sessionId) {
    sessionId = await createSession(cfg);
  }
  try {
    const response = await executePrompt(cfg, sessionId, prompt);
    return { continuation: sessionId, response };
  } catch (err) {
    if (continuation && isStaleSessionError(err)) {
      log(`stale session ${continuation} — rotating to fresh session and retrying once`);
      const fresh = await createSession(cfg);
      const response = await executePrompt(cfg, fresh, prompt);
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
  STALE_SESSION_RE,
  DEFAULT_MAX_PROMPT_BYTES,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_BUNDLE,
};

registerProvider('amplifier-remote', (opts) => new AmplifierRemoteProvider(opts));
