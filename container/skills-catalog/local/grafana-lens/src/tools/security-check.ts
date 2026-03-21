/**
 * grafana_security_check tool
 *
 * Runs a comprehensive security health check against Grafana metrics and logs.
 * Executes 6 PromQL + 1 LogQL queries in parallel using Promise.allSettled,
 * then returns a unified threat-level report.
 *
 * Detection-only: never blocks, terminates, or modifies anything.
 * Honest about limitations: auth failures are invisible to this tool.
 */

import { jsonResult, readStringParam } from "openclaw/plugin-sdk";
import { GrafanaClient } from "../grafana-client.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";

// ── Threat level thresholds ─────────────────────────────────────────

type ThreatStatus = "green" | "yellow" | "red";

interface CheckResult {
  name: string;
  status: ThreatStatus;
  value: number;
  detail: string;
}

interface CheckDef {
  name: string;
  expr: (lookback: string) => string;
  evaluate: (value: number) => { status: ThreatStatus; detail: string };
}

const PROM_CHECKS: CheckDef[] = [
  {
    name: "webhook_error_ratio",
    expr: () => "sum(rate(openclaw_lens_webhook_error_total[5m])) / (sum(rate(openclaw_lens_webhook_received_total[5m])) + 0.001)",
    evaluate: (v) => {
      const pct = Math.round(v * 100);
      if (v >= 0.5) return { status: "red", detail: `${pct}% of webhooks failing (critical at 50%)` };
      if (v >= 0.2) return { status: "yellow", detail: `${pct}% of webhooks failing (warning at 20%)` };
      return { status: "green", detail: `${pct}% webhook error ratio (healthy)` };
    },
  },
  {
    name: "cost_anomaly",
    expr: () => "openclaw_lens_daily_cost_usd",
    evaluate: (v) => {
      const cost = `$${v.toFixed(2)}`;
      if (v >= 50) return { status: "red", detail: `Daily cost ${cost} (critical at $50)` };
      if (v >= 10) return { status: "yellow", detail: `Daily cost ${cost} (warning at $10)` };
      return { status: "green", detail: `Daily cost ${cost} (healthy)` };
    },
  },
  {
    name: "tool_loops",
    expr: () => "sum(openclaw_lens_tool_loops_active) or vector(0)",
    evaluate: (v) => {
      if (v >= 3) return { status: "red", detail: `${v} active tool loops (critical at 3)` };
      if (v >= 1) return { status: "yellow", detail: `${v} active tool loop(s) (warning at 1)` };
      return { status: "green", detail: "No active tool loops" };
    },
  },
  {
    name: "injection_signals",
    expr: (lb) => `sum(increase(openclaw_lens_prompt_injection_signals_total[${lb}])) or vector(0)`,
    evaluate: (v) => {
      const n = Math.round(v);
      if (n >= 5) return { status: "red", detail: `${n} prompt injection patterns detected (critical at 5)` };
      if (n >= 1) return { status: "yellow", detail: `${n} prompt injection pattern(s) detected (warning at 1)` };
      return { status: "green", detail: "No prompt injection signals" };
    },
  },
  {
    name: "session_enumeration",
    expr: () => "sum(openclaw_lens_unique_sessions_1h) or vector(0)",
    evaluate: (v) => {
      const n = Math.round(v);
      if (n >= 200) return { status: "red", detail: `${n} unique sessions in 1h (critical at 200)` };
      if (n >= 50) return { status: "yellow", detail: `${n} unique sessions in 1h (warning at 50)` };
      return { status: "green", detail: `${n} unique session(s) in 1h (healthy)` };
    },
  },
  {
    name: "stuck_sessions",
    expr: () => "sum(openclaw_lens_sessions_stuck) or vector(0)",
    evaluate: (v) => {
      const n = Math.round(v);
      if (n >= 3) return { status: "red", detail: `${n} stuck sessions (critical at 3)` };
      if (n >= 1) return { status: "yellow", detail: `${n} stuck session(s) (warning at 1)` };
      return { status: "green", detail: "No stuck sessions" };
    },
  },
];

/** Determine overall threat level from individual check statuses. */
function overallLevel(checks: CheckResult[]): ThreatStatus {
  if (checks.some((c) => c.status === "red")) return "red";
  if (checks.some((c) => c.status === "yellow")) return "yellow";
  return "green";
}

export function createSecurityCheckToolFactory(config: ValidatedGrafanaLensConfig) {
  const client = new GrafanaClient({
    url: config.grafana.url,
    apiKey: config.grafana.apiKey,
    orgId: config.grafana.orgId,
  });

  return (_ctx: unknown) => ({
    name: "grafana_security_check",
    label: "Security Check",
    description: [
      "WORKFLOW: Run a comprehensive security health check against Grafana metrics and logs.",
      "Use when asked 'am I being attacked?', 'security status', 'security audit', or 'security check'.",
      "Runs 6 parallel checks: webhook error patterns, cost anomalies, tool loops,",
      "prompt injection signals, session enumeration, and stuck sessions.",
      "Returns structured report with threat level (green/yellow/red) per check,",
      "suggested actions, and honest limitations.",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        lookback: {
          type: "string",
          description:
            "Time window to analyze. Default '1h'. Use '24h' for daily review, '7d' for weekly.",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const lookback = readStringParam(params, "lookback") ?? "1h";

      // Fix 3: Validate lookback to prevent PromQL injection
      if (!/^\d+[smhdwy]$/.test(lookback)) {
        return jsonResult({ error: `Invalid lookback "${lookback}" — use a Prometheus duration like "1h", "24h", "7d"` });
      }

      try {
        // Auto-discover datasources
        const datasources = await client.listDatasources();
        const promDs = datasources.find((d) => d.type === "prometheus");
        const lokiDs = datasources.find((d) => d.type === "loki");

        if (!promDs) {
          return jsonResult({
            error: "No Prometheus datasource found — security check requires Prometheus for metric queries. Use grafana_explore_datasources to verify.",
          });
        }

        // Fix 5: Run PromQL checks and Loki query in parallel
        const [promResults, lokiResult] = await Promise.all([
          Promise.allSettled(
            PROM_CHECKS.map(async (check) => {
              // Fix 4: Use typed PrometheusInstantResult directly
              const result = await client.queryPrometheus(promDs.uid, check.expr(lookback));
              const first = result.data.result[0];
              const parsed = first ? parseFloat(first.value[1]) : 0;
              const value = isNaN(parsed) ? 0 : parsed;
              const { status, detail } = check.evaluate(value);
              return { name: check.name, status, value, detail } as CheckResult;
            }),
          ),
          lokiDs
            ? client.queryLokiRange(lokiDs.uid,
                `{service_name="openclaw"} | json | event_name=~"prompt_injection.detected|gateway.start|tool.loop"`,
                `now-${lookback}`, "now",
                { limit: 100 },
              ).catch(() => null)
            : Promise.resolve(null),
        ]);

        // Extract successful check results, mark failures
        const checks: CheckResult[] = [];
        const limitations: string[] = [
          "Auth failures not observable — openclaw auth middleware emits no diagnostic events. Monitor gateway access logs manually.",
        ];

        for (let i = 0; i < promResults.length; i++) {
          const settled = promResults[i];
          if (settled.status === "fulfilled") {
            checks.push(settled.value);
          } else {
            // Fix 2: Failed queries report "yellow" (unknown) not "green" (safe)
            checks.push({
              name: PROM_CHECKS[i].name,
              status: "yellow",
              value: -1,
              detail: `Unable to assess — query failed: ${settled.reason instanceof Error ? settled.reason.message : String(settled.reason)}`,
            });
            limitations.push(`${PROM_CHECKS[i].name} check failed — query error`);
          }
        }

        // Extract Loki security event count
        let securityEventCount = 0;
        if (lokiDs) {
          if (lokiResult) {
            const logData = lokiResult as { data?: { result?: unknown[] } };
            if (logData?.data?.result) {
              for (const stream of logData.data.result as Array<{ values?: unknown[] }>) {
                securityEventCount += stream.values?.length ?? 0;
              }
            }
          } else if (lokiResult === null) {
            // Loki query was attempted but failed (caught in Promise.all)
            limitations.push("Loki log check failed — security event logs unavailable");
          }
        } else {
          limitations.push("No Loki datasource — security event log correlation unavailable");
        }

        // Build summary
        const warnings = checks.filter((c) => c.status === "yellow");
        const criticals = checks.filter((c) => c.status === "red");
        const parts: string[] = [];
        if (criticals.length > 0) parts.push(`${criticals.length} critical: ${criticals.map((c) => c.detail).join("; ")}`);
        if (warnings.length > 0) parts.push(`${warnings.length} warning(s): ${warnings.map((c) => c.detail).join("; ")}`);
        if (parts.length === 0) parts.push("All checks green — no threats detected");
        const summary = parts.join(". ");

        // Build suggested actions based on findings
        const suggestedActions: string[] = [];
        for (const check of checks) {
          if (check.status === "green") continue;
          switch (check.name) {
            case "webhook_error_ratio":
              suggestedActions.push(
                "Investigate webhook errors: use grafana_query_logs with '{service_name=\"openclaw\"} | json | component=\"diagnostic\" | event_name=\"webhook.error\"'",
              );
              break;
            case "cost_anomaly":
              suggestedActions.push(
                "Investigate cost spike: use grafana_explain_metric on 'openclaw_lens_daily_cost_usd' and check 'openclaw_lens_cost_by_model_total' for model attribution",
              );
              break;
            case "tool_loops":
              suggestedActions.push(
                "Investigate tool loops: use grafana_query_logs with '{service_name=\"openclaw\"} | json | event_name=\"tool.loop\"'",
              );
              break;
            case "injection_signals":
              suggestedActions.push(
                "Review injection patterns: use grafana_query_logs with '{service_name=\"openclaw\"} | json | event_name=\"prompt_injection.detected\"'",
              );
              break;
            case "session_enumeration":
              suggestedActions.push(
                "Review session volume: check recent sessions for unusual patterns, consider rotating API tokens",
              );
              break;
            case "stuck_sessions":
              suggestedActions.push(
                "Investigate stuck sessions: use grafana_query on 'openclaw_lens_stuck_session_max_age_ms' and check recent session logs",
              );
              break;
          }
        }
        if (suggestedActions.length === 0) {
          suggestedActions.push("No immediate actions needed. Consider setting up security alerts with grafana_create_alert for proactive monitoring.");
        }

        return jsonResult({
          overallThreatLevel: overallLevel(checks),
          summary,
          checks,
          securityEventLogs: securityEventCount,
          limitations,
          suggestedActions,
          dashboardTemplate: "security-overview",
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return jsonResult({
          error: `Security check failed: ${reason}`,
        });
      }
    },
  });
}
