/**
 * Baget MCP tools — exposes founder actions on a Baget company to the
 * agent running in this container.
 *
 * All tools fan through Baget's public API (`*.baget.ai/api/...`)
 * using a per-(user, company) bearer token injected by OneCLI. The
 * container never holds raw credentials, never writes to the Baget
 * Postgres directly, and never calls third-party APIs (Apollo, Meta,
 * Resend) — every action goes through the same code path the dashboard
 * uses, which means identical auth + rate limit + tenant guard +
 * idempotency + credit deduction + audit log on both sides.
 *
 * This is the substrate the BagetAI/baget.ai team should have built
 * originally for the in-app Telegram bot. Migrating here cleans up the
 * "agent ≡ web client" property and unlocks Slack/WhatsApp/Discord for
 * free.
 *
 * Tool surface:
 *
 *   READ (6):
 *     - baget_get_company_overview
 *     - baget_query_metrics
 *     - baget_get_credits
 *     - baget_list_recent_activity
 *     - baget_list_documents
 *     - baget_read_document
 *
 *   FILE TRANSFER (1) — fetches a baget.ai-rendered artifact and ships
 *   it through nanoclaw's per-channel send pipeline. Lives here rather
 *   than next to core's `send_file` because the orchestration is
 *   baget-specific (calls /render-pdf with the channel bearer to get a
 *   blob URL, fetches the bytes, then defers to the same outbox-write
 *   pattern `send_file` uses):
 *     - baget_send_document_file
 *
 *   GENERATE (1) — produces fresh artifacts (images today; future:
 *   videos, audio) and ships them via the same outbox + attachments
 *   contract as send_document_file. Calls Gemini Image API directly
 *   with the channel-runner's existing GOOGLE_GENERATIVE_AI_API_KEY —
 *   intentionally bypasses baget.ai's auth/audit/credit rail because
 *   image generation is conversational scratchwork (mockup, "what
 *   could this look like" exploration), not a saved-asset write. If
 *   the founder wants the image as a saved brand asset, point them at
 *   the dashboard's image flow which goes through the worker:
 *     - baget_generate_image
 *
 *   WRITE — direct (free, immediate; calls /approval/execute):
 *     - baget_set_direction
 *     - baget_update_metric
 *     - baget_archive_metric
 *     - baget_add_metric_history
 *     - baget_set_metric_target
 *     - baget_add_task
 *     - baget_park_task
 *     - baget_cancel_running_tasks
 *     - baget_approve_pending
 *     - baget_reject_pending
 *     - baget_pause_ad
 *     - baget_resume_ad
 *
 *   WRITE — approval-gated (founder must tap ✅ on the channel UI;
 *   action runs only after approval):
 *     - baget_launch_batch
 *     - baget_edit_document
 *     - baget_reveal_prospect
 *     - baget_send_campaign
 *
 * For approval-gated tools, the wrapper:
 *   1. Calls /approval/preview to compute cost + render context
 *   2. Returns a "approval-pending — show the cost + summary, ask the
 *      founder to confirm by replying yes" structured response
 *   3. The agent's NEXT turn (after founder confirms) calls
 *      /approval/execute to actually run the action.
 *
 * NanoClaw doesn't have a native inline-keyboard primitive across all
 * channels (Telegram has it, Slack has blocks, Discord has buttons,
 * WhatsApp has neither). Using a "natural confirmation" turn keeps the
 * approval flow channel-agnostic. Phase 4 may add per-channel rich UI
 * via channel adapter capabilities.
 */
import fs from 'fs';
import path from 'path';

import { writeMessageOut } from '../db/messages-out.js';
import { workspaceOutboxDir } from '../workspace-paths.js';
import { generateImageBytes, type AspectRatio, type GenerateImageDeps } from './image-gen.js';
import { generateId, resolveRouting } from './core.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools/baget] ${msg}`);
}

// ── Configuration ─────────────────────────────────────────────────────────────

function getBagetApiBase(): string {
  return process.env.BAGET_API_BASE_URL ?? 'https://stg-app.baget.ai';
}

function getChannelToken(): string | null {
  return process.env.BAGET_CHANNEL_TOKEN ?? null;
}

/**
 * Host-callback token for `/approval/confirm` — separate from the
 * per-(user, company) channel token because confirm is a privileged
 * "the founder DID tap approve" assertion that the apps/web side
 * gates with a shared secret. PR #462 (apps/web) added the
 * `BAGET_CHANNEL_APPROVAL_CALLBACK_TOKEN` requirement; the fork
 * picks it up here so dispatchApproval(confirmed:true) can mint
 * the approvalToken JWT it then passes to /approval/execute.
 *
 * Sam 2026-05-06 staging smoke: dispatchApproval was using the
 * per-company channel token for confirm and the route threw
 * `BAGET_CHANNEL_APPROVAL_CALLBACK_TOKEN is not set` (caught by
 * the empty catch → 500 → "There was an issue running that task").
 */
function getApprovalCallbackToken(): string | null {
  return process.env.BAGET_APPROVAL_CALLBACK_TOKEN ?? null;
}

function getCompanyId(): string | null {
  return process.env.BAGET_COMPANY_ID ?? null;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

interface BagetFetchArgs {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /**
   * Per-call abort timeout (ms). Defaults to 15s — fine for the read +
   * approval/execute paths which return promptly. Override for routes
   * that do real work server-side (render-pdf does pdfkit cold-import +
   * markdown rendering + a Vercel Blob upload, easily 25-30s on a cold
   * lambda). Caller sets `timeoutMs` to give themselves enough budget.
   */
  timeoutMs?: number;
  /**
   * Override the bearer token. Defaults to the channel token (per-
   * (user, company) bearer minted at pair-time). Set to
   * `'approval-callback'` for `/approval/confirm` which requires the
   * shared `BAGET_APPROVAL_CALLBACK_TOKEN` host secret instead.
   */
  authToken?: 'channel' | 'approval-callback';
}

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

interface BagetFetchOk<T> {
  ok: true;
  status: number;
  data: T;
}

interface BagetFetchErr {
  ok: false;
  status: number;
  error: string;
}

async function bagetFetch<T = unknown>(args: BagetFetchArgs): Promise<BagetFetchOk<T> | BagetFetchErr> {
  const tokenKind = args.authToken ?? 'channel';
  const token =
    tokenKind === 'approval-callback'
      ? getApprovalCallbackToken()
      : getChannelToken();
  if (!token) {
    return {
      ok: false,
      status: 0,
      error:
        tokenKind === 'approval-callback'
          ? 'BAGET_APPROVAL_CALLBACK_TOKEN missing. The fork can\'t authenticate /approval/confirm without it. Set it on Railway baget-channel staging/prod env to the same value as Vercel\'s BAGET_CHANNEL_APPROVAL_CALLBACK_TOKEN.'
          : 'BAGET_CHANNEL_TOKEN missing. Container is not authenticated to baget.ai. Re-pair the channel from the Baget dashboard.',
    };
  }

  const base = getBagetApiBase();
  const url = `${base.replace(/\/$/, '')}${args.path}`;
  const res = await fetch(url, {
    method: args.method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: args.body ? JSON.stringify(args.body) : undefined,
    signal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS),
  });

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const errMsg =
      data && typeof data === 'object' && 'error' in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${res.status}`;
    return { ok: false, status: res.status, error: errMsg };
  }

  return { ok: true, status: res.status, data: data as T };
}

// ── Result helpers ────────────────────────────────────────────────────────────

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function fail(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function requireCompanyId(): { ok: true; companyId: string } | { ok: false; error: string } {
  const companyId = getCompanyId();
  if (!companyId) {
    return {
      ok: false,
      error: 'BAGET_COMPANY_ID not set. This container is not bound to a company. Check the agent group config.',
    };
  }
  return { ok: true, companyId };
}

// ── Action dispatch helpers ──────────────────────────────────────────────────

/**
 * Direct dispatch — fire /approval/execute immediately, return the
 * server-rendered `messageForFounder` so the agent can echo it.
 *
 * Use for free, idempotent, non-destructive write actions where there's
 * no card flow.
 */
async function dispatchDirect(args: { action: string; payload: Record<string, unknown>; fallbackMessage: string }) {
  const ctx = requireCompanyId();
  if (!ctx.ok) return fail(ctx.error);

  const result = await bagetFetch<{ ok: boolean; messageForFounder?: string; kind?: string }>({
    method: 'POST',
    path: `/api/companies/${ctx.companyId}/approval/execute`,
    body: { action: args.action, payload: args.payload },
  });
  if (!result.ok) return fail(`${args.action} failed: ${result.error}`);

  const msg = result.data.messageForFounder ?? args.fallbackMessage;
  return ok(msg);
}

/**
 * Approval dispatch — fire /approval/preview to compute cost, return a
 * structured "approval-pending" message the agent can show. The
 * AGENT'S NEXT TURN calls this same tool with confirmed=true, which
 * fires /approval/execute.
 *
 * Why a 2-turn flow vs an inline keyboard:
 *   - NanoClaw is channel-agnostic — no shared inline-button primitive
 *     across Telegram/Slack/Discord/WhatsApp.
 *   - The agent's natural-language ask ("This will cost ~5 credits.
 *     Want me to proceed? Reply 'yes' or 'no'.") works on every
 *     channel and is auditable in the chat history.
 *   - The model handles the confirm flow with system-prompt rules in
 *     setup/baget-template/CLAUDE.md (look for "approval card").
 *   - Phase 4: per-channel rich UI via adapter capabilities.
 */
// Sam 2026-05-06 S-10 retest: tapping ✅ Approve produced
// "Error: run-task execute failed: approval-required". Root cause:
// PR #462 (apps/web) added a 3-step approval flow:
//   1. POST /approval/preview  → returns { cost, approval: { requestId, expiresAt } }
//   2. POST /approval/confirm  → returns { approvalToken } (mints a JWT proof)
//   3. POST /approval/execute  → REQUIRES `approvalToken` in body, else 403 approval-required
// The fork's dispatchApproval was only doing 1 and 3, dropping the
// requestId from the preview response and skipping confirm. Every
// approval-gated action (run-task, launch-batch, edit-document,
// reveal-prospect, send-campaign) was therefore unrunnable end-to-end.
//
// Cache keyed by `companyId|action|<canonical payload>`. The LLM
// is instructed to pass the IDENTICAL payload on confirmed:true,
// so the cache hits. TTL is 5 min (matches the approval-request
// expiry).
//
// Hardening (Gemini medium on PR #44):
//   1. **Memory leak fix**: every read/write sweeps expired entries
//      so a series of preview-only / no-tap calls (e.g. founder
//      dismisses the card, network drop) can't grow the Map
//      unbounded over a long-running process. Sweep is O(N) but N
//      is bounded by founder activity (5-min TTL × concurrent
//      agents = ~tens at most), and only fires on cache touch, not
//      on a timer — keeps the agent-runner deterministic.
//   2. **Canonical key fix**: `JSON.stringify` order depends on
//      object construction order. The LLM nominally sends the
//      identical payload, but defense-in-depth: serialize via a
//      sorted-key replacer so `{a:1, b:2}` and `{b:2, a:1}` map to
//      the same cache slot.
//
// Process-local Map is safe — agent-runner is single-process per
// company, container restart loses pending approvals (founder
// re-issues the request; 5-min TTL was already a soft contract).
interface PendingApproval {
  requestId: string;
  expiresAtMs: number;
}
const pendingApprovals = new Map<string, PendingApproval>();

function canonicalizePayload(payload: Record<string, unknown>): string {
  // Sorted-key serialization. Recurse into nested objects so
  // `{outer: {b:2, a:1}}` and `{outer: {a:1, b:2}}` produce the
  // same string. Arrays preserve order (semantically meaningful).
  const sortKeys = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortKeys);
    if (value !== null && typeof value === 'object') {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = sortKeys((value as Record<string, unknown>)[k]);
      }
      return sorted;
    }
    return value;
  };
  return JSON.stringify(sortKeys(payload));
}

function approvalCacheKey(companyId: string, action: string, payload: Record<string, unknown>): string {
  return `${companyId}|${action}|${canonicalizePayload(payload)}`;
}

function sweepExpiredApprovals(): void {
  const now = Date.now();
  for (const [key, entry] of pendingApprovals) {
    if (entry.expiresAtMs < now) pendingApprovals.delete(key);
  }
}

async function dispatchApproval(args: {
  action: string;
  payload: Record<string, unknown>;
  confirmed: boolean;
  summary: string;
}) {
  const ctx = requireCompanyId();
  if (!ctx.ok) return fail(ctx.error);

  const cacheKey = approvalCacheKey(ctx.companyId, args.action, args.payload);
  // Lazy sweep — every dispatch touch clears expired entries. Cheap
  // (O(N) over a short list) and avoids needing a separate timer
  // that would have its own lifecycle in the runtime.
  sweepExpiredApprovals();

  if (!args.confirmed) {
    // Cost preview — show the founder what they'd be approving.
    // Capture the `approval.requestId` from the response so we can
    // confirm + execute on the next call (confirmed:true).
    const preview = await bagetFetch<{
      ok: boolean;
      cost: { amount: number; remaining: number; tasksRemaining: number; disabledReason?: string };
      approval?: { required: boolean; requestId: string; expiresAt: string };
    }>({
      method: 'POST',
      path: `/api/companies/${ctx.companyId}/approval/preview`,
      body: { action: args.action, payload: args.payload },
    });
    if (!preview.ok) return fail(`${args.action} preview failed: ${preview.error}`);

    // Cache the requestId (when present) for the confirmed:true
    // re-entry. Pre-#462 deployments don't return `approval` and
    // we'll fall through to the legacy path on confirm without it.
    if (preview.data.approval?.requestId) {
      pendingApprovals.set(cacheKey, {
        requestId: preview.data.approval.requestId,
        expiresAtMs: new Date(preview.data.approval.expiresAt).getTime(),
      });
    }

    const cost = preview.data.cost;
    if (cost.disabledReason) {
      return ok(
        JSON.stringify({
          status: 'cannot-proceed',
          reason: cost.disabledReason,
          summary: args.summary,
        }),
      );
    }

    // Phase 4 v0.1: send the approval card DIRECTLY as a Telegram
    // message with inline-keyboard buttons, bypassing the LLM's
    // outbound rendering. Architecture rationale:
    //
    //   - Buttons are a UX shortcut for typing yes/no. The host's
    //     callback_query handler (in src/channels/baget-telegram.ts)
    //     synthesizes the tap as a normal "yes" / "cancel" inbound
    //     so the existing dispatchApproval(confirmed:true) re-entry
    //     path runs unchanged.
    //   - Since the LLM doesn't know about reply_markup formatting,
    //     and our prompt-shaping has been brittle, we just write the
    //     outbound row directly here.
    //   - Falls back to the legacy text-only flow when we can't
    //     resolve a Telegram destination (no session_routing yet,
    //     `to` resolution misses, etc.).
    //
    // callback_data schema: `appr:yes` / `appr:no`. No card_id —
    // the LLM keeps the payload in its conversation context, and
    // the callback_query just synthesizes a text "yes"/"cancel" the
    // model already knows how to interpret.
    const routing = resolveRouting(undefined);
    // Codex P1 on PR #40: the Baget Telegram adapter registers as
    // `baget-telegram` (`BAGET_TELEGRAM_CHANNEL_TYPE` in
    // src/channels/baget-telegram-bind.ts), so the host's
    // session_routing carries `channel_type: 'baget-telegram'`. A
    // bare `=== 'telegram'` guard never matches, so the direct-write
    // branch never ran, so approval-card buttons never reached the
    // founder. Accept both: 'telegram' (generic / non-Baget nanoclaw
    // deployments) AND 'baget-telegram' (every Baget founder pairing).
    const isTelegramChannel =
      'channel_type' in routing &&
      (routing.channel_type === 'telegram' || routing.channel_type === 'baget-telegram');
    if (isTelegramChannel && routing.platform_id) {
      const costLine =
        cost.amount > 0
          ? `Cost: ${cost.amount} credits. You have ${cost.remaining} remaining.`
          : 'Included in your plan — no extra credit charge.';
      const cardText = `${args.summary.trim()}\n\n${costLine}`;
      const replyMarkup = {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: 'appr:yes' },
            { text: '❌ Cancel', callback_data: 'appr:no' },
          ],
        ],
      };
      try {
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platform_id,
          channel_type: routing.channel_type,
          thread_id: routing.thread_id,
          content: JSON.stringify({ text: cardText, replyMarkup }),
        });
        // Tell the LLM the card has been delivered — DO NOT render
        // a second text message. Wrap the instruction in a clear
        // status the persona-handler can recognise.
        return ok(
          JSON.stringify({
            status: 'approval-card-delivered',
            summary: args.summary,
            cost: {
              amount: cost.amount,
              remaining: cost.remaining,
              tasksRemaining: cost.tasksRemaining,
            },
            note: 'The approval card has been sent to the founder via Telegram with [✅ Approve] / [❌ Cancel] inline buttons. DO NOT write any additional text reply — return immediately and await the founder\'s tap. When the founder taps a button, the host synthesizes a "yes" or "cancel" message into your inbound queue; on "yes" you call this tool again with `confirmed: true` and the IDENTICAL payload. On "cancel" / "no", acknowledge briefly ("Got it — cancelled.") and move on.',
          }),
        );
      } catch (err) {
        // If the direct outbound write failed, fall through to the
        // legacy text-only flow below so the founder still sees a
        // confirmation prompt.
        // eslint-disable-next-line no-console
        console.error('[baget] dispatchApproval direct-write failed; falling back to text', err);
      }
    }

    // Legacy fallback — text-only flow when we can't deliver
    // buttons (no telegram routing yet, etc.).
    return ok(
      JSON.stringify({
        status: 'approval-pending',
        summary: args.summary,
        cost: {
          amount: cost.amount,
          remaining: cost.remaining,
          tasksRemaining: cost.tasksRemaining,
        },
        note: [
          'Tell the founder the summary + cost in PLAIN TEXT.',
          'Ask them to confirm by REPLYING WITH A WORD — "yes" / "go" / "approve" — or "no" / "cancel".',
          'DO NOT say "tap", "press", "click", "✅", or any phrasing that implies a button — there is no button on this surface, the founder confirms by typing a word.',
          'You may set `confirmed: true` ONLY when the founder\'s NEXT message is a clear standalone confirmation word (yes / yeah / yep / go / ok / okay / approve / approved / confirmed / sure / do it). A REPEAT of the original action request (e.g. "launch the next batch" sent twice, "set direction to X" sent twice) is NOT a confirmation — treat it as the founder asking again, not approving the prior pending card. If you are unsure, ask explicitly: "To confirm, reply \'yes\' or \'go\'." Never auto-confirm on a duplicate or paraphrase of the original request.',
          'Cost shape semantics — `amount` is the credits this single action will deduct; `remaining` is the founder\'s total credit balance; `tasksRemaining` is HOW MANY TASKS OF THIS COST THE BALANCE CAN AFFORD (a budget headroom number), NOT the count of tasks this action will run. Do NOT say "this includes N tasks" or "queues N tasks" — that misreads `tasksRemaining`. Phrase it as "you have headroom for ~N more tasks of this size" or just omit it.',
          'When `amount === 0`, the action is INCLUDED in the founder\'s plan at no incremental credit charge — it is not a bug. Phrase it as "this is included in your plan" or "no extra credit charge — this is part of your plan", NOT as "will cost 0 credits" (that reads like a broken counter). Strategy / Chief-of-Staff / Ops tasks at junior+ seniority are the typical 0-amount path.',
          'On their confirmation, call this same tool with `confirmed: true` and the IDENTICAL payload.',
        ].join(' '),
      }),
    );
  }

  // Founder confirmed — actually execute. Per PR #462's hardening,
  // /approval/execute requires an `approvalToken` minted by
  // /approval/confirm against the requestId we captured during the
  // preview call. If the cache miss / expired, ask the agent to
  // re-request approval (the LLM will paraphrase to the founder).
  const cached = pendingApprovals.get(cacheKey);
  if (!cached) {
    return fail(
      `${args.action} execute failed: approval-not-cached — call this tool with confirmed:false first to mint a fresh approval request, then re-confirm`,
    );
  }
  if (cached.expiresAtMs < Date.now()) {
    pendingApprovals.delete(cacheKey);
    return fail(
      `${args.action} execute failed: approval-expired — call this tool with confirmed:false to mint a fresh request`,
    );
  }

  // Step 2: confirm the request, get an approvalToken JWT.
  // /approval/confirm uses a SHARED host-callback secret (not the
  // per-(user, company) channel token) — see getApprovalCallbackToken
  // for the rationale.
  const confirmResp = await bagetFetch<{
    ok: boolean;
    approvalToken?: string;
    expiresAt?: string;
    status?: 'rejected';
  }>({
    method: 'POST',
    path: `/api/companies/${ctx.companyId}/approval/confirm`,
    body: { requestId: cached.requestId, decision: 'approve' },
    authToken: 'approval-callback',
  });
  if (!confirmResp.ok) {
    pendingApprovals.delete(cacheKey);
    return fail(`${args.action} confirm failed: ${confirmResp.error}`);
  }
  const approvalToken = confirmResp.data.approvalToken;
  if (!approvalToken) {
    pendingApprovals.delete(cacheKey);
    return fail(`${args.action} confirm failed: no approvalToken in response`);
  }

  // Step 3: execute with the proof token.
  const result = await bagetFetch<{ ok: boolean; messageForFounder?: string }>({
    method: 'POST',
    path: `/api/companies/${ctx.companyId}/approval/execute`,
    body: { action: args.action, payload: args.payload, approvalToken },
  });
  // Always invalidate the cache after attempt — token is single-use.
  pendingApprovals.delete(cacheKey);
  if (!result.ok) return fail(`${args.action} execute failed: ${result.error}`);
  return ok(result.data.messageForFounder ?? `${args.action} done.`);
}

// ── READ tools ────────────────────────────────────────────────────────────────

const getCompanyOverview: McpToolDefinition = {
  tool: {
    name: 'baget_get_company_overview',
    description:
      "Fetch the founder's company overview — name, status, current batch number, top metrics. Use at the start of every conversation to ground your reply in the latest state.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/overview`,
    });
    if (!result.ok) return fail(`get_company_overview failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

const queryMetrics: McpToolDefinition = {
  tool: {
    name: 'baget_query_metrics',
    description:
      "Get current values + recent history for the founder's active business metrics (waitlist, MRR, signups, etc.). ALWAYS call this before answering ANY question about a number, KPI, or trend — never invent metrics.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/metrics`,
    });
    if (!result.ok) return fail(`query_metrics failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

const getCredits: McpToolDefinition = {
  tool: {
    name: 'baget_get_credits',
    description:
      "Read the founder's current credit balance — total + breakdown across daily, treasury, and purchased pools. Use this BEFORE answering ANY question about credits, balance, budget, spending capacity, or affordability — \"how much do I have?\", \"can I afford to launch the batch?\", \"am I running low?\", \"what's my balance?\". Also call it BEFORE proposing an action that costs credits, so you can warn the founder if they'd run dry. NEVER hallucinate the number; this tool is the only source of truth that matches what the dashboard shows.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/credits`,
    });
    if (!result.ok) return fail(`get_credits failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

const listRecentActivity: McpToolDefinition = {
  tool: {
    name: 'baget_list_recent_activity',
    description:
      "Read the founder's recent activity feed — the same rows the dashboard's activity timeline shows. Use this BEFORE answering questions about what the team has been doing — \"what did the team ship today?\", \"what happened yesterday?\", \"what has Louis been working on?\", \"any progress?\", \"what's new?\". Returns the most recent 25 founder-visible items (debug rows already filtered out, messages already sanitized for founder eyes). NEVER make up activity. If the feed is empty, say so honestly — empty is information.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const result = await bagetFetch<{ activity?: unknown }>({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/recent-activity`,
    });
    if (!result.ok) return fail(`list_recent_activity failed: ${result.error}`);
    // Unwrap the `{ activity: [...] }` envelope so the model gets just
    // the array. Mirrors `baget_read_document`'s `{ document }` unwrap
    // pattern. Saves tokens in the agent's context window — the
    // envelope key is metadata the agent doesn't need. Falls back to
    // the raw payload if the upstream shape ever changes (better to
    // surface unfamiliar JSON than to hide it under a defensive null).
    const inner =
      result.data && typeof result.data === 'object' && 'activity' in result.data
        ? (result.data as { activity: unknown }).activity
        : result.data;
    return ok(JSON.stringify(inner, null, 2));
  },
};

const listDocuments: McpToolDefinition = {
  tool: {
    name: 'baget_list_documents',
    description:
      'List the founder\'s documents — business plan, brand guide, pitch deck, research, etc. Returns id, title, category, and createdAt for each. Call this first before referring to a specific document by name; never guess document ids. After listing, the next step depends on what the founder wants: call `baget_read_document` with the chosen document\'s id to fetch the markdown body and quote it INLINE in your reply (good for "what\'s in the BP?", "summarize the brand guide"); call `baget_send_document_file` with the chosen document\'s id to ship the actual FILE attachment (good for "send me the deck", "share the BP as a PDF").',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const result = await bagetFetch({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/documents`,
    });
    if (!result.ok) return fail(`list_documents failed: ${result.error}`);
    return ok(JSON.stringify(result.data, null, 2));
  },
};

const readDocument: McpToolDefinition = {
  tool: {
    name: 'baget_read_document',
    description:
      'Fetch the markdown body of a single document so you can QUOTE OR SUMMARIZE its content INLINE in your reply. Use when the founder asks about WHAT a document SAYS — "what\'s in the BP?", "summarize the brand guide", "read me the deck\'s problem section", "what\'s the positioning?". Pairs with `baget_send_document_file` (which ships the actual file attachment) — pick THIS tool when the founder wants to discuss content, pick `baget_send_document_file` when they want to receive the file itself ("send me the deck", "give me the BP as a PDF"). Call `baget_list_documents` FIRST to resolve a name (e.g., \'pitch deck\') to a documentId; never guess document ids.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          format: 'uuid',
          description: 'UUID of the document to read; resolve via baget_list_documents.',
        },
      },
      required: ['documentId'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);
    const documentId = String(args.documentId ?? '').trim();
    if (!documentId) return fail('documentId is required');
    // encodeURIComponent on the model-supplied id — a hallucinated `..`
    // or `/` would otherwise change the request path semantics before
    // the server's UUID guard could reject it cleanly.
    const result = await bagetFetch<{ document?: unknown }>({
      method: 'GET',
      path: `/api/companies/${ctx.companyId}/documents/${encodeURIComponent(documentId)}`,
    });
    if (!result.ok) return fail(`read_document failed: ${result.error}`);
    // Unwrap the `{ document: ... }` envelope so the model gets just the
    // document object, not the wrapper. Saves tokens in the agent's
    // context window (Gemini medium on PR #12). Falls back to the raw
    // payload if the upstream shape ever changes — better to surface
    // unfamiliar JSON than to hide it under a defensive null.
    const inner =
      result.data && typeof result.data === 'object' && 'document' in result.data
        ? (result.data as { document: unknown }).document
        : result.data;
    return ok(JSON.stringify(inner, null, 2));
  },
};

// ── FILE TRANSFER tool ──────────────────────────────────────────────────────

/**
 * Telegram (and Slack/Discord) impose a hard upper bound on attachment
 * size — Telegram bots cap at 50 MB. Library docs render to single-digit
 * MB PDFs in practice, but a stray very-long document plus images could
 * push past that. We surface a clean error rather than letting the host
 * channel adapter fail silently after the file is on disk.
 */
const MAX_ATTACHMENT_BYTES = 45 * 1024 * 1024;

/**
 * Render-pdf timing budget. The server's Next.js route is `maxDuration =
 * 30s` (set in render-pdf/route.ts), and a cold-start path (pdfkit
 * dynamic import + a long markdown body + Vercel Blob upload) can
 * realistically use most of that. Give the channel-side fetch a bit more
 * headroom so we time out AFTER the server gives up rather than racing
 * it — racing produces a misleading "client aborted" instead of a clean
 * upstream error message.
 */
const RENDER_PDF_TIMEOUT_MS = 45_000;

/**
 * Blob fetch is a separate hop from /render-pdf. Vercel Blob is fast
 * (cached at the edge) but a freshly-uploaded blob can take a beat to
 * propagate. 30s is generous; in practice these complete in <500ms.
 */
const BLOB_FETCH_TIMEOUT_MS = 30_000;

/**
 * Vercel Blob storage hostname — the only public host the agent should
 * follow when fetching a render-pdf response. Locking the destination
 * closes the SSRF hole that would otherwise let a compromised baget.ai
 * redirect the agent to internal services (e.g. AWS metadata IP) by
 * crafting an arbitrary `blobUrl` in the response.
 *
 * Pattern: hostname must end in `.public.blob.vercel-storage.com` (the
 * subdomain is the storage account suffix). Production blobs always
 * land under that domain — see the route's `put({ access: "public" })`
 * call. If we ever switch storage backends this allowlist needs to
 * change in lockstep.
 */
const ALLOWED_BLOB_HOST_SUFFIX = '.public.blob.vercel-storage.com';

const sendDocumentFile: McpToolDefinition = {
  tool: {
    name: 'baget_send_document_file',
    description:
      'Send a document to the founder as a real downloadable FILE attachment. ONLY TWO OUTPUT FORMATS ARE SUPPORTED: PDF (for markdown docs — server-side render via pdfkit) and the ORIGINAL media format (for image/video docs). HTML, DOCX, slide-deck (.key/.pptx), and other formats ARE NOT SUPPORTED — there is no other rendering tool. If the founder asks for a non-PDF format, tell them: (a) the dashboard at BAGET_API_BASE_URL/dashboard/<companyId>/documents renders the HTML version of decks natively in the browser, and (b) you can send a PDF instead. NEVER attempt to convert documents using shell utilities (npx marked / pandoc / wkhtmltopdf / similar via the Bash tool) — the container does not have npm-registry access or these binaries; the attempt will fail and the founder will see a confusing "still encountering an issue" loop. Use when the founder asks to RECEIVE the document as a file: "send me the deck", "can you send the BP", "share the brand guide as a file", "give me the pitch deck PDF". Pairs with `baget_read_document` (which quotes content inline) — pick THIS tool when the founder wants the actual file they can forward, save, or print; pick `baget_read_document` when they want to discuss / summarize / quote the content. Call `baget_list_documents` FIRST to resolve a name (e.g. \'pitch deck\') to a documentId. Lands in the same chat thread as the conversation — no "to" parameter needed.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          format: 'uuid',
          description: 'UUID of the document to send; resolve via baget_list_documents.',
        },
        text: {
          type: 'string',
          maxLength: 1000,
          description:
            'Optional one-line caption to send with the file ("Here\'s the deck — let me know which sections you want expanded.").',
        },
      },
      required: ['documentId'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const ctx = requireCompanyId();
    if (!ctx.ok) return fail(ctx.error);

    const documentId = String(args.documentId ?? '').trim();
    if (!documentId) return fail('documentId is required');

    // 1. Ask baget.ai to render the document to a downloadable artifact.
    //    Markdown docs become PDFs; image/video docs return their existing
    //    media URL directly. Either way the response shape is the same:
    //    { blobUrl, blobKey, filename, mimeType }. The route is bearer-aware
    //    via the same hybrid-auth pattern as the LIST + per-doc routes.
    //    encodeURIComponent neutralizes a hallucinated path traversal in
    //    the model-supplied id. Render needs a longer timeout than the
    //    default — see RENDER_PDF_TIMEOUT_MS comment.
    const render = await bagetFetch<{ blobUrl: string; filename: string; mimeType: string }>({
      method: 'POST',
      path: `/api/companies/${ctx.companyId}/documents/${encodeURIComponent(documentId)}/render-pdf`,
      timeoutMs: RENDER_PDF_TIMEOUT_MS,
    });
    if (!render.ok) return fail(`send_document_file failed: ${render.error}`);
    // Null-check before destructuring — `bagetFetch` returns
    // `data: null` on an empty / non-JSON response body even when
    // `ok: true` (Gemini medium on PR #13). Without this guard the
    // destructure throws an uncaught TypeError and crashes the runner.
    if (!render.data || typeof render.data !== 'object') {
      return fail('send_document_file got an empty or non-JSON response from /render-pdf');
    }
    const { blobUrl, filename } = render.data;
    if (!blobUrl || !filename) {
      return fail('send_document_file got an unexpected response from /render-pdf (missing blobUrl or filename)');
    }

    // 2. SSRF defense — only follow URLs hosted on Vercel Blob's public
    //    storage domain. Without this guard, a compromised baget.ai
    //    could craft a `blobUrl` pointing at internal infrastructure
    //    (e.g. AWS instance metadata, Railway service mesh) and the
    //    agent would dutifully fetch and ship the response. URL parsing
    //    must happen BEFORE the fetch so we never even open the
    //    connection to a disallowed host.
    let parsedBlobUrl: URL;
    try {
      parsedBlobUrl = new URL(blobUrl);
    } catch {
      return fail(`send_document_file got an invalid blobUrl from /render-pdf: ${blobUrl}`);
    }
    if (parsedBlobUrl.protocol !== 'https:' || !parsedBlobUrl.hostname.endsWith(ALLOWED_BLOB_HOST_SUFFIX)) {
      return fail(
        `send_document_file refused to fetch a blobUrl outside the allowed Vercel Blob domain (host=${parsedBlobUrl.hostname}).`,
      );
    }

    // 3. Resolve the destination — always reply in-place (the founder's
    //    current chat thread). No `to` parameter exposed to the agent;
    //    this is a 1:1 channel surface, not a fan-out tool.
    const routing = resolveRouting(undefined);
    if ('error' in routing) return fail(routing.error);

    // 4. Pull the bytes from the validated blob URL. Vercel Blob URLs
    //    are public-read by design (the dashboard's LibraryPicker uses
    //    the same URLs unauthenticated); the URL itself is the capability.
    //
    //    OOM defense (Codex P1 + Gemini security-medium on PR #13):
    //    enforce the size cap BEFORE buffering. A two-step check —
    //    (a) Content-Length pre-check rejects a known-too-large response
    //        without buffering at all (fast path, the usual case);
    //    (b) streaming check during arrayBuffer aborts mid-read on a
    //        stream that omits or lies about Content-Length.
    //    `arrayBuffer()` alone would happily allocate the entire body
    //    into memory before our `buffer.length > MAX` check ran, which
    //    on a malicious 5GB response would OOM the runner and kill the
    //    container before any clean error message could surface.
    let buffer: Buffer;
    try {
      const blobRes = await fetch(parsedBlobUrl, { signal: AbortSignal.timeout(BLOB_FETCH_TIMEOUT_MS) });
      if (!blobRes.ok) {
        return fail(`send_document_file failed to fetch the rendered file (HTTP ${blobRes.status})`);
      }

      // (a) Pre-check Content-Length when present.
      const contentLengthHeader = blobRes.headers.get('content-length');
      if (contentLengthHeader !== null) {
        const declaredBytes = Number(contentLengthHeader);
        if (Number.isFinite(declaredBytes) && declaredBytes > MAX_ATTACHMENT_BYTES) {
          return fail(
            `send_document_file: rendered file is ${(declaredBytes / 1024 / 1024).toFixed(1)} MB, ` +
              `over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB chat-attachment limit. ` +
              `Tell the founder to download from the dashboard.`,
          );
        }
      }

      // (b) Stream the body into a buffer with a running size cap. The
      //     reader is aborted as soon as accumulated bytes exceed the
      //     cap, so a stream that omits Content-Length OR lies about
      //     it (advertised < cap, actual >> cap) still can't OOM us.
      const reader = blobRes.body?.getReader();
      if (!reader) {
        // No body stream — fall back to arrayBuffer which is bounded
        // by the cap-check we'd do post-buffer (small responses only).
        const arr = await blobRes.arrayBuffer();
        if (arr.byteLength > MAX_ATTACHMENT_BYTES) {
          return fail(
            `send_document_file: rendered file is ${(arr.byteLength / 1024 / 1024).toFixed(1)} MB, ` +
              `over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB chat-attachment limit. ` +
              `Tell the founder to download from the dashboard.`,
          );
        }
        buffer = Buffer.from(arr);
      } else {
        const chunks: Buffer[] = [];
        let total = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > MAX_ATTACHMENT_BYTES) {
            await reader.cancel();
            return fail(
              `send_document_file: rendered file is over the ` +
                `${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB chat-attachment limit. ` +
                `Tell the founder to download from the dashboard.`,
            );
          }
          chunks.push(Buffer.from(value));
        }
        buffer = Buffer.concat(chunks);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`send_document_file failed to fetch the rendered file: ${msg}`);
    }

    // 5. Stage the file in the per-message outbox dir (same shape the
    //    core `send_file` tool uses — the host channel adapter scans
    //    this layout and ships the file via Telegram sendDocument /
    //    Slack files.upload / etc.). `path.basename` strips any path
    //    separators in case a broken server-side slugifier ever leaks
    //    `..` or `/`; the empty-string / dot-only check below catches
    //    `"./"` and `""` which basename returns as-is.
    const id = generateId();
    const outboxDir = path.join(workspaceOutboxDir(), id);
    const safeFilename = path.basename(filename);
    if (!safeFilename || safeFilename === '.' || safeFilename === '..') {
      return fail(`send_document_file got an unusable filename from /render-pdf: ${JSON.stringify(filename)}`);
    }
    const stagedPath = path.join(outboxDir, safeFilename);
    try {
      fs.mkdirSync(outboxDir, { recursive: true });
      fs.writeFileSync(stagedPath, buffer);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`send_document_file failed to stage the attachment locally: ${msg}`);
    }

    // 5. Enqueue the outbound message using the path-based attachments
    //    contract (PR #18 / `OutboundAttachment`) — the only contract the
    //    Telegram adapter's deliver() loop reads. The legacy `content.files`
    //    contract is buffer-based and never wired to Telegram, so a
    //    messages_out row that only sets `files` ships nothing and the
    //    founder sees an empty reply (this was the original bug). Caption
    //    rides WITH the file (Telegram's sendDocument supports up to 1024
    //    chars of caption); `text` left empty so we don't also fire a
    //    separate sendMessage for the same content. The model still emits
    //    its own conversational follow-up via `send_message` if it wants.
    const captionText = typeof args.text === 'string' ? args.text.trim() : '';
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({
        text: '',
        attachments: [
          {
            kind: 'document',
            path: stagedPath,
            filename: safeFilename,
            ...(captionText ? { caption: captionText } : {}),
          },
        ],
      }),
    });

    log(`send_document_file: ${id} → ${routing.resolvedName} (${safeFilename}, ${buffer.length} bytes)`);
    return ok(`Sent ${safeFilename} (${(buffer.length / 1024).toFixed(0)} KB).`);
  },
};

// ── GENERATE tools ──────────────────────────────────────────────────────────

/**
 * Test seam — production passes a freshly-built Google GenAI client at
 * tool-call time; tests inject a stub via `_setImageGenDeps` so the real
 * Gemini API never gets pinged from CI.
 */
let imageGenDeps: GenerateImageDeps = {};

/** Test-only — reset between tests via `_setImageGenDeps({})`. */
export function _setImageGenDeps(deps: GenerateImageDeps): void {
  imageGenDeps = deps;
}

/** A simple per-image-extension → mime-type map used to derive a safe
 *  filename. Keep in sync with what Imagen actually returns (PNG by
 *  default in our config). */
function extensionFromMime(mime: string): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    default:
      return 'png';
  }
}

/** Slug a free-form prompt into a filesystem-safe basename so the
 *  founder sees `pitch-mockup-vela-{ts}.png` instead of `image-{id}.png`.
 *  Length-bounded so the host's outbox path never exceeds the FS limit. */
function slugFromPrompt(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'image';
}

const generateImage: McpToolDefinition = {
  tool: {
    name: 'baget_generate_image',
    description:
      "Generate an image from a text prompt and ship it to the founder as a real photo attachment. Use when the founder asks for a logo / mockup / illustration / 'show me what X could look like' / 'make me an image of Y'. Conversational scratchwork — does NOT save to the founder's brand library (point them at the dashboard if they want a saved asset). Caption rides with the image. Picks Imagen 3 by default; override via env. The model may refuse some prompts (people / brands / NSFW) — surface the error, suggest a reword.",
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: 2000,
          description:
            'Text prompt for the image. Be specific about style, composition, color, and subject — Imagen rewards detail.',
        },
        aspectRatio: {
          type: 'string',
          enum: ['1:1', '3:4', '4:3', '9:16', '16:9'],
          description:
            'Optional aspect ratio. Default 1:1 (square — safest across channels). Use 9:16 for story / portrait, 16:9 for landscape / cover, 4:3 or 3:4 for in-between.',
        },
        text: {
          type: 'string',
          maxLength: 1000,
          description:
            'Optional caption rendered with the image (Telegram + WhatsApp support up to ~1024 chars). Often empty — the image speaks for itself.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) return fail('prompt is required');

    const aspectRatio = (args.aspectRatio as AspectRatio | undefined) ?? '1:1';

    // Generate FIRST — if Gemini fails or refuses the prompt, we want
    // to surface that BEFORE doing any filesystem or DB work. Avoids
    // the "outbox dir created, then nothing landed" debugging confusion.
    const result = await generateImageBytes({ prompt, aspectRatio }, imageGenDeps);
    if (!result.ok) return fail(`generate_image failed: ${result.error}`);

    // Resolve destination — always reply in-place, no `to` arg exposed.
    const routing = resolveRouting(undefined);
    if ('error' in routing) return fail(routing.error);

    const id = generateId();
    const outboxDir = path.join(workspaceOutboxDir(), id);
    const ext = extensionFromMime(result.mimeType);
    const filename = `${slugFromPrompt(prompt)}.${ext}`;
    const stagedPath = path.join(outboxDir, filename);
    try {
      fs.mkdirSync(outboxDir, { recursive: true });
      fs.writeFileSync(stagedPath, result.bytes);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`generate_image failed to stage the image locally: ${msg}`);
    }

    // Path-based attachments contract — same as send_document_file.
    // `kind: 'photo'` so the Telegram adapter routes through
    // sendBagetBotPhoto (renders inline) instead of sendBagetBotDocument
    // (renders as file card). Founders want the visual immediately.
    const captionText = typeof args.text === 'string' ? args.text.trim() : '';
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({
        text: '',
        attachments: [
          {
            kind: 'photo',
            path: stagedPath,
            filename,
            ...(captionText ? { caption: captionText } : {}),
          },
        ],
      }),
    });

    log(`generate_image: ${id} → ${routing.resolvedName} (${filename}, ${result.bytes.length} bytes)`);
    return ok(`Generated and sent ${filename} (${(result.bytes.length / 1024).toFixed(0)} KB).`);
  },
};

// ── WRITE tools (direct — no approval card needed) ────────────────────────────

const setDirection: McpToolDefinition = {
  tool: {
    name: 'baget_set_direction',
    description:
      'Save the founder\'s direction for the next batch. Use when the founder says "set direction to focus on X", "I want us to prioritize Y", "pivot toward Z". Direction-save does NOT plan a new batch by itself; the founder will say "launch the batch" separately. APPROVAL-GATED — the channel surface confirms direction-set with the founder before persisting (no credit cost, but the direction shapes every subsequent batch and the founder should see what they\'re committing to). On first call set `confirmed: false` to surface the preview; on the founder\'s explicit confirmation word, call again with `confirmed: true` and the IDENTICAL payload. Distill founder intent into 1-2 clear sentences; don\'t echo verbatim.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', minLength: 1, maxLength: 2000 },
        confirmed: {
          type: 'boolean',
          description:
            'Default false (preview). Set true ONLY after the founder explicitly confirms with a word like "yes" / "go" / "approve". Repeating the original "set direction to X" message is NOT a confirmation.',
        },
      },
      required: ['direction'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const direction = String(args.direction ?? '').trim();
    if (!direction || direction.length > 2000) return fail('direction must be 1–2000 chars');
    return dispatchApproval({
      action: 'set-direction',
      payload: { direction },
      confirmed: args.confirmed === true,
      summary: `Set the founder direction to: "${direction.slice(0, 80)}${direction.length > 80 ? '…' : ''}"`,
    });
  },
};

const updateMetric: McpToolDefinition = {
  tool: {
    name: 'baget_update_metric',
    description:
      'Update an existing business metric\'s current value OR start tracking a brand-new metric. Use when the founder says "waitlist is at 142 now", "we\'re at 30 signups", "start tracking MRR, currently $1.2k". Updates if the label matches an active metric (case-insensitive); otherwise adds a new metric (max 3 active). RUNS IMMEDIATELY (free).',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', minLength: 1, maxLength: 80 },
        current: { type: 'number' },
        unit: { type: 'string', maxLength: 24 },
        target: { type: 'number' },
      },
      required: ['label', 'current'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'update-metric',
      payload: {
        label: String(args.label),
        current: Number(args.current),
        ...(args.unit !== undefined ? { unit: String(args.unit) } : {}),
        ...(args.target !== undefined ? { target: Number(args.target) } : {}),
      },
      fallbackMessage: `Updated ${args.label}.`,
    });
  },
};

const archiveMetric: McpToolDefinition = {
  tool: {
    name: 'baget_archive_metric',
    description:
      'Archive an active metric — frees a slot under the 3-active-metric cap. Use when the founder says "stop tracking X", "retire the waitlist metric", "archive Y". Match by label (case-insensitive). RUNS IMMEDIATELY (free).',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', minLength: 1, maxLength: 80 },
        reason: { type: 'string', maxLength: 200 },
      },
      required: ['label'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'archive-metric',
      payload: {
        label: String(args.label),
        ...(args.reason !== undefined ? { reason: String(args.reason) } : {}),
      },
      fallbackMessage: `Archived ${args.label}.`,
    });
  },
};

const addMetricHistory: McpToolDefinition = {
  tool: {
    name: 'baget_add_metric_history',
    description:
      'Backfill a historical data point on an existing active metric. Use when the founder volunteers a PAST value: "we hit 50 signups last Monday", "MRR was $800 in October". Different from update_metric — this only touches the chart history, not current. Distill date phrases into ISO 8601 (use founder timezone from get_company_overview). RUNS IMMEDIATELY (free).',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', minLength: 1, maxLength: 80 },
        value: { type: 'number' },
        checkedAt: { type: 'string', description: 'ISO 8601 datetime of the observation' },
      },
      required: ['label', 'value'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'add-metric-history',
      payload: {
        label: String(args.label),
        value: Number(args.value),
        ...(args.checkedAt !== undefined ? { checkedAt: String(args.checkedAt) } : {}),
      },
      fallbackMessage: `History added for ${args.label}.`,
    });
  },
};

const setMetricTarget: McpToolDefinition = {
  tool: {
    name: 'baget_set_metric_target',
    description:
      'Update only the TARGET on an existing active metric — leaves current and history untouched. Use when the founder raises or lowers a goal: "waitlist goal is 500 now", "bump MRR target to $5k". Match by label (case-insensitive). RUNS IMMEDIATELY (free).',
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', minLength: 1, maxLength: 80 },
        target: { type: 'number', exclusiveMinimum: 0 },
      },
      required: ['label', 'target'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'set-metric-target',
      payload: { label: String(args.label), target: Number(args.target) },
      fallbackMessage: `Target updated for ${args.label}.`,
    });
  },
};

const addTask: McpToolDefinition = {
  tool: {
    name: 'baget_add_task',
    description:
      'Add a task to the current open batch. Use when the founder says "add a task to ship the pricing page", "we need to do X", "make sure to Y". Pick the right agent role from the topic (developer for code/site, marketing for campaigns, analyst for research/data, design for visuals, ops for infra/legal/business, chief-of-staff for strategy/planning). RUNS IMMEDIATELY — credits only deduct when the batch actually launches. RESPONSE includes `[taskId=<uuid>]` — REMEMBER this UUID; if the founder immediately says "run it" / "kick it off" / "start it" you pass that exact taskId to baget_run_task. STRIP `[taskId=…]` from your reply to the founder (it\'s an internal handle, not user-facing).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', maxLength: 4000 },
        agentRole: {
          type: 'string',
          enum: ['chief-of-staff', 'developer', 'marketing', 'analyst', 'design', 'ops', 'intern'],
        },
      },
      required: ['title', 'agentRole'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'add-task',
      payload: {
        title: String(args.title),
        agentRole: String(args.agentRole),
        ...(args.description !== undefined ? { description: String(args.description) } : {}),
      },
      fallbackMessage: `Task added.`,
    });
  },
};

const parkTask: McpToolDefinition = {
  tool: {
    name: 'baget_park_task',
    description:
      'Park a task — moves a backlog task out of the active batch so the worker won\'t pick it up. Use when the founder says "X is no longer a priority", "drop the Y task", "park Z". Call list_recent_batches FIRST to find the matching taskId. RUNS IMMEDIATELY (free).',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', format: 'uuid' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'park-task',
      payload: { taskId: String(args.taskId) },
      fallbackMessage: `Task parked.`,
    });
  },
};

const cancelRunningTasks: McpToolDefinition = {
  tool: {
    name: 'baget_cancel_running_tasks',
    description:
      'Out-of-hours killswitch — stops ALL running work for the company. Use when the founder says "stop the work", "halt everything", "cancel the running tasks", "pause the run". Errors any in-flight tasks (no credit waste — credits only deduct on completion) and reverts queued tasks to backlog. Company status flips to "paused" — founder says "launch the batch" to resume. RUNS IMMEDIATELY (free). DIFFERENT from park_task (single backlog task) — this is the stop-everything-now hammer.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    return dispatchDirect({
      action: 'cancel-running-task',
      payload: {},
      fallbackMessage: `All running work stopped.`,
    });
  },
};

const approvePending: McpToolDefinition = {
  tool: {
    name: 'baget_approve_pending',
    description:
      'Approve the current pending cycle proposal — the CoS-suggested next batch direction. Use when the founder says "approve the plan", "go with the proposal", "sounds good, approve it". RUNS IMMEDIATELY — merges proposal direction into stored direction, no credit cost. Founder still says "launch the batch" separately to actually plan tasks.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    return dispatchDirect({
      action: 'approve-pending',
      payload: {},
      fallbackMessage: `Plan approved.`,
    });
  },
};

const rejectPending: McpToolDefinition = {
  tool: {
    name: 'baget_reject_pending',
    description:
      'Reject the current pending cycle proposal — silent decline. Use when the founder says "reject the plan", "no thanks", "we\'re not going that direction", "decline". RUNS IMMEDIATELY — clears the pending proposal without merging direction. No credit cost.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  async handler() {
    return dispatchDirect({
      action: 'reject-pending',
      payload: {},
      fallbackMessage: `Plan rejected.`,
    });
  },
};

const pauseAd: McpToolDefinition = {
  tool: {
    name: 'baget_pause_ad',
    description:
      'Pause a running Meta ad campaign. Use when the founder says "pause the ad", "stop the campaign", "halt the launch ad". Optional campaignNameOrId (case-insensitive substring match on name); omit if there\'s only one running campaign. RUNS IMMEDIATELY (free — Meta does the cost accounting).',
    inputSchema: {
      type: 'object',
      properties: {
        campaignNameOrId: { type: 'string', minLength: 1, maxLength: 200 },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'pause-ad',
      payload: args.campaignNameOrId !== undefined ? { campaignNameOrId: String(args.campaignNameOrId) } : {},
      fallbackMessage: `Ad campaign paused.`,
    });
  },
};

const resumeAd: McpToolDefinition = {
  tool: {
    name: 'baget_resume_ad',
    description:
      'Resume a paused Meta ad campaign. Use when the founder says "resume the ad", "start the campaign back up", "unpause the launch ad". Same name-resolution rules as pause_ad (optional name; ambiguity asks for clarification). RUNS IMMEDIATELY (free).',
    inputSchema: {
      type: 'object',
      properties: {
        campaignNameOrId: { type: 'string', minLength: 1, maxLength: 200 },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchDirect({
      action: 'resume-ad',
      payload: args.campaignNameOrId !== undefined ? { campaignNameOrId: String(args.campaignNameOrId) } : {},
      fallbackMessage: `Ad campaign resumed.`,
    });
  },
};

// ── WRITE tools (approval-gated) ─────────────────────────────────────────────

const runTask: McpToolDefinition = {
  tool: {
    name: 'baget_run_task',
    description:
      'Run ONE specific task right now — same as the founder tapping the per-task "Run" button on the dashboard. PREFER THIS over baget_launch_batch when the founder refers to a single task ("can you run THIS task", "run the competitor research one", "kick off task X"). Use baget_launch_batch only when the founder explicitly asks for "the batch", "all tasks", "everything queued". WHERE TO GET taskId: (a) the `[taskId=<uuid>]` suffix from the most recent baget_add_task response (use this when the founder JUST asked to add the task and now wants to run it — no extra calls needed), or (b) baget_get_company_overview which returns `tasks: [{ id, title, agentRole, status }]`. DO NOT use baget_list_recent_activity — that returns activity_log row IDs which are NOT task IDs. APPROVAL-GATED: first call returns the per-task cost preview ("X credits, you have Y remaining"); second call with confirmed: true actually enqueues.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          format: 'uuid',
          description: 'The UUID of the task to run. Sources, in order of preference: (a) the `[taskId=<uuid>]` suffix in the most recent baget_add_task response (when the founder JUST asked to add and now wants to run it — no extra calls needed), or (b) baget_get_company_overview which returns `tasks: [{ id, title, agentRole, status }]`. DO NOT use baget_list_recent_activity — it returns activity_log row IDs, NOT task IDs.',
        },
        confirmed: {
          type: 'boolean',
          description:
            'Set true ONLY after the founder has explicitly confirmed (e.g., "yes", "go ahead", "approve"). On the first call, omit or pass false to get the cost preview.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchApproval({
      action: 'run-task',
      payload: { taskId: String(args.taskId) },
      confirmed: args.confirmed === true,
      summary: 'Run this task — enqueues it now and the assigned specialist starts working.',
    });
  },
};

const launchBatch: McpToolDefinition = {
  tool: {
    name: 'baget_launch_batch',
    description:
      'Launch the ENTIRE backlog batch — same as the founder tapping "Run All" on the dashboard. Queues EVERY backlog task for the current batch. ONLY use when the founder explicitly asks for "the batch", "all tasks", "run everything", "kick off the batch". For a single task, use baget_run_task INSTEAD. APPROVAL-GATED: first call returns cost preview ("X credits, ~Y tasks"); second call (with confirmed: true) actually launches. Show the cost to the founder verbatim, ask them to confirm, then re-call.',
    inputSchema: {
      type: 'object',
      properties: {
        confirmed: {
          type: 'boolean',
          description:
            'Set true ONLY after the founder has explicitly confirmed (e.g., "yes", "go ahead", "approve"). On the first call, omit or pass false to get the cost preview.',
        },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchApproval({
      action: 'launch-batch',
      payload: {},
      confirmed: args.confirmed === true,
      summary: 'Launch the current batch — queues every backlog task and the team starts working.',
    });
  },
};

const editDocument: McpToolDefinition = {
  tool: {
    name: 'baget_edit_document',
    description:
      'Rewrite a specific document with founder-provided instructions. Kicks off a single rewrite task that runs IMMEDIATELY (skips the "wait for batch launch" detour). Use when the founder says "rewrite the BP for enterprise", "update the brand guide with the new colors", "shorten the pitch deck". Call list_documents FIRST. APPROVAL-GATED — costs credits because the worker runs the rewrite as a real task.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string', format: 'uuid' },
        instructions: { type: 'string', minLength: 1, maxLength: 2000 },
        confirmed: { type: 'boolean' },
      },
      required: ['documentId', 'instructions'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchApproval({
      action: 'edit-document',
      payload: {
        documentId: String(args.documentId),
        instructions: String(args.instructions),
      },
      confirmed: args.confirmed === true,
      summary: `Rewrite the document with: ${String(args.instructions).slice(0, 80)}…`,
    });
  },
};

const revealProspect: McpToolDefinition = {
  tool: {
    name: 'baget_reveal_prospect',
    description:
      'Reveal email addresses for N prospects from the most-recent discovery search. Use when the founder says "reveal 10 leads", "unlock 20 prospects", "get me emails for the next 5". Costs 1 credit per SUCCESSFUL email match — fewer than `count` may be returned if some prospects have no matchable contact. APPROVAL-GATED — the cost preview shows the worst-case credit charge (= count) before the founder confirms. Cap is 100 from chat (vs 500 from dashboard) to limit runaway spends. WHEN RELAYING THE RESULT to the founder, ALWAYS state the actual reveal count vs the requested count — e.g. "Revealed 2 of the 3 you asked for (1 prospect had no matchable contact). Charged 2 credits." Never report the requested count as if it were the result; mismatch reads as a bug.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 100 },
        confirmed: { type: 'boolean' },
      },
      required: ['count'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const count = Number(args.count);
    return dispatchApproval({
      action: 'reveal-prospect',
      payload: { count },
      confirmed: args.confirmed === true,
      summary: `Reveal up to ${count} prospect email${count === 1 ? '' : 's'} (1 credit each on success).`,
    });
  },
};

const sendCampaign: McpToolDefinition = {
  tool: {
    name: 'baget_send_campaign',
    description:
      'Send a draft email campaign — atomically claims the draft and queues it for delivery via Resend. Use when the founder says "send the welcome series", "fire the August newsletter", "send the campaign". If only one draft exists, the name is optional; otherwise pass the substring match. APPROVAL-GATED — sending is irreversible. Recipient count comes back on the cost preview so the founder isn\'t surprised. NO baget credit cost (Resend bills per email separately).',
    inputSchema: {
      type: 'object',
      properties: {
        campaignNameOrId: { type: 'string', minLength: 1, maxLength: 200 },
        confirmed: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  async handler(args) {
    return dispatchApproval({
      action: 'send-campaign',
      payload: args.campaignNameOrId !== undefined ? { campaignNameOrId: String(args.campaignNameOrId) } : {},
      confirmed: args.confirmed === true,
      summary: args.campaignNameOrId
        ? `Send "${String(args.campaignNameOrId)}" to all eligible recipients.`
        : `Send the draft email campaign to all eligible recipients.`,
    });
  },
};

// ── Register ─────────────────────────────────────────────────────────────────

registerTools([
  // Read
  getCompanyOverview,
  queryMetrics,
  getCredits,
  listRecentActivity,
  listDocuments,
  readDocument,
  // File transfer
  sendDocumentFile,
  // Generate
  generateImage,
  // Write — direct
  setDirection,
  updateMetric,
  archiveMetric,
  addMetricHistory,
  setMetricTarget,
  addTask,
  parkTask,
  cancelRunningTasks,
  approvePending,
  rejectPending,
  pauseAd,
  resumeAd,
  // Write — approval-gated
  launchBatch,
  runTask,
  editDocument,
  revealProspect,
  sendCampaign,
]);

log(
  'baget MCP tools registered: 6 read + 1 file-transfer + 1 generate + 12 direct write + 5 approval-gated = 25 total',
);
