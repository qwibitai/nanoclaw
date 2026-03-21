/**
 * grafana_update_dashboard tool
 *
 * Five operations in one tool:
 *   - add_panel: Add a new panel with auto-layout + query validation
 *   - remove_panel: Remove a panel by ID or title
 *   - update_panel: Merge updates into an existing panel + query validation
 *   - update_metadata: Change title, description, tags, time range, refresh
 *   - delete: Permanently remove a dashboard
 *
 * Uses the same POST /api/dashboards/db endpoint as create-dashboard,
 * but preserves dashboard.id and version for update semantics.
 *
 * Query validation: When adding or updating panel targets, PromQL expressions
 * are dry-run against Grafana. The panel is always saved regardless — validation
 * is informational, included as a queryValidation object in the response.
 */

import { jsonResult, readStringParam, readNumberParam } from "openclaw/plugin-sdk";
import { GrafanaClient } from "../grafana-client.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";

type Panel = Record<string, unknown>;
type GridPos = { x: number; y: number; w: number; h: number };
type Target = { refId?: string; expr?: string; datasource?: { uid?: string; type?: string } };

/** Per-query validation result. */
export type QueryValidationEntry = {
  refId: string;
  expr: string;
  valid: boolean;
  error?: string;
  sampleValue?: number;
};

/** Aggregate validation result for all targets in a panel. */
export type QueryValidation = {
  validated: boolean;
  results: QueryValidationEntry[];
  datasourceUid?: string;
  skippedReason?: string;
};

export function createUpdateDashboardToolFactory(config: ValidatedGrafanaLensConfig) {
  const client = new GrafanaClient({
    url: config.grafana.url,
    apiKey: config.grafana.apiKey,
    orgId: config.grafana.orgId,
  });

  return (_ctx: unknown) => ({
    name: "grafana_update_dashboard",
    label: "Update Dashboard",
    description: [
      "Modify or delete an existing Grafana dashboard — add panels, remove panels, update panel queries, change metadata, or delete the dashboard entirely.",
      "WORKFLOW: Always call grafana_get_dashboard first to get panel IDs and current structure.",
      "Use operation 'add_panel' to append a panel (auto-layouts below existing panels).",
      "Use 'remove_panel' to delete a panel by ID or title. Use 'update_panel' to merge changes into a panel.",
      "Use 'update_metadata' to change title, description, tags, time range, or auto-refresh.",
      "Use 'delete' to permanently remove a dashboard (cannot be undone — confirm with user first).",
      "Returns the updated dashboard URL and a summary of changes.",
      "For add_panel and update_panel (when targets change), PromQL queries are dry-run and a queryValidation object is included: {valid, error?, sampleValue?} per target. The panel is always saved — validation is informational.",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        uid: {
          type: "string",
          description: "Dashboard UID (from grafana_get_dashboard or grafana_search)",
        },
        operation: {
          type: "string",
          enum: ["add_panel", "remove_panel", "update_panel", "update_metadata", "delete"],
          description: "Operation to perform on the dashboard",
        },
        panel: {
          type: "object",
          description:
            "Panel definition for add_panel. Must include title, type, and targets. Example: { title: 'Error Rate', type: 'timeseries', targets: [{ refId: 'A', expr: 'rate(errors[5m])' }] }",
        },
        panelId: {
          type: "number",
          description: "Panel ID for remove_panel or update_panel (from grafana_get_dashboard)",
        },
        panelTitle: {
          type: "string",
          description:
            "Panel title fallback for remove/update — case-insensitive substring match. Use panelId when possible.",
        },
        updates: {
          type: "object",
          description:
            "Fields to merge into the panel for update_panel. Example: { title: 'New Title', targets: [...] }. targets replaces entirely if provided.",
        },
        title: { type: "string", description: "New dashboard title (update_metadata)" },
        description: { type: "string", description: "New dashboard description (update_metadata)" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "New dashboard tags (update_metadata)",
        },
        time: {
          type: "object",
          description:
            'Dashboard time range (update_metadata). Example: { "from": "now-7d", "to": "now" }',
        },
        refresh: {
          type: "string",
          description: 'Auto-refresh interval (update_metadata). Example: "1m", "5m", "30s"',
        },
      },
      required: ["uid", "operation"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const uid = readStringParam(params, "uid", { required: true, label: "Dashboard UID" });
      const operation = readStringParam(params, "operation", { required: true, label: "Operation" });

      // Fetch existing dashboard — preserves id and version for update
      let data: Record<string, unknown>;
      try {
        data = await client.getDashboard(uid);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return jsonResult({ error: `Failed to get dashboard: ${reason}` });
      }

      const dashboard = data.dashboard as Record<string, unknown>;
      const meta = data.meta as Record<string, unknown> | undefined;

      // Safety: provisioned dashboards reject API updates
      if (meta?.provisioned === true && operation !== "delete") {
        return jsonResult({
          error:
            "Dashboard is provisioned and cannot be modified via API. Create a new dashboard with grafana_create_dashboard instead, or ask the user to modify the provisioning source file.",
        });
      }

      const panels = ((dashboard.panels as Panel[]) ?? []);

      switch (operation) {
        case "add_panel":
          return handleAddPanel(client, dashboard, meta, panels, params);
        case "remove_panel":
          return handleRemovePanel(client, dashboard, meta, panels, params);
        case "update_panel":
          return handleUpdatePanel(client, dashboard, meta, panels, params);
        case "update_metadata":
          return handleUpdateMetadata(client, dashboard, meta, params);
        case "delete":
          return handleDelete(client, uid, dashboard);
        default:
          return jsonResult({
            error: `Unknown operation '${operation}'. Use: add_panel, remove_panel, update_panel, update_metadata, delete`,
          });
      }
    },
  });
}

// ── Query validation ─────────────────────────────────────────────────

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

/**
 * Resolve a Prometheus datasource UID for query validation.
 * Checks: panel targets → panel datasource → existing panels → undefined.
 */
function resolveDatasourceUid(panel: Panel, existingPanels: Panel[]): string | undefined {
  return firstUidFromPanel(panel)
    ?? existingPanels.reduce<string | undefined>((found, p) => found ?? firstUidFromPanel(p), undefined);
}

const VALIDATION_SKIP_REASON = "No datasource UID found on panel or existing panels — set datasource.uid on targets to enable validation";

/**
 * Dry-run PromQL expressions from panel targets to validate them.
 * Returns a QueryValidation object — never throws.
 */
export async function validateTargetQueries(
  client: GrafanaClient,
  targets: Target[],
  datasourceUid: string,
): Promise<QueryValidation> {
  const exprs = targets.filter((t) => t.expr);
  if (exprs.length === 0) {
    return { validated: false, results: [], skippedReason: "No PromQL expressions in targets" };
  }

  const results = await Promise.all(
    exprs.map(async (t): Promise<QueryValidationEntry> => {
      const refId = t.refId ?? "?";
      const expr = t.expr!;
      try {
        const result = await client.queryPrometheus(datasourceUid, expr);
        const first = result.data.result[0];
        return {
          refId,
          expr,
          valid: true,
          ...(first ? { sampleValue: Number(first.value[1]) } : {}),
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { refId, expr, valid: false, error: reason };
      }
    }),
  );

  return { validated: true, results, datasourceUid };
}

/**
 * Resolve datasource + validate targets in one call. Returns undefined when
 * there are no targets to validate (e.g., text panels, title-only updates).
 */
async function maybeValidateQueries(
  client: GrafanaClient,
  targets: Target[] | undefined,
  panel: Panel,
  allPanels: Panel[],
): Promise<QueryValidation | undefined> {
  if (!targets || targets.length === 0) return undefined;
  const dsUid = resolveDatasourceUid(panel, allPanels);
  if (!dsUid) {
    return { validated: false, results: [], skippedReason: VALIDATION_SKIP_REASON };
  }
  return validateTargetQueries(client, targets, dsUid);
}

// ── Operation handlers ──────────────────────────────────────────────

async function handleAddPanel(
  client: GrafanaClient,
  dashboard: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
  panels: Panel[],
  params: Record<string, unknown>,
) {
  const panel = params.panel as Panel | undefined;
  if (!panel || !panel.title || !panel.type) {
    return jsonResult({
      error:
        "add_panel requires a 'panel' object with at least 'title' and 'type'. Example: { panel: { title: 'Error Rate', type: 'timeseries', targets: [...] } }",
    });
  }

  // Auto-assign panel ID
  const maxId = panels.reduce((max, p) => Math.max(max, (p.id as number) ?? 0), 0);
  panel.id = maxId + 1;

  // Auto-layout: place below existing panels unless explicit gridPos
  if (!panel.gridPos) {
    panel.gridPos = computeNextGridPos(panels);
  }

  panels.push(panel);
  dashboard.panels = panels;

  const queryValidation = await maybeValidateQueries(
    client, panel.targets as Target[] | undefined, panel, panels,
  );

  return saveDashboard(client, dashboard, meta, "add_panel", {
    id: panel.id as number,
    title: panel.title as string,
  }, undefined, queryValidation);
}

function handleRemovePanel(
  client: GrafanaClient,
  dashboard: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
  panels: Panel[],
  params: Record<string, unknown>,
) {
  const panelId = readNumberParam(params, "panelId");
  const panelTitle = readStringParam(params, "panelTitle");

  const target = findPanel(panels, panelId, panelTitle);
  if (!target) {
    const available = panels.map((p) => `id=${p.id} "${p.title}"`).join(", ");
    return jsonResult({
      error: `Panel not found. Available panels: ${available || "(none)"}`,
    });
  }

  const removed = { id: target.id as number, title: target.title as string };
  dashboard.panels = panels.filter((p) => p !== target);

  return saveDashboard(client, dashboard, meta, "remove_panel", removed);
}

async function handleUpdatePanel(
  client: GrafanaClient,
  dashboard: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
  panels: Panel[],
  params: Record<string, unknown>,
) {
  const panelId = readNumberParam(params, "panelId");
  const panelTitle = readStringParam(params, "panelTitle");
  const updates = params.updates as Record<string, unknown> | undefined;

  const target = findPanel(panels, panelId, panelTitle);
  if (!target) {
    const available = panels.map((p) => `id=${p.id} "${p.title}"`).join(", ");
    return jsonResult({
      error: `Panel not found. Available panels: ${available || "(none)"}`,
    });
  }

  if (!updates || Object.keys(updates).length === 0) {
    return jsonResult({ error: "update_panel requires a non-empty 'updates' object" });
  }

  Object.assign(target, updates);

  const queryValidation = await maybeValidateQueries(
    client, updates.targets as Target[] | undefined, target, panels,
  );

  return saveDashboard(client, dashboard, meta, "update_panel", {
    id: target.id as number,
    title: target.title as string,
  }, undefined, queryValidation);
}

function handleUpdateMetadata(
  client: GrafanaClient,
  dashboard: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
  params: Record<string, unknown>,
) {
  const title = readStringParam(params, "title");
  const description = readStringParam(params, "description");
  const tags = params.tags as string[] | undefined;
  const time = params.time as Record<string, unknown> | undefined;
  const refresh = readStringParam(params, "refresh");

  const changed: string[] = [];

  if (title !== undefined) {
    dashboard.title = title;
    changed.push("title");
  }
  if (description !== undefined) {
    dashboard.description = description;
    changed.push("description");
  }
  if (tags !== undefined) {
    dashboard.tags = tags;
    changed.push("tags");
  }
  if (time !== undefined) {
    dashboard.time = time;
    changed.push("time");
  }
  if (refresh !== undefined) {
    dashboard.refresh = refresh;
    changed.push("refresh");
  }

  if (changed.length === 0) {
    return jsonResult({
      error:
        "update_metadata requires at least one field: title, description, tags, time, or refresh",
    });
  }

  return saveDashboard(client, dashboard, meta, "update_metadata", undefined, changed);
}

async function handleDelete(
  client: GrafanaClient,
  uid: string,
  dashboard: Record<string, unknown>,
) {
  try {
    const result = await client.deleteDashboard(uid);
    return jsonResult({
      status: "deleted",
      uid,
      title: result.title ?? (dashboard.title as string),
      message: `Dashboard "${result.title ?? dashboard.title}" has been permanently deleted.`,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return jsonResult({ error: `Failed to delete dashboard: ${reason}` });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function findPanel(
  panels: Panel[],
  panelId: number | undefined,
  panelTitle: string | undefined,
): Panel | undefined {
  if (panelId !== undefined) {
    return panels.find((p) => p.id === panelId);
  }
  if (panelTitle !== undefined) {
    const lower = panelTitle.toLowerCase();
    return panels.find((p) =>
      ((p.title as string) ?? "").toLowerCase().includes(lower),
    );
  }
  return undefined;
}

function computeNextGridPos(panels: Panel[]): GridPos {
  if (panels.length === 0) {
    return { x: 0, y: 0, w: 12, h: 8 };
  }

  let maxBottom = 0;
  for (const p of panels) {
    const gp = p.gridPos as GridPos | undefined;
    if (gp) {
      const bottom = gp.y + gp.h;
      if (bottom > maxBottom) maxBottom = bottom;
    }
  }

  return { x: 0, y: maxBottom, w: 12, h: 8 };
}

async function saveDashboard(
  client: GrafanaClient,
  dashboard: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
  operation: string,
  affectedPanel?: { id: number; title: string },
  changedFields?: string[],
  queryValidation?: QueryValidation,
) {
  try {
    const result = await client.createDashboard({
      dashboard,
      folderUid: (meta?.folderUid as string) ?? undefined,
      message: `Updated by Grafana Lens agent (${operation})`,
      overwrite: true,
    });

    const response: Record<string, unknown> = {
      status: "updated",
      uid: result.uid,
      url: client.dashboardUrl(result.uid),
      version: result.version,
      operation,
      panelCount: ((dashboard.panels as Panel[]) ?? []).length,
      message: `Dashboard updated successfully (${operation}).`,
    };

    if (affectedPanel) {
      response.affectedPanel = affectedPanel;
    }
    if (changedFields) {
      response.changedFields = changedFields;
    }
    if (queryValidation) {
      response.queryValidation = queryValidation;
    }

    return jsonResult(response);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return jsonResult({ error: `Failed to update dashboard: ${reason}` });
  }
}
