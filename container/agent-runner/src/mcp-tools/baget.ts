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
 *   READ (4 today; full set lands once the corresponding GET routes
 *   ship on baget.ai — see the spawned follow-up):
 *     - baget_get_company_overview
 *     - baget_query_metrics
 *     - baget_list_documents
 *     - baget_read_document
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

function getCompanyId(): string | null {
  return process.env.BAGET_COMPANY_ID ?? null;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

interface BagetFetchArgs {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

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
  const token = getChannelToken();
  if (!token) {
    return {
      ok: false,
      status: 0,
      error:
        'BAGET_CHANNEL_TOKEN missing. Container is not authenticated to baget.ai. Re-pair the channel from the Baget dashboard.',
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
    signal: AbortSignal.timeout(15_000),
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
async function dispatchApproval(args: {
  action: string;
  payload: Record<string, unknown>;
  confirmed: boolean;
  summary: string;
}) {
  const ctx = requireCompanyId();
  if (!ctx.ok) return fail(ctx.error);

  if (!args.confirmed) {
    // Cost preview — show the founder what they'd be approving.
    const preview = await bagetFetch<{
      ok: boolean;
      cost: { amount: number; remaining: number; tasksRemaining: number; disabledReason?: string };
    }>({
      method: 'POST',
      path: `/api/companies/${ctx.companyId}/approval/preview`,
      body: { action: args.action, payload: args.payload },
    });
    if (!preview.ok) return fail(`${args.action} preview failed: ${preview.error}`);

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

    return ok(
      JSON.stringify({
        status: 'approval-pending',
        summary: args.summary,
        cost: {
          amount: cost.amount,
          remaining: cost.remaining,
          tasksRemaining: cost.tasksRemaining,
        },
        note: 'Show the founder the summary + cost. Ask them to confirm by replying "yes" / "go" / "approve" — or "no" / "cancel". On confirmation, call this same tool with `confirmed: true` and the IDENTICAL payload.',
      }),
    );
  }

  // Founder confirmed — actually execute.
  const result = await bagetFetch<{ ok: boolean; messageForFounder?: string }>({
    method: 'POST',
    path: `/api/companies/${ctx.companyId}/approval/execute`,
    body: { action: args.action, payload: args.payload },
  });
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

const listDocuments: McpToolDefinition = {
  tool: {
    name: 'baget_list_documents',
    description:
      "List the founder's documents — business plan, brand guide, pitch deck, research, etc. Returns id, title, category, and createdAt for each. Call this first before referring to a specific document by name; never guess document ids. After listing, call `baget_read_document` with the chosen document's id to fetch its full content (e.g., when the founder asks to see, share, or send it).",
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
      "Fetch the full content (markdown body) of a single document by id. Use this whenever the founder asks to SEE, SHARE, SEND, READ, VIEW, OR QUOTE a specific document — pitch deck, business plan, brand guide, research, etc. The chat surface can't transfer files, so this tool is how you 'send' a document: read it, then quote or excerpt the body inline in your reply. Call `baget_list_documents` FIRST to resolve a name (e.g., 'pitch deck') to a documentId; never guess document ids. If the founder wants the document as a downloadable file (PDF, etc.), point them to the dashboard's documents tab.",
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

// ── WRITE tools (direct — no approval card needed) ────────────────────────────

const setDirection: McpToolDefinition = {
  tool: {
    name: 'baget_set_direction',
    description:
      'Save the founder\'s direction for the next batch. Use when the founder says "set direction to focus on X", "I want us to prioritize Y", "pivot toward Z". Direction-save does NOT plan a new batch by itself; the founder will say "launch the batch" separately. RUNS IMMEDIATELY (free). Distill founder intent into 1-2 clear sentences; don\'t echo verbatim.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', minLength: 1, maxLength: 2000 },
      },
      required: ['direction'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const direction = String(args.direction ?? '').trim();
    if (!direction || direction.length > 2000) return fail('direction must be 1–2000 chars');
    return dispatchDirect({
      action: 'set-direction',
      payload: { direction },
      fallbackMessage: `Direction saved: ${direction.slice(0, 80)}.`,
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
      'Add a task to the current open batch. Use when the founder says "add a task to ship the pricing page", "we need to do X", "make sure to Y". Pick the right agent role from the topic (developer for code/site, marketing for campaigns, analyst for research/data, design for visuals, ops for infra/legal/business, chief-of-staff for strategy/planning). RUNS IMMEDIATELY — credits only deduct when the batch actually launches.',
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

const launchBatch: McpToolDefinition = {
  tool: {
    name: 'baget_launch_batch',
    description:
      'Launch the current backlog batch — same as the founder tapping "Run All" on the dashboard. APPROVAL-GATED: first call returns cost preview ("X credits, ~Y tasks"); second call (with confirmed: true) actually launches. Show the cost to the founder verbatim, ask them to confirm, then re-call.',
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
      'Reveal email addresses for N prospects from the most-recent discovery search. Use when the founder says "reveal 10 leads", "unlock 20 prospects", "get me emails for the next 5". Costs 1 credit per successful email match. APPROVAL-GATED — the cost preview shows the worst-case credit charge (= count) before the founder confirms. Cap is 100 from chat (vs 500 from dashboard) to limit runaway spends.',
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
  listDocuments,
  readDocument,
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
  editDocument,
  revealProspect,
  sendCampaign,
]);

log('baget MCP tools registered: 4 read + 12 direct write + 4 approval-gated = 20 total');
