/**
 * Channel completion polling loop (PR-D4-2).
 *
 * Periodically pulls task-completion events from baget.ai's
 * `GET /api/companies/[id]/channel-completions?since=<cursor>&limit=20`
 * endpoint and writes one outbound `chat` message per event so the
 * founder sees a "Done — rewrote 'Pitch Deck'" ping in Telegram after a
 * channel-initiated task finishes. Until this loop existed the founder
 * confirmed an action ("yes, edit the deck"), the worker did the work,
 * and… silence.
 *
 * Companion to baget.ai's server-side endpoint (PR #454) — both sides
 * are gated by the `CHANNEL_COMPLETION_POLLING_ENABLED` flag on the
 * web app, so this loop can deploy ahead of the flag flipping on (every
 * poll returns `{events:[], cursor:since}` until then; cheap idle).
 *
 * Lifecycle:
 *   - Started from `index.ts` alongside `runPollLoop` via `Promise.all`.
 *   - Aborts cleanly when the parent signal fires (container teardown).
 *   - Per-iteration errors are caught + logged, never propagated — a
 *     network blip or 5xx from baget.ai must NOT kill the agent loop.
 *
 * Disabled silently when:
 *   - Any of `BAGET_API_BASE_URL` / `BAGET_CHANNEL_TOKEN` /
 *     `BAGET_COMPANY_ID` is missing (matches the bagetFetch gate in
 *     mcp-tools/baget.ts — same env triplet means same enable signal).
 *   - The current session routing isn't telegram (no chat to deliver to).
 *
 * Cursor seeding:
 *   - On first run with no stored cursor, seed to NOW so a freshly-paired
 *     container does not flood the founder with backlog. The endpoint
 *     uses strict `>`, so seeding to NOW means the first delivery is the
 *     first event whose worker-completion row lands AFTER the loop boots.
 */
import { writeMessageOut } from './db/messages-out.js';
import {
  getChannelCompletionCursor,
  setChannelCompletionCursor,
} from './db/channel-completion-cursor.js';
import { getSessionRouting } from './db/session-routing.js';

/** 60s cadence — confirmed with Sam 2026-05-05.  Multiplied by every
 *  paired founder × every fork replica, so kept conservative. */
const POLL_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_LIMIT = 20;

function log(msg: string): void {
  console.error(`[channel-completion] ${msg}`);
}

interface CompletionEvent {
  id: string;
  createdAt: string;
  channelAction: string;
  taskId: string;
  taskOutcomeSummary: string;
}

interface CompletionsResponse {
  events: CompletionEvent[];
  cursor: string;
}

/**
 * Routing snapshot — captured once per iteration. Injectable so the
 * test suite can drive the loop without populating the host-owned
 * `session_routing` table in the in-memory test DB.
 */
export interface RoutingSnapshot {
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
}

export interface ChannelCompletionLoopConfig {
  signal?: AbortSignal;
  /** Test-only override.  Production uses {@link getSessionRouting}. */
  routingProvider?: () => RoutingSnapshot;
  /** Test-only override. Production uses `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Test-only override. Production uses `setTimeout` via {@link sleep}. */
  intervalMs?: number;
  /** Test-only override. Production seeds with `new Date().toISOString()`. */
  nowProvider?: () => Date;
}

function readEnv(): { baseUrl: string; token: string; companyId: string; appUrl: string } | null {
  const baseUrl = process.env.BAGET_API_BASE_URL;
  const token = process.env.BAGET_CHANNEL_TOKEN;
  const companyId = process.env.BAGET_COMPANY_ID;
  const appUrl = process.env.BAGET_PUBLIC_APP_URL;
  if (!baseUrl || !token || !companyId || !appUrl) return null;
  return { baseUrl, token, companyId, appUrl };
}

function generateMessageId(): string {
  return `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function dashboardLinkFor(appUrl: string, companyId: string): string {
  const trimmed = appUrl.endsWith('/') ? appUrl.slice(0, -1) : appUrl;
  // companyId is a UUID in practice (no special chars), but defensive
  // encoding here keeps the link well-formed if the provisioning ever
  // produces an ID that needs escaping. Per Gemini Medium on PR #34.
  return `${trimmed}/dashboard/${encodeURIComponent(companyId)}`;
}

/**
 * Compose the founder-facing text. Server-side `taskOutcomeSummary` is
 * pre-rendered (capped at 240 chars by the templates module on baget.ai
 * to leave headroom for the dashboard link footer). We append the link
 * here on the fork side so wording iteration on the link itself doesn't
 * require a worker redeploy.
 */
export function composeCompletionText(event: CompletionEvent, dashboardUrl: string): string {
  return `${event.taskOutcomeSummary}\n\nOpen: ${dashboardUrl}`;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onParentAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onParentAbort, { once: true });
  }
  try {
    return await fetchImpl(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

/**
 * Pull one page of completions from baget.ai. Returns null on any
 * non-2xx (logged, swallowed). The next iteration will retry from the
 * same cursor — strict-greater-than on the server keeps replays safe.
 */
export async function pollOnce(args: {
  baseUrl: string;
  token: string;
  companyId: string;
  cursorIso: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<CompletionsResponse | null> {
  const { baseUrl, token, companyId, cursorIso, fetchImpl, signal } = args;
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const url = `${trimmed}/api/companies/${encodeURIComponent(companyId)}/channel-completions?since=${encodeURIComponent(cursorIso)}&limit=${PAGE_LIMIT}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(
      fetchImpl,
      url,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      },
      REQUEST_TIMEOUT_MS,
      signal,
    );
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') return null;
    log(`Fetch error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  if (!res.ok) {
    // 401/403 typically mean the channel token has been revoked; the
    // container will be torn down on disconnect, so we just keep
    // looping idly until that happens. Don't crash the loop.
    log(`Non-2xx from baget.ai: ${res.status}`);
    return null;
  }

  let body: CompletionsResponse;
  try {
    body = (await res.json()) as CompletionsResponse;
  } catch (err) {
    log(`Bad JSON: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  if (!body || !Array.isArray(body.events) || typeof body.cursor !== 'string') {
    log('Bad response shape; ignoring');
    return null;
  }
  return body;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * One iteration of the loop. Exposed for unit-test driving — the
 * production caller is the `runChannelCompletionLoop` while-loop.
 *
 * Returns the cursor that should be persisted (caller is responsible
 * for writing it). Returning the cursor here rather than persisting
 * inline keeps the SQLite write side-effect controllable in tests.
 */
export async function runIteration(args: {
  cursorIso: string;
  routing: RoutingSnapshot;
  env: { baseUrl: string; token: string; companyId: string; appUrl: string };
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<string> {
  const { cursorIso, routing, env, fetchImpl, signal } = args;

  // Routing must be telegram for delivery to make sense. If the host
  // hasn't published a routing row yet, or the session is bound to
  // something else, skip the poll entirely — no point fetching events
  // we can't deliver. Cursor stays put. Bug #4 diagnostic logs:
  // surface the precise reason for skip so a "loop running but never
  // delivers" report has a definitive trace in container logs.
  if (routing.channel_type !== 'telegram' || !routing.platform_id) {
    log(
      `Skip iteration: routing not ready (channel_type=${routing.channel_type ?? 'null'}, platform_id=${routing.platform_id ?? 'null'}). Will retry next tick.`,
    );
    return cursorIso;
  }

  const result = await pollOnce({
    baseUrl: env.baseUrl,
    token: env.token,
    companyId: env.companyId,
    cursorIso,
    fetchImpl,
    signal,
  });
  if (!result) {
    // pollOnce already logged the failure mode (network, non-2xx, bad
    // JSON / shape, abort). Don't log again — keep one line per fail.
    return cursorIso;
  }
  log(
    `Polled since=${cursorIso} → events=${result.events.length}, server-cursor=${result.cursor}`,
  );

  const dashboardUrl = dashboardLinkFor(env.appUrl, env.companyId);

  // Per-event cursor advance. Closes two review findings on PR #34:
  //
  //   - Gemini High: if writeMessageOut fails mid-page and we rewind
  //     to `cursorIso`, the next iteration re-fetches the same page
  //     and re-writes events that DID land — `generateMessageId()`
  //     produces a fresh id every time, so the founder gets duplicate
  //     Telegram pings. By advancing the cursor to the LAST
  //     successful event, the next poll re-fetches starting from the
  //     first event that didn't land — no replays of delivered ones.
  //
  //   - Codex P1: same logic for the abort path. If the parent signal
  //     fires mid-page, the previous all-or-nothing return jumped
  //     straight to `result.cursor` (advancing past undelivered
  //     events); now we return the cursor at the last successful
  //     event so the unwritten tail gets retried on restart.
  //
  // Server-side `>` comparison on `since` keeps duplicate delivery
  // safe — re-polling at the last-successful timestamp returns events
  // STRICTLY AFTER it.
  let lastDeliveredCursor = cursorIso;

  for (const event of result.events) {
    if (signal?.aborted) {
      // Abort mid-page: return the cursor we've actually delivered up
      // to. Unwritten events sit ahead of this cursor and will be
      // picked up on the next iteration after the loop restarts.
      return lastDeliveredCursor;
    }
    const text = composeCompletionText(event, dashboardUrl);
    try {
      writeMessageOut({
        id: generateMessageId(),
        kind: 'chat',
        platform_id: routing.platform_id,
        channel_type: routing.channel_type,
        thread_id: routing.thread_id,
        content: JSON.stringify({ text }),
      });
      log(
        `Delivered completion: action=${event.channelAction} taskId=${event.taskId} createdAt=${event.createdAt}`,
      );
      lastDeliveredCursor = event.createdAt;
    } catch (err) {
      // A single SQLite hiccup shouldn't poison the rest of the page.
      // Log and stop — cursor stays at the last successfully written
      // event so the next poll re-fetches the failed event (and any
      // tail behind it) without re-delivering already-delivered ones.
      log(`writeMessageOut failed: ${err instanceof Error ? err.message : String(err)}`);
      return lastDeliveredCursor;
    }
  }

  // Whole page delivered. The server's `cursor` (latest event in the
  // page) and our `lastDeliveredCursor` should agree at this point —
  // prefer the server's value for forward-compat (e.g. server-side
  // cursor includes a sub-second tiebreaker we don't track here).
  return result.cursor;
}

/**
 * Main loop. Runs until `signal` aborts or the process exits.
 *
 * Resolves cleanly on env-not-set (intentional silent disable) or on
 * abort. Never throws; per-iteration errors are caught inside.
 */
export async function runChannelCompletionLoop(
  config: ChannelCompletionLoopConfig = {},
): Promise<void> {
  const env = readEnv();
  if (!env) {
    log('Env not configured (need BAGET_API_BASE_URL, BAGET_CHANNEL_TOKEN, BAGET_COMPANY_ID, BAGET_PUBLIC_APP_URL); loop disabled.');
    return;
  }

  const fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const routingProvider = config.routingProvider ?? getSessionRouting;
  const intervalMs = config.intervalMs ?? POLL_INTERVAL_MS;
  const nowProvider = config.nowProvider ?? (() => new Date());

  // Seed the cursor on first run so we don't replay backlog. After this
  // point the cursor is owned by `runIteration`.
  const stored = getChannelCompletionCursor();
  let cursor: string;
  if (stored) {
    cursor = stored;
  } else {
    cursor = nowProvider().toISOString();
    setChannelCompletionCursor(cursor);
    log(`Seeded cursor at ${cursor}`);
  }

  log(`Loop started (interval=${intervalMs}ms, base=${env.baseUrl}, company=${env.companyId})`);

  // Heartbeat counter — every N iterations, log a "still alive"
  // line so a Bug #4-style "loop running but never delivers" report
  // can be definitively distinguished from "loop never started" by
  // grepping container logs. POLL_INTERVAL_MS=60s + heartbeat every
  // 10 iterations = one beat per 10 minutes, cheap.
  let iterationCount = 0;
  const HEARTBEAT_EVERY = 10;

  while (!config.signal?.aborted) {
    iterationCount++;
    if (iterationCount % HEARTBEAT_EVERY === 0) {
      log(`Heartbeat: ${iterationCount} iterations, cursor=${cursor}`);
    }
    let routing: RoutingSnapshot;
    try {
      routing = routingProvider();
    } catch (err) {
      log(`routingProvider error: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(intervalMs, config.signal);
      continue;
    }

    let nextCursor = cursor;
    try {
      nextCursor = await runIteration({
        cursorIso: cursor,
        routing,
        env,
        fetchImpl,
        signal: config.signal,
      });
    } catch (err) {
      log(`Iteration error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (nextCursor !== cursor) {
      try {
        setChannelCompletionCursor(nextCursor);
        cursor = nextCursor;
      } catch (err) {
        log(`Cursor persist failed: ${err instanceof Error ? err.message : String(err)}`);
        // Keep the in-memory cursor advanced anyway so the running loop
        // doesn't re-deliver this page; on container restart the prior
        // persisted cursor is what we'll resume from. Trade-off documented:
        // we'd rather miss N events on crash than spam the founder twice.
        cursor = nextCursor;
      }
    }

    await sleep(intervalMs, config.signal);
  }

  log('Loop aborted');
}
