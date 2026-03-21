/**
 * grafana_search tool
 *
 * Search existing dashboards in Grafana by title or tag. The agent uses
 * this to check for existing dashboards before creating duplicates, or
 * to find a dashboard the user mentions by name.
 *
 * Optional enrichment (enrich: true) fetches dashboard details in parallel
 * to add updatedAt and panelCount — useful for reporting workflows.
 */

import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk";
import { GrafanaClient } from "../grafana-client.js";
import type { DashboardSearchResult } from "../grafana-client.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";

/**
 * Extract updatedAt and panelCount from a full dashboard response.
 */
function extractDashboardMeta(full: Record<string, unknown>): {
  updatedAt?: string;
  panelCount?: number;
} {
  const meta = full.meta as Record<string, unknown> | undefined;
  const dashboard = full.dashboard as Record<string, unknown> | undefined;
  const updatedAt = typeof meta?.updated === "string" ? meta.updated : undefined;
  const panels = Array.isArray(dashboard?.panels) ? dashboard.panels : undefined;
  return {
    updatedAt,
    panelCount: panels?.length,
  };
}

/**
 * Build a search result entry — always includes folder info when available.
 * When enrichDetails is provided (from getDashboard), adds updatedAt + panelCount.
 */
function buildResultEntry(
  d: DashboardSearchResult,
  dashboardUrl: string,
  enrichDetails?: { updatedAt?: string; panelCount?: number },
) {
  const entry: Record<string, unknown> = {
    uid: d.uid,
    title: d.title,
    url: dashboardUrl,
    tags: d.tags,
  };

  // Always include folder info when available (free from search API)
  if (d.folderTitle) entry.folderTitle = d.folderTitle;
  if (d.folderUid) entry.folderUid = d.folderUid;

  // Enriched fields from getDashboard
  if (enrichDetails) {
    if (enrichDetails.updatedAt) entry.updatedAt = enrichDetails.updatedAt;
    if (enrichDetails.panelCount !== undefined) entry.panelCount = enrichDetails.panelCount;
  }

  return entry;
}

/** Max concurrent getDashboard requests during enrichment. */
const ENRICH_CONCURRENCY = 10;

/**
 * Fetch dashboard details in batches to avoid overwhelming Grafana.
 */
async function fetchDetailsInBatches(
  uids: string[],
  fetcher: (uid: string) => Promise<Record<string, unknown>>,
): Promise<PromiseSettledResult<Record<string, unknown>>[]> {
  const results: PromiseSettledResult<Record<string, unknown>>[] = [];
  for (let i = 0; i < uids.length; i += ENRICH_CONCURRENCY) {
    const batch = uids.slice(i, i + ENRICH_CONCURRENCY);
    const batchResults = await Promise.allSettled(batch.map(fetcher));
    results.push(...batchResults);
  }
  return results;
}

export function createSearchToolFactory(config: ValidatedGrafanaLensConfig) {
  const client = new GrafanaClient({
    url: config.grafana.url,
    apiKey: config.grafana.apiKey,
    orgId: config.grafana.orgId,
  });

  return (_ctx: unknown) => ({
    name: "grafana_search",
    label: "Search Dashboards",
    description: [
      "Search for existing dashboards in Grafana by title or tags.",
      "WORKFLOW: Use before creating a new dashboard to avoid duplicates.",
      "Also use when user refers to a dashboard by name ('show me my cost dashboard').",
      "Returns dashboard UIDs, URLs, and folder info for use with other tools.",
      "Set enrich=true for reporting workflows — adds updatedAt and panelCount per dashboard (extra API calls).",
      "After finding a dashboard, use grafana_get_dashboard to inspect panels, grafana_share_dashboard to render a chart, or grafana_update_dashboard to modify it.",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (matches dashboard titles, e.g., 'cost', 'agent overview')",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter by dashboard tags (e.g., ['production', 'api'])",
        },
        starred: {
          type: "boolean",
          description: "Only return starred dashboards",
        },
        sort: {
          type: "string",
          enum: ["alpha-asc", "alpha-desc"],
          description: "Sort order for results",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 100)",
        },
        enrich: {
          type: "boolean",
          description:
            "Fetch dashboard details to add updatedAt and panelCount per result. " +
            "Use for reporting/audit workflows. Adds one API call per result (default: false)",
        },
      },
      required: ["query"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const query = readStringParam(params, "query", { required: true, label: "Search query" });
      const tags = params.tags as string[] | undefined;
      const starred = params.starred === true ? true : undefined;
      const sort = readStringParam(params, "sort");
      const limit = readNumberParam(params, "limit");
      const enrich = params.enrich === true;

      try {
        const results = await client.searchDashboards(query, {
          tags,
          starred,
          sort: sort ?? undefined,
          limit,
        });

        let dashboards: Record<string, unknown>[];

        if (enrich && results.length > 0) {
          // Batched parallel fetch — max ENRICH_CONCURRENCY at a time
          const details = await fetchDetailsInBatches(
            results.map((d) => d.uid),
            (uid) => client.getDashboard(uid),
          );

          dashboards = results.map((d, i) => {
            const detail = details[i];
            const enrichDetails =
              detail.status === "fulfilled"
                ? extractDashboardMeta(detail.value)
                : undefined;
            return buildResultEntry(d, client.dashboardUrl(d.uid), enrichDetails);
          });
        } else {
          dashboards = results.map((d) =>
            buildResultEntry(d, client.dashboardUrl(d.uid)),
          );
        }

        const response: Record<string, unknown> = {
          status: "success",
          count: results.length,
          enriched: enrich,
          dashboards,
        };

        return jsonResult(response);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `Search failed: ${reason}` });
      }
    },
  });
}
