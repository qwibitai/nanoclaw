/**
 * grafana_create_alert tool
 *
 * Creates Grafana-native alert rules via the Unified Alerting provisioning API.
 * The agent composes PromQL conditions — Grafana's alerting engine evaluates
 * them on schedule and notifies via configured contact points.
 *
 * Auto-creates a "Grafana Lens Alerts" folder if no folderUid is specified.
 *
 * Before creating the rule, the expression is dry-run against the datasource
 * to validate it. The result is included as `metricValidation` in the response.
 * The alert is always created regardless — the metric may not have data yet.
 */

import { jsonResult, readStringParam, readNumberParam } from "openclaw/plugin-sdk";
import { GrafanaClient } from "../grafana-client.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";

/** Metric validation result from dry-running the expression before alert creation. */
export type MetricValidation = {
  valid: boolean;
  error?: string;
  sampleValue?: number;
};

const DEFAULT_FOLDER_TITLE = "Grafana Lens Alerts";
const DEFAULT_RULE_GROUP = "grafana-lens";

/** Valid evaluation modes for alert expressions. */
export type EvaluationMode = "instant" | "rate" | "increase";

/**
 * Wrap a PromQL expression based on the evaluation mode.
 *
 * - `instant`: returns expression as-is (raw value comparison)
 * - `rate`: wraps in `rate(expr[window])` — per-second rate of a counter
 * - `increase`: wraps in `increase(expr[window])` — total increase over window
 */
export function wrapExpression(expr: string, evaluation: EvaluationMode, window: string): string {
  switch (evaluation) {
    case "rate":
      return `rate(${expr}[${window}])`;
    case "increase":
      return `increase(${expr}[${window}])`;
    case "instant":
      return expr;
  }
}

export function createAlertToolFactory(config: ValidatedGrafanaLensConfig) {
  const client = new GrafanaClient({
    url: config.grafana.url,
    apiKey: config.grafana.apiKey,
    orgId: config.grafana.orgId,
  });

  /** Get or create the default alert folder. */
  async function ensureFolder(folderUid?: string): Promise<string> {
    if (folderUid) return folderUid;

    // Try to find existing folder
    const folders = await client.listFolders();
    const existing = folders.find((f) => f.title === DEFAULT_FOLDER_TITLE);
    if (existing) return existing.uid;

    // Create it
    try {
      const folder = await client.createFolder({ title: DEFAULT_FOLDER_TITLE });
      return folder.uid;
    } catch (err) {
      // 409 = already exists (race condition) — list again
      if (err instanceof Error && err.message.includes("409")) {
        const retry = await client.listFolders();
        const found = retry.find((f) => f.title === DEFAULT_FOLDER_TITLE);
        if (found) return found.uid;
      }
      throw err;
    }
  }

  /**
   * Dry-run a PromQL expression to validate it returns data.
   * Never throws — returns a MetricValidation result.
   */
  async function validateExpression(datasourceUid: string, expr: string): Promise<MetricValidation> {
    try {
      const result = await client.queryPrometheus(datasourceUid, expr);
      const first = result.data.result[0];
      if (first) {
        return { valid: true, sampleValue: Number(first.value[1]) };
      }
      return { valid: false, error: "Expression returned no data — metric may not exist or has no recent samples" };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { valid: false, error: reason };
    }
  }

  return (_ctx: unknown) => ({
    name: "grafana_create_alert",
    label: "Grafana Alert",
    description: [
      "Create a Grafana alert rule on any Prometheus metric.",
      "WORKFLOW: Agent sets up monitoring autonomously. Grafana evaluates the condition",
      "on schedule and notifies via configured contact points (email, Slack, etc.).",
      "Requires datasourceUid (use grafana_explore_datasources) and a PromQL expression.",
      "IMPORTANT: For counter metrics (*_total), use evaluation='rate' for per-second rates",
      "or evaluation='increase' for total change over a window. Never compare raw counter",
      "values — they always increase and will immediately breach any threshold.",
      "Auto-creates a 'Grafana Lens Alerts' folder if no folderUid is provided.",
      "For the agent to receive alert notifications, first run grafana_check_alerts with action 'setup' to create the webhook contact point.",
      "The expression is dry-run before creation — response includes metricValidation: {valid, error?, sampleValue?} and datasourceUid. Alert is always created regardless (metric may not have data yet).",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        title: {
          type: "string",
          description: "Alert rule name (e.g., 'High Daily Cost')",
        },
        datasourceUid: {
          type: "string",
          description: "UID of the Prometheus datasource",
        },
        expr: {
          type: "string",
          description: "PromQL expression — the base metric or expression to evaluate (e.g., 'openclaw_lens_daily_cost_usd'). For counter metrics, provide the raw metric name and set evaluation='rate' or 'increase' — the tool wraps it automatically.",
        },
        threshold: {
          type: "number",
          description: "Threshold value to compare against",
        },
        evaluation: {
          type: "string",
          enum: ["instant", "rate", "increase"],
          description: "How to evaluate the expression. 'instant': raw value (default, for gauges). 'rate': wraps in rate(expr[window]) for per-second rate of counters. 'increase': wraps in increase(expr[window]) for total change over window. Use 'rate' or 'increase' for any *_total counter metric.",
        },
        evaluationWindow: {
          type: "string",
          description: "Time window for rate/increase evaluation (e.g., '5m', '1h'). Only used when evaluation is 'rate' or 'increase'. Default: '5m'",
        },
        condition: {
          type: "string",
          enum: ["gt", "lt", "gte", "lte"],
          description: "Comparison operator: gt (>), lt (<), gte (>=), lte (<=). Default: 'gt'",
        },
        for: {
          type: "string",
          description: "How long the condition must be true before firing (e.g., '5m', '1h'). Default: '5m'",
        },
        folderUid: {
          type: "string",
          description: "Folder UID for the alert rule. Omit to auto-create 'Grafana Lens Alerts' folder.",
        },
        labels: {
          type: "object",
          description: "Additional labels for the alert (e.g., { severity: 'warning' })",
        },
        annotations: {
          type: "object",
          description: "Annotations for the alert (e.g., { summary: 'Cost exceeded $5' })",
        },
        noDataState: {
          type: "string",
          enum: ["NoData", "Alerting", "OK"],
          description: "Behavior when no data is returned. Default: 'NoData'",
        },
        execErrState: {
          type: "string",
          enum: ["Error", "Alerting", "OK"],
          description: "Behavior when query execution errors. Default: 'Error'",
        },
      },
      required: ["title", "datasourceUid", "expr", "threshold"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const title = readStringParam(params, "title", { required: true, label: "Alert title" });
      const datasourceUid = readStringParam(params, "datasourceUid", { required: true, label: "Datasource UID" });
      const rawExpr = readStringParam(params, "expr", { required: true, label: "PromQL expression" });
      const threshold = readNumberParam(params, "threshold", { required: true, label: "Threshold" });
      const evaluation = (readStringParam(params, "evaluation") ?? "instant") as EvaluationMode;
      const evaluationWindow = readStringParam(params, "evaluationWindow") ?? "5m";
      const condition = readStringParam(params, "condition") ?? "gt";
      const forDuration = readStringParam(params, "for") ?? "5m";

      // Validate evaluation mode
      if (!["instant", "rate", "increase"].includes(evaluation)) {
        return jsonResult({ error: `Invalid evaluation '${evaluation}'. Use: instant, rate, increase` });
      }

      // Wrap expression based on evaluation mode
      const expr = wrapExpression(rawExpr, evaluation, evaluationWindow);
      const folderUid = readStringParam(params, "folderUid");
      const noDataState = (readStringParam(params, "noDataState") ?? "NoData") as "NoData" | "Alerting" | "OK";
      const execErrState = (readStringParam(params, "execErrState") ?? "Error") as "Error" | "Alerting" | "OK";
      const labels = {
        managed_by: "openclaw",
        ...((params.labels as Record<string, string>) ?? {}),
      };
      const annotations = (params.annotations as Record<string, string>) ?? {};

      // Map condition to Grafana's math expression operator
      const conditionMap: Record<string, string> = {
        gt: ">",
        lt: "<",
        gte: ">=",
        lte: "<=",
      };
      const op = conditionMap[condition];
      if (!op) {
        return jsonResult({ error: `Invalid condition '${condition}'. Use: gt, lt, gte, lte` });
      }

      try {
        // Dry-run the expression and resolve folder in parallel.
        // Use allSettled so validation failure never blocks alert creation.
        const [validationSettled, folderSettled] = await Promise.allSettled([
          validateExpression(datasourceUid, expr),
          ensureFolder(folderUid),
        ]);

        // Folder resolution is required — propagate its error
        if (folderSettled.status === "rejected") throw folderSettled.reason;
        const resolvedFolderUid = folderSettled.value;

        // Validation is informational — use result if available, fallback if not
        const metricValidation: MetricValidation = validationSettled.status === "fulfilled"
          ? validationSettled.value
          : { valid: false, error: `Validation skipped: ${validationSettled.reason instanceof Error ? validationSettled.reason.message : String(validationSettled.reason)}` };

        const rule = await client.createAlertRule({
          title,
          folderUID: resolvedFolderUid,
          ruleGroup: DEFAULT_RULE_GROUP,
          condition: "C",
          for: forDuration,
          noDataState,
          execErrState,
          labels,
          annotations: {
            summary: annotations.summary ?? title,
            ...annotations,
          },
          data: [
            {
              refId: "A",
              datasourceUid,
              queryType: "",
              model: {
                expr,
                instant: true,
                refId: "A",
              },
              relativeTimeRange: { from: 600, to: 0 },
            },
            {
              refId: "B",
              datasourceUid: "__expr__",
              queryType: "",
              model: {
                type: "reduce",
                expression: "A",
                reducer: "last",
                refId: "B",
              },
            },
            {
              refId: "C",
              datasourceUid: "__expr__",
              queryType: "",
              model: {
                type: "threshold",
                expression: "B",
                conditions: [
                  {
                    evaluator: {
                      type: condition,
                      params: [threshold],
                    },
                  },
                ],
                refId: "C",
              },
            },
          ],
        });

        return jsonResult({
          uid: rule.uid,
          title: rule.title,
          status: "created",
          datasourceUid,
          url: `${config.grafana.url}/alerting/${rule.uid}/edit`,
          evaluation: evaluation !== "instant"
            ? { mode: evaluation, window: evaluationWindow, evaluatedExpr: expr }
            : undefined,
          metricValidation,
          message: `Alert "${title}" created: fires when ${expr} ${op} ${threshold} for ${forDuration}`,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `Failed to create alert: ${reason}` });
      }
    },
  });
}
