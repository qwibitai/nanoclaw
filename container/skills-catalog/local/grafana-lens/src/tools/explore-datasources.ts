/**
 * grafana_explore_datasources tool
 *
 * Discovers what datasources are configured in Grafana. This is the
 * agent's starting point for understanding what data is available —
 * it provides the datasource UIDs needed by grafana_query and
 * grafana_list_metrics, plus routing hints for which tool to use.
 */

import { jsonResult } from "openclaw/plugin-sdk";
import { GrafanaClient } from "../grafana-client.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";

export type QueryToolName = "grafana_query" | "grafana_query_logs" | "grafana_query_traces";
export type QueryLanguageName = "PromQL" | "LogQL" | "TraceQL";

/** Discriminated union: supported datasources have non-null tool+language, unsupported have null. */
export type QueryCapability =
  | { queryTool: QueryToolName; queryLanguage: QueryLanguageName; supported: true }
  | { queryTool: null; queryLanguage: null; supported: false };

/** Maps datasource type → agent tool routing info. */
const DATASOURCE_CAPABILITIES: Record<string, { queryTool: QueryToolName; queryLanguage: QueryLanguageName }> = {
  prometheus: { queryTool: "grafana_query", queryLanguage: "PromQL" },
  loki: { queryTool: "grafana_query_logs", queryLanguage: "LogQL" },
  tempo: { queryTool: "grafana_query_traces", queryLanguage: "TraceQL" },
};

/** Returns routing hints for a datasource type, or an unsupported fallback. */
export function getQueryCapability(dsType: string): QueryCapability {
  const cap = DATASOURCE_CAPABILITIES[dsType];
  if (cap) return { ...cap, supported: true };
  return { queryTool: null, queryLanguage: null, supported: false };
}

export function createExploreDatasourcesToolFactory(config: ValidatedGrafanaLensConfig) {
  const client = new GrafanaClient({
    url: config.grafana.url,
    apiKey: config.grafana.apiKey,
    orgId: config.grafana.orgId,
  });

  return (_ctx: unknown) => ({
    name: "grafana_explore_datasources",
    label: "Explore Datasources",
    description: [
      "Discover datasources configured in Grafana.",
      "WORKFLOW: Use first to find datasource UIDs needed by grafana_query, grafana_query_logs, grafana_query_traces, grafana_list_metrics, grafana_create_alert, and grafana_explain_metric.",
      "Returns datasources with UIDs, types, and queryTool routing (which tool + query language to use for each datasource).",
      "No parameters required.",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {},
    },
    async execute(_toolCallId: string, _params: Record<string, unknown>) {
      try {
        const datasources = await client.listDatasources();

        return jsonResult({
          status: "success",
          count: datasources.length,
          datasources: datasources.map((ds) => ({
            uid: ds.uid,
            name: ds.name,
            type: ds.type,
            isDefault: ds.isDefault,
            ...getQueryCapability(ds.type),
          })),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `Failed to list datasources: ${reason}` });
      }
    },
  });
}
