/**
 * create-dashboard tool
 *
 * Registers an agent tool that creates Grafana dashboards from templates.
 * The agent calls this tool when a user asks for a dashboard.
 *
 * This tool wraps POST /api/dashboards/db with built-in templates
 * (llm-command-center, session-explorer, cost-intelligence, tool-performance)
 * or custom dashboard JSON.
 */

import { jsonResult, readStringParam } from "openclaw/plugin-sdk";
import { GrafanaClient } from "../grafana-client.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";
import { validateTargetQueries } from "./update-dashboard.js";
import type { QueryValidationEntry } from "./update-dashboard.js";

// Template names that ship with the extension
import llmCommandCenterTemplate from "../templates/llm-command-center.json" with { type: "json" };
import sessionExplorerTemplate from "../templates/session-explorer.json" with { type: "json" };
import costIntelligenceTemplate from "../templates/cost-intelligence.json" with { type: "json" };
import toolPerformanceTemplate from "../templates/tool-performance.json" with { type: "json" };
import nodeExporterTemplate from "../templates/node-exporter.json" with { type: "json" };
import httpServiceTemplate from "../templates/http-service.json" with { type: "json" };
import metricExplorerTemplate from "../templates/metric-explorer.json" with { type: "json" };
import multiKpiTemplate from "../templates/multi-kpi.json" with { type: "json" };
import sreOperationsTemplate from "../templates/sre-operations.json" with { type: "json" };
import genaiObservabilityTemplate from "../templates/genai-observability.json" with { type: "json" };
import weeklyReviewTemplate from "../templates/weekly-review.json" with { type: "json" };
import securityOverviewTemplate from "../templates/security-overview.json" with { type: "json" };

// Stable UIDs for AI templates — enables reliable cross-dashboard drill-down links
const AI_TEMPLATE_UIDS: Record<string, string> = {
  "llm-command-center": "openclaw-command-center",
  "session-explorer": "openclaw-session-explorer",
  "cost-intelligence": "openclaw-cost-intelligence",
  "tool-performance": "openclaw-tool-performance",
  "sre-operations": "openclaw-sre-operations",
  "genai-observability": "openclaw-genai-observability",
  "security-overview": "openclaw-security-overview",
};

// Template chaining — guides agent through natural deployment sequences
interface TemplateSuggestion {
  template: string;
  reason: string;
}

const TEMPLATE_SUGGESTIONS: Record<string, TemplateSuggestion[]> = {
  "llm-command-center": [
    { template: "session-explorer", reason: "Tier 2: drill into individual sessions with trace hierarchy" },
    { template: "cost-intelligence", reason: "Tier 3a: financial deep-dive with model attribution" },
    { template: "sre-operations", reason: "Tier 3c: queue health, webhooks, stuck sessions" },
  ],
  "session-explorer": [
    { template: "cost-intelligence", reason: "Tier 3a: correlate session behavior with cost impact" },
    { template: "tool-performance", reason: "Tier 3b: tool reliability and latency analytics" },
  ],
  "cost-intelligence": [
    { template: "tool-performance", reason: "Tier 3b: tool usage patterns driving costs" },
    { template: "sre-operations", reason: "Tier 3c: operational health and queue monitoring" },
  ],
  "tool-performance": [
    { template: "sre-operations", reason: "Tier 3c: operational health context for tool issues" },
    { template: "genai-observability", reason: "Industry-standard gen_ai monitoring" },
  ],
  "sre-operations": [
    { template: "genai-observability", reason: "Industry-standard gen_ai monitoring for broader AI ops" },
    { template: "security-overview", reason: "Security monitoring — injection signals, session anomalies, tool errors" },
  ],
  "genai-observability": [
    { template: "llm-command-center", reason: "Tier 1: OpenClaw-specific command center with session drill-down" },
  ],
  "node-exporter": [
    { template: "http-service", reason: "Complement system health with HTTP service monitoring" },
  ],
  "http-service": [
    { template: "node-exporter", reason: "Complement HTTP monitoring with system-level health" },
  ],
  "metric-explorer": [
    { template: "multi-kpi", reason: "Compare multiple metrics side-by-side" },
  ],
  "multi-kpi": [
    { template: "metric-explorer", reason: "Deep-dive into any single metric" },
  ],
  "weekly-review": [
    { template: "multi-kpi", reason: "Track specific KPIs alongside weekly trends" },
  ],
  "security-overview": [
    { template: "sre-operations", reason: "Complement security monitoring with operational health context" },
    { template: "llm-command-center", reason: "Tier 1 overview for broader system health alongside security" },
  ],
};

const TEMPLATES: Record<string, Record<string, unknown>> = {
  "llm-command-center": llmCommandCenterTemplate,
  "session-explorer": sessionExplorerTemplate,
  "cost-intelligence": costIntelligenceTemplate,
  "tool-performance": toolPerformanceTemplate,
  "sre-operations": sreOperationsTemplate,
  "genai-observability": genaiObservabilityTemplate,
  "node-exporter": nodeExporterTemplate,
  "http-service": httpServiceTemplate,
  "metric-explorer": metricExplorerTemplate,
  "multi-kpi": multiKpiTemplate,
  "weekly-review": weeklyReviewTemplate,
  "security-overview": securityOverviewTemplate,
};

// ── Custom dashboard validation ────────────────────────────────────────

type Panel = Record<string, unknown>;
type Target = { refId?: string; expr?: string; datasource?: { uid?: string; type?: string } };

/** Per-panel validation result for custom dashboards. */
export type PanelValidationDetail = {
  panelId: number;
  title: string;
  status: "ok" | "nodata" | "error" | "skipped";
  error?: string;
  queries?: QueryValidationEntry[];
};

/** Aggregate validation result across all panels. */
export type DashboardValidation = {
  panelsTotal: number;
  panelsValid: number;
  panelsNoData: number;
  panelsError: number;
  panelsSkipped: number;
  details: PanelValidationDetail[];
};

/** Grafana template variables (e.g., `${DS_PROMETHEUS}`) can't be used for API queries. */
function isTemplateVariable(uid: string): boolean {
  return uid.startsWith("${") && uid.endsWith("}");
}

/** Extract the first concrete datasource UID from a panel's targets or panel-level datasource. */
function firstUidFromPanel(panel: Panel): string | undefined {
  const targets = panel.targets as Target[] | undefined;
  if (targets) {
    for (const t of targets) {
      if (t.datasource?.uid && !isTemplateVariable(t.datasource.uid)) return t.datasource.uid;
    }
  }
  const ds = panel.datasource as { uid?: string } | undefined;
  if (ds?.uid && !isTemplateVariable(ds.uid)) return ds.uid;
  return undefined;
}

/** Find the first concrete datasource UID across all panels (computed once as a fallback). */
function findGlobalDatasourceUid(panels: Panel[]): string | undefined {
  for (const p of panels) {
    const uid = firstUidFromPanel(p);
    if (uid) return uid;
  }
  return undefined;
}

/**
 * Validate all panel PromQL queries in a custom dashboard.
 * Dry-runs each panel's expressions and reports per-panel health.
 * Never throws — individual panel failures are captured as error status.
 */
export async function validateDashboardPanels(
  client: GrafanaClient,
  panels: Panel[],
): Promise<DashboardValidation> {
  const panelsWithTargets = panels.filter((p) => {
    const targets = p.targets as Target[] | undefined;
    return targets && targets.some((t) => t.expr);
  });

  if (panelsWithTargets.length === 0) {
    return {
      panelsTotal: panels.length,
      panelsValid: 0,
      panelsNoData: 0,
      panelsError: 0,
      panelsSkipped: panels.length,
      details: [],
    };
  }

  // Pre-compute the global fallback datasource UID once (avoids O(P²) re-scanning)
  const globalFallbackDsUid = findGlobalDatasourceUid(panels);

  const details = await Promise.all(
    panelsWithTargets.map(async (panel): Promise<PanelValidationDetail> => {
      const panelId = (panel.id as number) ?? 0;
      const title = (panel.title as string) ?? "(untitled)";
      const targets = (panel.targets as Target[]).filter((t) => t.expr);
      const dsUid = firstUidFromPanel(panel) ?? globalFallbackDsUid;

      if (!dsUid) {
        return {
          panelId,
          title,
          status: "skipped",
          error: "No datasource UID found — set datasource.uid on targets",
        };
      }

      try {
        const validation = await validateTargetQueries(client, targets, dsUid);
        if (!validation.validated) {
          return { panelId, title, status: "skipped", error: validation.skippedReason };
        }

        const hasError = validation.results.some((r) => !r.valid);
        const hasData = validation.results.some(
          (r) => r.valid && r.sampleValue !== undefined,
        );

        let status: "ok" | "nodata" | "error";
        if (hasError) status = "error";
        else if (hasData) status = "ok";
        else status = "nodata";

        return {
          panelId,
          title,
          status,
          ...(hasError
            ? { error: validation.results.find((r) => !r.valid)?.error }
            : {}),
          queries: validation.results,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { panelId, title, status: "error", error: reason };
      }
    }),
  );

  // Single-pass count instead of four .filter() calls
  const counts = { ok: 0, nodata: 0, error: 0, skipped: 0 };
  for (const d of details) counts[d.status]++;

  return {
    panelsTotal: panels.length,
    panelsValid: counts.ok,
    panelsNoData: counts.nodata,
    panelsError: counts.error,
    panelsSkipped: counts.skipped + (panels.length - panelsWithTargets.length),
    details,
  };
}

export function createDashboardToolFactory(config: ValidatedGrafanaLensConfig) {
  const client = new GrafanaClient({
    url: config.grafana.url,
    apiKey: config.grafana.apiKey,
    orgId: config.grafana.orgId,
  });

  return (_ctx: unknown) => ({
    name: "grafana_create_dashboard",
    label: "Grafana Dashboard",
    description: [
      "Create or update a Grafana dashboard.",
      "WORKFLOW: 3-tier SRE drill-down hierarchy — start with 'llm-command-center' (Tier 1: golden signals, session table with click-to-drill-down).",
      "Drill into 'session-explorer' (Tier 2: per-session trace hierarchy, LLM calls, tool calls, conversation flow — THE killer feature).",
      "Deep dive: 'cost-intelligence' (Tier 3a: spending trends, model attribution, cache savings), 'tool-performance' (Tier 3b: tool reliability ranking, latency, error rates), 'sre-operations' (Tier 3c: queue health, webhooks, stuck sessions, tool loops).",
      "'security-overview' for security monitoring (injection signals, session anomalies, tool errors, webhook errors, cost spikes).",
      "'genai-observability' for industry-standard AI monitoring using OTel gen_ai semantic conventions — works with any gen_ai data, not just OpenClaw.",
      "'node-exporter' for system health (CPU/memory/disk), 'http-service' for HTTP golden signals (rate/errors/latency).",
      "'metric-explorer' to deep-dive any single metric, 'multi-kpi' for a 4-metric overview dashboard.",
      "'weekly-review' for weekly external data trends (calendar, fitness, finance) with an all-custom-metrics table.",
      "All AI templates have Loki log-to-trace correlation via Tempo + stable UIDs for cross-dashboard navigation.",
      "Can also accept custom dashboard JSON for fully custom dashboards. Custom JSON dashboards include a validation field that dry-runs each panel's PromQL — check validation.panelsError for broken queries.",
      "Returns the dashboard URL for sharing with the user.",
      "To modify the dashboard after creation (add/remove panels, change settings), use grafana_update_dashboard with the returned UID.",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        template: {
          type: "string",
          enum: Object.keys(TEMPLATES),
          description:
            "Name of a built-in template. AI observability (3-tier hierarchy): llm-command-center (Tier 1 system overview + session drill-down), session-explorer (Tier 2 per-session trace hierarchy), cost-intelligence (Tier 3a financial deep-dive), tool-performance (Tier 3b tool analytics), sre-operations (Tier 3c queue/webhook/session health). Security: security-overview (injection signals, session anomalies, tool errors, webhook errors, cost spikes). genai-observability (OTel gen_ai standard — industry-standard AI monitoring, works with any gen_ai data). System: node-exporter (CPU/memory/disk), http-service (RED signals). Generic: metric-explorer (any single metric), multi-kpi (any 4 metrics), weekly-review (weekly external data + all custom metrics table).",
        },
        title: {
          type: "string",
          description:
            "Custom dashboard title. Overrides the template default (e.g., 'My LLM Command Center').",
        },
        dashboard: {
          type: "object",
          description:
            "Full custom dashboard JSON (Grafana dashboard model). Use this instead of template for fully custom dashboards.",
        },
        folderUid: {
          type: "string",
          description:
            "UID of the Grafana folder to place the dashboard in (e.g., 'abc123'). Omit to use the default folder.",
        },
        overwrite: {
          type: "boolean",
          description: "Whether to overwrite if a dashboard with the same title exists.",
          default: true,
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const template = readStringParam(params, "template");
      const title = readStringParam(params, "title");
      const folderUid = readStringParam(params, "folderUid");
      const dashboard = params.dashboard as Record<string, unknown> | undefined;
      const overwrite = typeof params.overwrite === "boolean" ? params.overwrite : true;

      let dashboardJson: Record<string, unknown>;

      if (dashboard) {
        // Custom dashboard provided directly
        dashboardJson = dashboard;
      } else if (template && TEMPLATES[template]) {
        // Use built-in template
        dashboardJson = structuredClone(TEMPLATES[template]);
      } else if (template) {
        return jsonResult({
          error: `Unknown template '${template}'. Available: ${Object.keys(TEMPLATES).join(", ")}`,
        });
      } else {
        return jsonResult({
          error: `Either 'template' or 'dashboard' is required. Available templates: ${Object.keys(TEMPLATES).join(", ")}`,
        });
      }

      // Apply title override
      if (title) {
        dashboardJson.title = title;
      }

      // Assign stable UID for AI templates (enables cross-dashboard drill-down links)
      if (template && AI_TEMPLATE_UIDS[template]) {
        dashboardJson.uid = AI_TEMPLATE_UIDS[template];
      }

      // Ensure dashboard has no ID (so Grafana creates a new one or matches by title)
      delete dashboardJson.id;

      // Auto-assign sequential panel IDs where missing — Grafana does not auto-assign them,
      // and downstream tools (resolve-panel, update-dashboard) rely on panel.id for lookups.
      const panels = dashboardJson.panels as Array<Record<string, unknown>> | undefined;
      if (panels) {
        let nextId = 1;
        for (const p of panels) {
          if (p.id == null) {
            p.id = nextId;
          }
          if (typeof p.id === "number" && p.id >= nextId) {
            nextId = p.id + 1;
          }
        }
      }

      try {
        const result = await client.createDashboard({
          dashboard: dashboardJson,
          folderUid,
          message: "Created by Grafana Lens agent",
          overwrite,
        });

        const response: Record<string, unknown> = {
          uid: result.uid,
          url: client.dashboardUrl(result.uid),
          status: result.status,
          message: `Dashboard "${dashboardJson.title}" created successfully.`,
        };

        // Add template chaining hints for template-based dashboards
        if (template && TEMPLATE_SUGGESTIONS[template]) {
          response.suggestedNext = TEMPLATE_SUGGESTIONS[template];
        }

        // Custom dashboards: validate panel PromQL queries (informational — never blocks)
        if (dashboard) {
          try {
            const panels = (dashboardJson.panels as Panel[]) ?? [];
            const validation = await validateDashboardPanels(client, panels);
            if (validation.details.length > 0) {
              response.validation = validation;
            }
          } catch (validationErr) {
            // Validation failure is non-fatal — dashboard was already created.
            // Surface that validation was attempted but failed (not silently omitted).
            const reason = validationErr instanceof Error ? validationErr.message : String(validationErr);
            response.validation = { error: `Validation failed: ${reason}` };
          }
        }

        return jsonResult(response);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        if (reason.includes("Not found") && folderUid) {
          return jsonResult({ error: `Failed to create dashboard: folder '${folderUid}' not found. Omit folderUid to use the default folder, or check the folder UID.` });
        }
        return jsonResult({ error: `Failed to create dashboard: ${reason}` });
      }
    },
  });
}
