/**
 * Domain type mirrors for the FamBot dashboard SPA.
 *
 * These are hand-maintained TypeScript mirrors of the server-side
 * types that nanoclaw exposes through /dashboard/api/*. The source of
 * truth for each type lives in the nanoclaw server tree:
 *
 *   - VaultNode, VaultEdge  → nanoclaw/src/channels/vault-reader.ts
 *   - DevTask, DevTaskStatus → nanoclaw/src/dev-tasks.ts (Zod schema)
 *   - ScheduledTask          → nanoclaw/src/types.ts
 *   - ReportMeta, Report     → nanoclaw/src/reports.ts
 *   - MealPlan, Ingredients  → nanoclaw/src/channels/meal-plan-page.ts
 *
 * Intentionally duplicated, not imported via TypeScript project
 * references. The duplication cost is one file kept in sync; the
 * alternative (cross-project references between a CommonJS server and
 * an ESM client bundler) is more complex than the duplication is
 * painful at this scale. If a server type changes, update the mirror
 * here in the same PR that changes the server shape.
 *
 * SECURITY NOTE: report body HTML is server-sanitized (see
 * nanoclaw/src/channels/dashboard-report-render.ts — marked +
 * sanitize-html with a narrow allowlist). The client consumes the
 * rendered HTML as the branded `SanitizedHtml` type and renders it
 * via dangerouslySetInnerHTML. The client MUST NOT import any
 * markdown or sanitization library (marked, markdown-it, react-
 * markdown, dompurify, sanitize-html) — the sanitizer stays in one
 * place on the server.
 */

// --- Branded SanitizedHtml --------------------------------------------
//
// A string that has been sanitized on the server. Only api.ts is
// allowed to mint values of this type (via the fetchReport cast). The
// `unique symbol` tag makes it impossible to construct a SanitizedHtml
// value from a plain string anywhere else without an explicit cast
// that would stand out in code review.
//
// ReportBody.tsx accepts `html: SanitizedHtml` in its props, so any
// accidental attempt to pipe a raw `string` through it becomes a
// compile-time error.

declare const sanitizedHtmlBrand: unique symbol;
export type SanitizedHtml = string & { readonly [sanitizedHtmlBrand]: true };

// --- Vault (knowledge graph) -----------------------------------------

export interface VaultNode {
  id: string;
  label: string;
  domain: string;
  type: "moc" | "node";
  description: string;
  updated: string;
  updated_by: string;
  durability: string;
  content: string;
}

export interface VaultEdge {
  source: string;
  target: string;
}

export interface VaultGraph {
  nodes: VaultNode[];
  edges: VaultEdge[];
}

// --- Dev Tasks --------------------------------------------------------

export const DEV_TASK_STATUSES = [
  "open",
  "working",
  "pr_ready",
  "done",
  "needs_session",
  "has_followups",
] as const;

export type DevTaskStatus = (typeof DEV_TASK_STATUSES)[number];

export interface DevTask {
  id: number;
  title: string;
  description: string;
  status: DevTaskStatus;
  created_at: string;
  updated_at: string;
  source: "fambot" | "chat" | "claude-code" | "claude";
  pr_url?: string;
  branch?: string;
  session_notes?: string;
}

// --- Scheduled tasks (cron) ------------------------------------------

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: "cron" | "interval" | "once";
  schedule_value: string;
  context_mode: "group" | "isolated";
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: "active" | "paused" | "completed";
  created_at: string;
}

// --- Reports ----------------------------------------------------------

export interface ReportMeta {
  id: string;
  title: string;
  summary: string;
  created_at: string;
  created_by: string;
}

/**
 * Report detail — same fields as ReportMeta plus the server-rendered
 * sanitized HTML body. `body_html` is branded as SanitizedHtml so
 * ReportBody can safely render it via dangerouslySetInnerHTML.
 */
export interface Report extends ReportMeta {
  body_html: SanitizedHtml;
}

// --- Meal plan --------------------------------------------------------

export interface MealRecipeLink {
  // NOTE: server emits `title` (see nanoclaw/src/channels/meal-plan-page.ts
  // RecipeLink interface). Keep this field name in sync; do not rename to
  // `label` without changing the server side too.
  title: string;
  url: string;
}

export interface Meal {
  label: string;
  desc: string;
  details: string[];
  recipes: MealRecipeLink[];
}

export interface MealDay {
  name: string;
  meals: Meal[];
}

export interface MealPlan {
  title: string;
  subtitle: string | null;
  days: MealDay[];
}

export interface IngredientsSection {
  name: string;
  items: string[];
}

export interface Ingredients {
  title: string;
  sections: IngredientsSection[];
}

export interface MealsResponse {
  plan: MealPlan | null;
  ingredients: Ingredients | null;
}
