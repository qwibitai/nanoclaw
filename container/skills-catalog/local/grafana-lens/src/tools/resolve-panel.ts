/**
 * Panel query resolution utility.
 *
 * Extracts the query expression and datasource from an existing dashboard
 * panel, so grafana_query / grafana_query_logs can re-run it with different
 * time ranges without the agent navigating panel JSON manually.
 */

import { GrafanaClient } from "../grafana-client.js";
import { getQueryCapability } from "./explore-datasources.js";
import type { DatasourceListItem } from "../grafana-client.js";

// ── Types ──────────────────────────────────────────────────────────────

export type ResolvedPanelQuery = {
  expr: string;
  datasourceUid: string;
  datasourceType: string;
  queryTool: "grafana_query" | "grafana_query_logs" | "grafana_query_traces";
  panelTitle: string;
  panelType: string;
  /** Template variable values replaced with .* for broad matching */
  templateVarsReplaced: boolean;
};

export type PanelResolveError = {
  error: string;
};

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Resolve a panel's effective datasource UID.
 *
 * Panel datasource references can be:
 * - Concrete: `{ type: "prometheus", uid: "abc123" }`
 * - Template variable: `{ type: "prometheus", uid: "$prometheus" }`
 * - Missing/default: `null` or `{}` (uses Grafana's default datasource)
 */
function resolveDatasourceUid(
  panelDs: unknown,
  datasources: DatasourceListItem[],
): { uid: string; type: string } | null {
  if (!panelDs || typeof panelDs !== "object") {
    // No datasource specified — use the first available Prometheus datasource as default
    const defaultDs = datasources.find((d) => d.isDefault) ?? datasources.find((d) => d.type === "prometheus");
    return defaultDs ? { uid: defaultDs.uid, type: defaultDs.type } : null;
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
 * Replace Grafana template variables in expressions with wildcards.
 * Returns whether any replacements were made.
 *
 * `$__range`, `$__rate_interval`, `$__interval` → `5m` (safe default)
 * `$variable` and `${variable}` → `.*` (match any label value)
 */
function replaceTemplateVars(expr: string): { result: string; replaced: boolean } {
  let replaced = false;
  const result = expr
    .replace(/\$__(?:range|rate_interval|interval)/g, () => { replaced = true; return "5m"; })
    .replace(/\$\{[a-zA-Z_]\w*\}/g, () => { replaced = true; return ".*"; })
    .replace(/\$[a-zA-Z_]\w*/g, () => { replaced = true; return ".*"; });
  return { result, replaced };
}

// ── Main resolution function ───────────────────────────────────────────

/**
 * Resolve a dashboard panel's query expression and datasource.
 *
 * Fetches the dashboard, finds the panel by ID, extracts `targets[0].expr`,
 * resolves the datasource UID (handling template variables), and determines
 * which query tool to use based on datasource type.
 */
export async function resolvePanelQuery(
  client: GrafanaClient,
  dashboardUid: string,
  panelId: number,
): Promise<ResolvedPanelQuery | PanelResolveError> {
  // Fetch dashboard and datasources in parallel
  let dashboard: Record<string, unknown>;
  let datasources: DatasourceListItem[];
  try {
    const [dashData, dsList] = await Promise.all([
      client.getDashboard(dashboardUid),
      client.listDatasources(),
    ]);
    dashboard = dashData.dashboard as Record<string, unknown>;
    datasources = dsList;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { error: `Dashboard '${dashboardUid}' not found: ${reason}` };
  }

  // Find panel
  const panels = (dashboard.panels as Array<Record<string, unknown>>) ?? [];
  const panel = panels.find((p) => p.id === panelId);
  if (!panel) {
    const availableIds = panels.map((p) => `${p.id} (${p.title})`).join(", ");
    return {
      error: `Panel ${panelId} not found in dashboard '${dashboardUid}'. Available panels: ${availableIds}`,
    };
  }

  // Extract query expression
  const targets = (panel.targets as Array<Record<string, unknown>>) ?? [];
  const firstTarget = targets[0];
  if (!firstTarget) {
    return {
      error: `Panel ${panelId} ('${panel.title}') has no query targets. It may be a text/row panel.`,
    };
  }

  const rawExpr = (firstTarget.expr as string) ?? (firstTarget.query as string);
  if (!rawExpr) {
    return {
      error: `Panel ${panelId} ('${panel.title}') has no 'expr' or 'query' in its first target.`,
    };
  }

  // Resolve datasource from panel config against known datasources
  const resolved = resolveDatasourceUid(panel.datasource, datasources);
  if (!resolved) {
    return {
      error: `Could not resolve datasource for panel ${panelId} ('${panel.title}'). Use grafana_explore_datasources to find the correct datasourceUid and pass it explicitly.`,
    };
  }

  // Determine query tool
  const cap = getQueryCapability(resolved.type);
  if (!cap.supported) {
    return {
      error: `Panel ${panelId} uses datasource type '${resolved.type}' which is not supported by grafana_query, grafana_query_logs, or grafana_query_traces. Use Grafana UI to view this panel.`,
    };
  }

  // Replace template variables
  const { result: expr, replaced } = replaceTemplateVars(rawExpr);

  return {
    expr,
    datasourceUid: resolved.uid,
    datasourceType: resolved.type,
    queryTool: cap.queryTool as "grafana_query" | "grafana_query_logs" | "grafana_query_traces",
    panelTitle: (panel.title as string) ?? "Untitled",
    panelType: (panel.type as string) ?? "unknown",
    templateVarsReplaced: replaced,
  };
}
