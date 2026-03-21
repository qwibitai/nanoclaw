/**
 * grafana_annotate tool
 *
 * Create or query annotations on Grafana dashboards. Annotations mark
 * events (deployments, incidents, config changes) that correlate with
 * metric changes visible on dashboards.
 */

import { jsonResult, readStringParam, readNumberParam } from "openclaw/plugin-sdk";
import { GrafanaClient, parseDateMathToMs } from "../grafana-client.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";

/**
 * Resolve a time parameter that may be epoch ms (number) or a Grafana
 * relative time string like "now-7d" (string).  Returns epoch ms.
 */
export function resolveTimeParam(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "string") return parseDateMathToMs(value);
  return undefined;
}

/** Default comparison window: 30 minutes on each side of the annotation. */
const DEFAULT_COMPARISON_WINDOW_MS = 30 * 60 * 1000;

export type ComparisonHint = {
  beforeWindow: { from: string; to: string };
  afterWindow: { from: string; to: string };
  suggestion: string;
};

/**
 * Build a comparisonHint for an annotation creation response.
 *
 * Provides ready-to-use time ranges for before/after comparison with
 * `grafana_query`, eliminating manual time math for the agent.
 *
 * For region annotations (time → timeEnd), the "before" window ends at
 * `time` and the "after" window starts at `timeEnd`. For point annotations,
 * both windows are symmetric around the annotation time.
 *
 * The `afterWindow.to` is capped at "now" if the annotation is recent.
 */
export function buildComparisonHint(
  time: number,
  timeEnd: number | undefined,
  windowMs: number = DEFAULT_COMPARISON_WINDOW_MS,
): ComparisonHint {
  const now = Date.now();

  const beforeFrom = time - windowMs;
  const beforeTo = time;

  const afterStart = timeEnd ?? time;
  const afterFrom = afterStart;
  const afterTo = Math.min(afterStart + windowMs, now);

  return {
    beforeWindow: {
      from: new Date(beforeFrom).toISOString(),
      to: new Date(beforeTo).toISOString(),
    },
    afterWindow: {
      from: new Date(afterFrom).toISOString(),
      to: new Date(afterTo).toISOString(),
    },
    suggestion:
      "Use grafana_query with these time ranges to compare metrics before vs. after. " +
      "Example: run the same PromQL expression twice with from/to set to each window.",
  };
}

export function createAnnotateToolFactory(config: ValidatedGrafanaLensConfig) {
  const client = new GrafanaClient({
    url: config.grafana.url,
    apiKey: config.grafana.apiKey,
    orgId: config.grafana.orgId,
  });

  return (_ctx: unknown) => ({
    name: "grafana_annotate",
    label: "Grafana Annotate",
    description: [
      "Create or list annotations on Grafana dashboards.",
      "WORKFLOW: Use 'create' to mark events (deployments, incidents, config changes).",
      "Use 'list' to query recent events. Annotations appear as vertical lines on dashboards.",
      "Time params accept epoch ms OR relative strings: 'now', 'now-1h', 'now-7d', 'now-30m'.",
      "Tags help categorize — e.g., 'deploy', 'incident', 'config-change'.",
      "Create response includes comparisonHint with ready-to-use before/after time windows for grafana_query — no manual time math needed.",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["create", "list"],
          description: "Action to perform. Default: 'create'",
        },
        text: {
          type: "string",
          description: "Annotation text (required for create). E.g., 'Deployed v2.1.0'",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Tags for the annotation (e.g., ['deploy', 'production'])",
        },
        dashboardUid: {
          type: "string",
          description: "Scope annotation to a specific dashboard (optional)",
        },
        panelId: {
          type: "number",
          description: "Scope annotation to a specific panel (optional)",
        },
        time: {
          type: ["number", "string"],
          description:
            "Annotation timestamp — epoch ms (e.g., 1700000000000) or relative string (e.g., 'now-2h'). Default: now",
        },
        timeEnd: {
          type: ["number", "string"],
          description:
            "End timestamp for region annotations — epoch ms or relative string (e.g., 'now'). Creates a time range highlight",
        },
        from: {
          type: ["number", "string"],
          description:
            "Query start time (for 'list') — epoch ms or relative string (e.g., 'now-7d', 'now-24h')",
        },
        to: {
          type: ["number", "string"],
          description:
            "Query end time (for 'list') — epoch ms or relative string (e.g., 'now'). Default: now",
        },
        limit: {
          type: "number",
          description: "Maximum annotations to return (for 'list' action). Default: 20",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const action = readStringParam(params, "action") ?? "create";
      const tags = (params.tags as string[]) ?? [];

      try {
        if (action === "list") {
          const from = resolveTimeParam(params.from);
          const to = resolveTimeParam(params.to);
          const dashboardUid = readStringParam(params, "dashboardUid");
          const panelId = readNumberParam(params, "panelId");
          const limit = readNumberParam(params, "limit") ?? 20;

          const annotations = await client.getAnnotations({
            from,
            to,
            dashboardUID: dashboardUid,
            panelId,
            tags: tags.length > 0 ? tags : undefined,
            limit,
          });

          return jsonResult({
            status: "success",
            count: annotations.length,
            annotations: annotations.map((a) => ({
              id: a.id,
              text: a.text,
              tags: a.tags,
              time: new Date(a.time).toISOString(),
              timeEnd: a.timeEnd ? new Date(a.timeEnd).toISOString() : undefined,
              dashboardUID: a.dashboardUID || undefined,
              panelId: a.panelId || undefined,
            })),
          });
        }

        // Create annotation
        const text = readStringParam(params, "text", { required: true, label: "Annotation text" });
        const dashboardUid = readStringParam(params, "dashboardUid");
        const panelId = readNumberParam(params, "panelId");
        const time = resolveTimeParam(params.time) ?? Date.now();
        const timeEnd = resolveTimeParam(params.timeEnd);

        const result = await client.createAnnotation({
          text,
          tags,
          dashboardUID: dashboardUid,
          panelId,
          time,
          timeEnd,
        });

        return jsonResult({
          status: "created",
          id: result.id,
          message: `Annotation created: "${text}"`,
          time: new Date(time).toISOString(),
          comparisonHint: buildComparisonHint(time, timeEnd),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `Annotation ${action} failed: ${reason}` });
      }
    },
  });
}
