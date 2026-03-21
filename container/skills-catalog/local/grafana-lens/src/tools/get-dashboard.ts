/**
 * grafana_get_dashboard tool
 *
 * Returns a compact summary of a dashboard — panels, their types, and
 * the queries they run. Keeps agent context small (full dashboard JSON
 * can be huge) while giving enough info to compose workflows.
 *
 * The `audit` mode dry-runs each panel's queries against Grafana to
 * check which panels return data and which are broken — one tool call
 * replaces N separate grafana_query calls.
 */

import { jsonResult, readStringParam } from "openclaw/plugin-sdk";
import { GrafanaClient } from "../grafana-client.js";
import { getQueryCapability } from "./explore-datasources.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";
import type { DatasourceListItem } from "../grafana-client.js";

// ── Types ──────────────────────────────────────────────────────────────

type PanelHealth = {
  status: "ok" | "nodata" | "error" | "skipped";
  error?: string;
  sampleValue?: number;
};

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Resolve a panel's effective datasource UID.
 *
 * Dashboard panels reference datasources via `{ type, uid }` where uid
 * can be a template variable like `$prometheus`. We resolve these to
 * concrete UIDs by matching the variable's type against available
 * datasources.
 */
function resolveDatasourceUid(
  panelDs: unknown,
  datasources: DatasourceListItem[],
): { uid: string; type: string } | null {
  // No datasource specified — Grafana uses the default datasource
  if (!panelDs || typeof panelDs !== "object") {
    const def = datasources.find((d) => d.isDefault);
    return def ? { uid: def.uid, type: def.type } : null;
  }
  const ds = panelDs as Record<string, unknown>;
  const uid = ds.uid as string | undefined;
  const dsType = ds.type as string | undefined;
  if (!uid) return null;

  // Concrete UID — look up its type
  if (!uid.startsWith("$")) {
    const found = datasources.find((d) => d.uid === uid);
    return found ? { uid: found.uid, type: found.type } : (dsType ? { uid, type: dsType } : null);
  }

  // Template variable (e.g. $prometheus, $loki) — resolve by type
  if (dsType) {
    const found = datasources.find((d) => d.type === dsType);
    if (found) return { uid: found.uid, type: found.type };
  }

  return null;
}

/**
 * Replace Grafana template variables in PromQL/LogQL expressions with
 * wildcards so dry-run queries can match any label value.
 *
 * `$variable` and `${variable}` → `.*`
 * `$__range`, `$__rate_interval`, `$__interval` → `5m` (safe default)
 */
function replaceTemplateVars(expr: string): string {
  return expr
    .replace(/\$__(?:range|rate_interval|interval)/g, "5m")
    .replace(/\$\{[a-zA-Z_]\w*\}/g, ".*")
    .replace(/\$[a-zA-Z_]\w*/g, ".*");
}

/**
 * Check if a sanitized expression is unauditable — e.g. when a template
 * variable represented a metric name and was replaced with `.*`, which
 * is not valid PromQL/LogQL by itself.
 */
function isUnauditableExpr(sanitized: string): boolean {
  const trimmed = sanitized.trim();
  // Bare `.*` or wrapped in simple function like `rate(.*[5m])`
  if (trimmed === ".*") return true;
  if (/^\w+\(\.\*\[/.test(trimmed)) return true;
  return false;
}

/**
 * Dry-run a single panel's first query and classify the result.
 *
 * Bug fixes applied:
 * - LogQL: uses queryLokiRange (not instant) because Loki rejects pure
 *   log queries on the instant endpoint.
 * - Metric-name variables: detects when replaceTemplateVars produces an
 *   unauditable expression (e.g. bare `.*`) and skips instead of erroring.
 */
async function auditPanel(
  client: GrafanaClient,
  dsUid: string,
  dsType: string,
  expr: string,
): Promise<PanelHealth> {
  const cap = getQueryCapability(dsType);
  if (!cap.supported) {
    return { status: "skipped", error: `Unsupported datasource type: ${dsType}` };
  }

  const sanitized = replaceTemplateVars(expr);

  // Skip when variable replacement produces an unauditable expression
  if (isUnauditableExpr(sanitized)) {
    return { status: "skipped", error: "Expression depends on metric-name variable" };
  }

  try {
    if (cap.queryTool === "grafana_query") {
      const result = await client.queryPrometheus(dsUid, sanitized);
      const results = result.data?.result ?? [];
      if (results.length === 0) return { status: "nodata" };
      const firstVal = parseFloat(results[0].value[1]);
      return { status: "ok", sampleValue: isNaN(firstVal) ? undefined : firstVal };
    }

    // LogQL — use range query; Loki rejects log queries on instant endpoint
    const result = await client.queryLokiRange(dsUid, sanitized, "now-1h", "now", { limit: 1 });
    const entries = result.data?.result ?? [];
    if (entries.length === 0) return { status: "nodata" };
    return { status: "ok" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "error", error: msg };
  }
}

// ── Tool factory ───────────────────────────────────────────────────────

export function createGetDashboardToolFactory(config: ValidatedGrafanaLensConfig) {
  const client = new GrafanaClient({
    url: config.grafana.url,
    apiKey: config.grafana.apiKey,
    orgId: config.grafana.orgId,
  });

  return (_ctx: unknown) => ({
    name: "grafana_get_dashboard",
    label: "Get Dashboard",
    description: [
      "Get a summary of a Grafana dashboard.",
      "WORKFLOW: Use to inspect dashboard structure — find panel IDs for grafana_share_dashboard,",
      "understand what queries a dashboard uses, or verify a dashboard was created correctly.",
      "Set audit=true to dry-run each panel's queries and check which return data vs broken (replaces N separate grafana_query calls).",
      "Set compact=true when scanning multiple dashboards for overview (returns panel titles/types only, ~70% smaller).",
      "Omit both when you need full query details (before update or share).",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        uid: {
          type: "string",
          description: "Dashboard UID (from grafana_create_dashboard or grafana_search result)",
        },
        compact: {
          type: "boolean",
          description: "Return minimal response — panel titles and types only, no queries or metadata. Use when reviewing multiple dashboards for an overview. Default: false",
        },
        audit: {
          type: "boolean",
          description:
            "Dry-run each panel's PromQL/LogQL query and report health: ok (has data), nodata (empty), error (query failed), skipped (no query or unsupported datasource). Replaces calling grafana_query per panel. Default: false",
        },
      },
      required: ["uid"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const uid = readStringParam(params, "uid", { required: true, label: "Dashboard UID" });
      const compact = typeof params.compact === "boolean" ? params.compact : false;
      const audit = typeof params.audit === "boolean" ? params.audit : false;

      try {
        const data = await client.getDashboard(uid);
        const dashboard = data.dashboard as Record<string, unknown>;
        const meta = data.meta as Record<string, unknown> | undefined;

        const panels = (dashboard.panels as Array<Record<string, unknown>>) ?? [];

        const base = {
          status: "success" as const,
          uid: dashboard.uid ?? uid,
          title: dashboard.title as string,
          url: client.dashboardUrl(uid),
          tags: (dashboard.tags as string[]) ?? [],
          panelCount: panels.length,
        };

        // ── Compact mode ──────────────────────────────────────────────
        if (compact) {
          return jsonResult({
            ...base,
            panels: panels.map((p) => ({
              id: p.id as number,
              title: p.title as string,
              type: p.type as string,
            })),
          });
        }

        // ── Resolve datasources for audit ─────────────────────────────
        let datasources: DatasourceListItem[] = [];
        if (audit) {
          datasources = await client.listDatasources();
        }

        // ── Build panel summaries ─────────────────────────────────────
        const panelSummaries = panels.map((p) => {
          const targets = (p.targets as Array<Record<string, unknown>>) ?? [];
          return {
            id: p.id as number,
            title: p.title as string,
            type: p.type as string,
            queries: targets.map((t) => ({
              refId: t.refId as string,
              expr: (t.expr as string) ?? undefined,
            })).filter((q) => q.expr),
          };
        });

        // ── Audit mode: dry-run queries ───────────────────────────────
        let auditResults: Map<number, PanelHealth> | undefined;
        if (audit) {
          auditResults = new Map();

          const auditPromises = panelSummaries.map(async (panel, idx) => {
            // Skip panels with no queries (rows, text, etc.)
            if (panel.queries.length === 0) {
              auditResults!.set(panel.id, { status: "skipped" });
              return;
            }

            const resolved = resolveDatasourceUid(panels[idx].datasource, datasources);
            if (!resolved) {
              auditResults!.set(panel.id, {
                status: "skipped",
                error: "Could not resolve datasource",
              });
              return;
            }

            // Audit the first query (representative of panel health)
            const firstExpr = panel.queries[0].expr!;
            const health = await auditPanel(client, resolved.uid, resolved.type, firstExpr);
            auditResults!.set(panel.id, health);
          });

          await Promise.allSettled(auditPromises);
        }

        // ── Build response ────────────────────────────────────────────
        const responsePanels = panelSummaries.map((panel) => ({
          ...panel,
          ...(auditResults ? { health: auditResults.get(panel.id) ?? { status: "skipped" as const } } : {}),
        }));

        const response: Record<string, unknown> = {
          ...base,
          description: (dashboard.description as string) ?? undefined,
          time: (dashboard.time as Record<string, unknown>) ?? undefined,
          refresh: (dashboard.refresh as string) ?? undefined,
          panels: responsePanels,
          folderUid: (meta?.folderUid as string) ?? undefined,
          created: (meta?.created as string) ?? undefined,
          updated: (meta?.updated as string) ?? undefined,
        };

        // Add audit summary when auditing
        if (auditResults) {
          const counts = { ok: 0, nodata: 0, error: 0, skipped: 0 };
          for (const h of auditResults.values()) counts[h.status]++;
          response.auditSummary = counts;
        }

        return jsonResult(response);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `Failed to get dashboard: ${reason}` });
      }
    },
  });
}
