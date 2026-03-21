/**
 * grafana_list_metrics tool
 *
 * Discovers available metrics (or label values) from a Prometheus datasource.
 * Helps the agent understand what data exists before querying or building
 * dashboards — "what can I track?" gets answered here.
 */

import { jsonResult, readStringParam } from "openclaw/plugin-sdk";
import { GrafanaClient, escapeRegex } from "../grafana-client.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";
import type { CustomMetricsStore } from "../services/custom-metrics-store.js";
import { KNOWN_METRICS_MAP, type PrometheusMetricType } from "../metric-definitions.js";

const MAX_RESULTS = 200;

// Re-export for backward compatibility (tests import from here)
export type { PrometheusMetricType } from "../metric-definitions.js";

/**
 * Known metrics map — derived from the shared metric-definitions registry.
 * Re-exported so existing consumers (tests, deduplicateAndEnrich) continue to work.
 */
export const KNOWN_LENS_METRICS = KNOWN_METRICS_MAP;

/**
 * Deduplicate histogram sub-metrics and synthesize metadata entries from
 * metric names + the known-metrics registry. Histogram _bucket/_count/_sum
 * variants are coalesced into a single base-name entry with type "histogram".
 */
export function deduplicateAndEnrich(
  names: string[],
): Array<{ name: string; type: PrometheusMetricType; help: string; category?: MetricCategory; source: string }> {
  // Detect histogram bases from _bucket names
  const histogramBases = new Set<string>();
  const skipNames = new Set<string>();

  for (const name of names) {
    if (name.endsWith("_bucket")) {
      const base = name.slice(0, -"_bucket".length);
      histogramBases.add(base);
      skipNames.add(`${base}_bucket`);
      skipNames.add(`${base}_count`);
      skipNames.add(`${base}_sum`);
    }
  }

  const entries: Array<{ name: string; type: PrometheusMetricType; help: string; category?: MetricCategory; source: string }> = [];
  const seen = new Set<string>();

  // Add histogram base entries first
  for (const base of histogramBases) {
    if (seen.has(base)) continue;
    seen.add(base);
    const known = KNOWN_LENS_METRICS.get(base);
    const category = categorizeMetric(base);
    entries.push({
      name: base,
      type: known?.type ?? "histogram",
      help: known?.help ?? "",
      ...(category ? { category } : {}),
      source: "synthetic",
    });
  }

  // Add remaining non-histogram names
  for (const name of names) {
    if (skipNames.has(name) || seen.has(name)) continue;
    seen.add(name);
    const known = KNOWN_LENS_METRICS.get(name);
    const category = categorizeMetric(name);
    entries.push({
      name,
      type: known?.type ?? (name.endsWith("_total") ? "counter" : "gauge"),
      help: known?.help ?? "",
      ...(category ? { category } : {}),
      source: "synthetic",
    });
  }

  return entries;
}

// ── Metric categorization ───────────────────────────────────────────

export type MetricCategory =
  | "cost"
  | "usage"
  | "session"
  | "queue"
  | "messaging"
  | "webhook"
  | "tools"
  | "agent"
  | "custom";

export type MetricPurpose = "performance" | "cost" | "reliability" | "capacity";

/**
 * Maps a high-level purpose to the metric categories that serve it.
 * Agents say "show me performance metrics" → we filter to session + tools categories.
 */
export const PURPOSE_CATEGORIES: Record<MetricPurpose, ReadonlySet<MetricCategory>> = {
  performance: new Set(["session", "tools"]),
  cost: new Set(["cost", "usage"]),
  reliability: new Set(["webhook", "messaging", "agent"]),
  capacity: new Set(["queue", "session"]),
};

/**
 * Rules are evaluated top-to-bottom, first match wins.
 * Each rule: [substring to match after stripping the namespace prefix, category].
 * The namespace prefix (`openclaw_lens_`, `openclaw_`) is stripped before matching.
 */
const CATEGORY_RULES: ReadonlyArray<readonly [string, MetricCategory]> = [
  // cost & billing
  ["cost_", "cost"],
  ["daily_cost_", "cost"],
  ["cache_savings_", "cost"],
  // usage (tokens, context, cache ratios)
  ["tokens_", "usage"],
  ["token_", "usage"],
  ["context_tokens", "usage"],
  ["cache_read_ratio", "usage"],
  ["cache_token_ratio", "usage"],
  // session lifecycle
  ["sessions_", "session"],
  ["session_", "session"],
  ["stuck_session_", "session"],
  // queue infrastructure
  ["queue_", "queue"],
  // messaging
  ["message_", "messaging"],
  ["messages_", "messaging"],
  // webhook handling
  ["webhook_", "webhook"],
  ["alert_webhooks_", "webhook"],
  // tools
  ["tool_", "tools"],
  // agent / subagent / run
  ["subagent", "agent"],
  ["run_", "agent"],
  // custom metrics push bookkeeping
  ["custom_metrics_", "custom"],
];

/**
 * Categorize a metric name by functional area.
 * Returns the category for `openclaw_*` metrics, or `undefined` for non-openclaw metrics.
 * `openclaw_ext_*` metrics are always categorized as `"custom"`.
 */
export function categorizeMetric(name: string): MetricCategory | undefined {
  if (!name.startsWith("openclaw_")) return undefined;

  // All user-pushed custom metrics
  if (name.startsWith("openclaw_ext_")) return "custom";

  // Strip namespace prefix for rule matching
  const suffix = name.startsWith("openclaw_lens_")
    ? name.slice("openclaw_lens_".length)
    : name.slice("openclaw_".length);

  for (const [pattern, category] of CATEGORY_RULES) {
    if (suffix.startsWith(pattern)) return category;
  }

  return undefined;
}

/** Build a categorySummary from categorized entries. */
function buildCategorySummary(entries: Array<{ category?: MetricCategory }>): Record<string, number> | undefined {
  const summary: Record<string, number> = {};
  let hasCats = false;
  for (const e of entries) {
    if (e.category) {
      summary[e.category] = (summary[e.category] ?? 0) + 1;
      hasCats = true;
    }
  }
  return hasCats ? summary : undefined;
}

export function createListMetricsToolFactory(
  config: ValidatedGrafanaLensConfig,
  getCustomMetricsStore?: () => CustomMetricsStore | null,
) {
  const client = new GrafanaClient({
    url: config.grafana.url,
    apiKey: config.grafana.apiKey,
    orgId: config.grafana.orgId,
  });

  return (_ctx: unknown) => ({
    name: "grafana_list_metrics",
    label: "List Metrics",
    description: [
      "Discover available metrics or label values from a Prometheus datasource.",
      "WORKFLOW: Use after grafana_explore_datasources to see what metrics exist.",
      "By default lists metric names. Set 'label' to list values for a specific label instead.",
      "Set 'metadata' to true for enriched results with type (counter/gauge/histogram), help text, and functional category for openclaw_* metrics (cost, usage, session, queue, messaging, webhook, tools, agent, custom) — useful before composing dashboards. Includes categorySummary for quick overview. Works on OTLP-only stacks via synthetic metadata from the metric registry.",
      "Use 'prefix' to filter by prefix. Use 'search' for targeted metric discovery (e.g., 'steps' finds 'openclaw_ext_steps_today'). Server-side regex — only matching metrics returned. Also searches help text in metadata mode.",
      "Use 'purpose' to filter by intent: performance (session + tools), cost (cost + usage), reliability (webhook + messaging + agent), capacity (queue + session). Auto-narrows to openclaw_* metrics.",
      "Set compact=true with metadata=true for minimal fields (name, type, category only) — ~60% smaller, ideal for multi-tool chains.",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        datasourceUid: {
          type: "string",
          description: "UID of the Prometheus datasource (from grafana_explore_datasources)",
        },
        prefix: {
          type: "string",
          description: "Filter metric names by prefix (e.g., 'openclaw_lens_', 'node_')",
        },
        search: {
          type: "string",
          description: "Search for metrics by substring (server-side regex). E.g., 'steps' finds 'openclaw_ext_steps_today'. Combinable with prefix.",
        },
        label: {
          type: "string",
          description: "List values for this label instead of metric names (e.g., 'job', 'instance')",
        },
        metadata: {
          type: "boolean",
          description: "Return enriched results with type (counter/gauge/histogram), help text, and functional category for openclaw_* metrics. Includes categorySummary counts. Ignored when 'label' is set.",
        },
        purpose: {
          type: "string",
          enum: ["performance", "cost", "reliability", "capacity"],
          description: "Filter metrics by purpose: performance (session + tools), cost (cost + usage), reliability (webhook + messaging + agent), capacity (queue + session). Auto-narrows to openclaw_* metrics. Composes with prefix, search, and metadata.",
        },
        compact: {
          type: "boolean",
          description: "Return minimal fields only — {name, type, category} per metric. Drops help, source, labelNames. Use in multi-tool chains to reduce context. Requires metadata=true. Default: false",
        },
      },
      required: ["datasourceUid"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const datasourceUid = readStringParam(params, "datasourceUid", { required: true, label: "Datasource UID" });
      let prefix = readStringParam(params, "prefix");
      const search = readStringParam(params, "search");
      const label = readStringParam(params, "label");
      const metadata = typeof params.metadata === "boolean" ? params.metadata : false;
      const compact = typeof params.compact === "boolean" ? params.compact : false;
      const purpose = readStringParam(params, "purpose") as MetricPurpose | undefined;

      // Validate purpose
      if (purpose && !PURPOSE_CATEGORIES[purpose]) {
        return jsonResult({
          error: `Invalid purpose '${purpose}'. Valid values: ${Object.keys(PURPOSE_CATEGORIES).join(", ")}`,
        });
      }

      // Purpose auto-injects openclaw_ prefix for server-side narrowing
      const purposeCategories = purpose ? PURPOSE_CATEGORIES[purpose] : null;
      const prefixAutoInjected = !!(purposeCategories && !prefix);
      if (prefixAutoInjected) {
        prefix = "openclaw_";
      }

      try {
        if (label) {
          // List label values mode
          const values = await client.listLabelValues(datasourceUid, label);
          const truncated = values.length > MAX_RESULTS;

          return jsonResult({
            status: "success",
            label,
            count: Math.min(values.length, MAX_RESULTS),
            totalCount: values.length,
            values: values.slice(0, MAX_RESULTS),
            ...(truncated ? { truncated: true } : {}),
          });
        }

        if (metadata) {
          // Metadata mode — enriched results with type and help
          const meta = await client.getMetricMetadata(datasourceUid);
          const metadataIsEmpty = Object.keys(meta).length === 0;
          let metadataSource: "prometheus" | "synthetic" = "prometheus";

          let entries: Array<{ name: string; type: string; help: string; category?: MetricCategory; source?: string; labelNames?: string[] }>;

          if (!metadataIsEmpty) {
            // ── Prometheus metadata available ──────────────────────
            // Use server-side filtered names to intersect with metadata when search/prefix provided.
            // Skip when prefix was auto-injected by purpose (no explicit search) — the purpose
            // filter handles narrowing client-side, avoiding a redundant HTTP round-trip.
            let allowedNames: Set<string> | null = null;
            const match = (prefixAutoInjected && !search) ? undefined : buildMatchSelector(prefix, search);
            if (match) {
              const serverNames = await client.listMetricNames(datasourceUid, { match });
              allowedNames = new Set(serverNames);
            }

            entries = Object.entries(meta).map(([name, items]) => {
              const category = categorizeMetric(name);
              return {
                name,
                type: items[0]?.type ?? "unknown",
                help: items[0]?.help ?? "",
                ...(category ? { category } : {}),
              };
            });

            if (allowedNames) {
              entries = entries.filter((e) => allowedNames!.has(e.name));
            }

            // Also search help text client-side for search term
            if (search && !allowedNames) {
              const lowerSearch = search.toLowerCase();
              entries = entries.filter(
                (e) => e.name.toLowerCase().includes(lowerSearch) || e.help.toLowerCase().includes(lowerSearch),
              );
            } else if (search && allowedNames) {
              // Already filtered by name via server-side; also include entries matching help text
              const lowerSearch = search.toLowerCase();
              const helpMatches = Object.entries(meta)
                .filter(([name, items]) => !allowedNames!.has(name) && (items[0]?.help ?? "").toLowerCase().includes(lowerSearch))
                .map(([name, items]) => {
                  const category = categorizeMetric(name);
                  return {
                    name,
                    type: items[0]?.type ?? "unknown",
                    help: items[0]?.help ?? "",
                    ...(category ? { category } : {}),
                  };
                });
              entries = [...entries, ...helpMatches];
            }
          } else {
            // ── OTLP fallback: synthesize from names + registry ───
            // Prometheus /api/v1/metadata returns nothing for OTLP-pushed metrics.
            // Fall back to listing metric names (which works for OTLP) and enriching
            // with type/help from the known-metrics registry.
            metadataSource = "synthetic";
            const match = buildMatchSelector(prefix, search);
            const names = await client.listMetricNames(datasourceUid, match ? { match } : undefined);
            entries = deduplicateAndEnrich(names);
          }

          // Merge custom metric definitions from CustomMetricsStore (OTLP-pushed
          // metrics don't appear in Prometheus /api/v1/metadata which is scrape-based)
          const store = getCustomMetricsStore?.();
          if (store) {
            const promNames = new Set(entries.map((e) => e.name));
            for (const def of store.listMetrics()) {
              // Skip if Prometheus already has this name (or its _total variant)
              if (promNames.has(def.name) || promNames.has(`${def.name}_total`)) continue;

              // Apply same prefix/search filters
              const lowerName = def.name.toLowerCase();
              const lowerHelp = def.help.toLowerCase();
              if (prefix && !def.name.startsWith(prefix)) continue;
              if (search) {
                const lowerSearch = search.toLowerCase();
                if (!lowerName.includes(lowerSearch) && !lowerHelp.includes(lowerSearch)) continue;
              }

              const category = categorizeMetric(def.name);
              entries.push({
                name: def.name,
                type: def.type,
                help: def.help,
                ...(category ? { category } : {}),
                source: "custom",
                labelNames: def.labelNames,
              });
            }
          }

          // Purpose filter — keep only metrics whose category matches the purpose
          if (purposeCategories) {
            entries = entries.filter((e) => e.category != null && purposeCategories.has(e.category));
          }

          const truncated = entries.length > MAX_RESULTS;
          const sliced = entries.slice(0, MAX_RESULTS);
          const categorySummary = buildCategorySummary(sliced);

          return jsonResult({
            status: "success",
            metadataSource,
            count: sliced.length,
            totalCount: entries.length,
            ...(categorySummary ? { categorySummary } : {}),
            metrics: compact
              ? sliced.map((e) => ({
                  name: e.name,
                  type: e.type,
                  ...(e.category ? { category: e.category } : {}),
                }))
              : sliced,
            ...(truncated ? { truncated: true } : {}),
            ...(prefix ? { prefix } : {}),
            ...(search ? { search } : {}),
            ...(purpose ? { purpose } : {}),
            ...(metadataSource === "synthetic" ? {
              hint: "Metadata synthesized from known metric definitions. Prometheus /api/v1/metadata returned no entries (common with OTLP-only stacks). Type and help text are from the Grafana Lens metric registry.",
            } : {}),
          });
        }

        // List metric names mode (default) — server-side filtering via match[]
        const match = buildMatchSelector(prefix, search);
        let names = await client.listMetricNames(datasourceUid, match ? { match } : undefined);

        // Purpose filter — client-side category check on names
        if (purposeCategories) {
          names = names.filter((n) => {
            const cat = categorizeMetric(n);
            return cat != null && purposeCategories.has(cat);
          });
        }

        const truncated = names.length > MAX_RESULTS;

        return jsonResult({
          status: "success",
          count: Math.min(names.length, MAX_RESULTS),
          totalCount: names.length,
          metrics: names.slice(0, MAX_RESULTS),
          ...(truncated ? { truncated: true } : {}),
          ...(prefix ? { prefix } : {}),
          ...(search ? { search } : {}),
          ...(purpose ? { purpose } : {}),
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `Failed to list metrics: ${reason}` });
      }
    },
  });
}

/** Build a Prometheus match[] selector from prefix and/or search terms. */
function buildMatchSelector(prefix?: string | null, search?: string | null): string | undefined {
  if (prefix && search) {
    return `{__name__=~"${escapeRegex(prefix)}.*${escapeRegex(search)}.*"}`;
  }
  if (prefix) {
    return `{__name__=~"${escapeRegex(prefix)}.*"}`;
  }
  if (search) {
    return `{__name__=~".*${escapeRegex(search)}.*"}`;
  }
  return undefined;
}
