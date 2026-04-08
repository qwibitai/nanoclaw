/**
 * Typed fetch client for /dashboard/api/*.
 *
 * All endpoints are read-only GETs. There are no write wrappers — the
 * dashboard is strictly a viewer in v1. Any future write surface has
 * to thread through nanoclaw's iOS HTTP channel separately and is not
 * the frontend's concern.
 *
 * The security boundary for report HTML rendering lives here: this
 * file is the ONLY place in dashboard-web that mints a SanitizedHtml
 * value, via `fetchReport()`. Any other code path that needs to render
 * HTML in the DOM must either (a) accept `SanitizedHtml` (which means
 * the server sanitized it), or (b) use React's normal escaping via
 * JSX text children. No client-side markdown libraries are permitted
 * in dashboard-web/ — see types.ts header for the allowlist rationale.
 */

import type {
  DevTask,
  Ingredients,
  MealPlan,
  MealsResponse,
  Report,
  ReportMeta,
  SanitizedHtml,
  ScheduledTask,
  VaultGraph,
} from "@/types";

/**
 * Small fetch wrapper. Throws a typed error on non-2xx so caller's
 * catch can surface the status + body in the error UI. Trusts the
 * shape of the JSON response at the type level — the server side of
 * /dashboard/api/* is a fixed contract and we mirror its types in
 * types.ts; if the server drifts the mirror drifts.
 *
 * Adds a 15-second timeout via AbortController so a wedged request
 * (Mac Mini stalled, Tailscale dropped mid-flight, handler hangs)
 * surfaces as an error state instead of an indefinite skeleton.
 */
const REQUEST_TIMEOUT_MS = 15_000;

async function request<T>(path: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ApiError(res.status, res.statusText, body);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly body: string;

  constructor(status: number, statusText: string, body: string) {
    super(`${status} ${statusText}: ${body || "(empty body)"}`);
    this.name = "ApiError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

// --- Endpoint wrappers ------------------------------------------------

export async function fetchVaultGraph(): Promise<VaultGraph> {
  return request<VaultGraph>("/dashboard/api/graph");
}

export async function fetchDevTasks(): Promise<{ tasks: DevTask[] }> {
  return request<{ tasks: DevTask[] }>("/dashboard/api/devtasks");
}

export async function fetchScheduledTasks(): Promise<{ tasks: ScheduledTask[] }> {
  return request<{ tasks: ScheduledTask[] }>("/dashboard/api/tasks");
}

export async function fetchReports(): Promise<{ reports: ReportMeta[] }> {
  return request<{ reports: ReportMeta[] }>("/dashboard/api/reports");
}

/**
 * Fetch a single report by id. The server returns `body_html` as a
 * plain JSON string, but it has been run through
 * `renderReportMarkdown()` → sanitize-html with a narrow allowlist.
 * We mint the SanitizedHtml brand here — this is the ONLY place in
 * dashboard-web that does so, and the only place that tells the type
 * system "trust me, this HTML came from the server sanitizer".
 *
 * Do not add string manipulation between fetch and this cast. If the
 * server's shape ever changes, update both the server pipeline AND
 * this cast in the same change.
 */
export async function fetchReport(id: string): Promise<Report> {
  // Raw shape from the server, unbranded.
  type RawReport = Omit<Report, "body_html"> & { body_html: string };
  const raw = await request<RawReport>(
    `/dashboard/api/reports/${encodeURIComponent(id)}`,
  );
  return {
    ...raw,
    body_html: raw.body_html as SanitizedHtml,
  };
}

export async function fetchMeals(): Promise<MealsResponse> {
  return request<MealsResponse>("/dashboard/api/meals");
}

// Re-export for convenience at call sites.
export type { MealPlan, Ingredients };
