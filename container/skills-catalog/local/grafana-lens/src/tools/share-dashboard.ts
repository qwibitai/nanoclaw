/**
 * grafana_share_dashboard tool
 *
 * Renders dashboard panels as PNG images and delivers them via the MEDIA:
 * pattern so they appear inline in the user's messaging channel.
 *
 * Three-tier fallback: render PNG → snapshot URL → deep link.
 * This ensures the user always gets *something*, even if the Grafana
 * Image Renderer plugin isn't installed.
 *
 * imageResult() is NOT exported from plugin-sdk — we construct the
 * AgentToolResult manually with both text (MEDIA: prefix) and image content.
 */

import { jsonResult, readStringParam, readNumberParam } from "openclaw/plugin-sdk";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GrafanaClient } from "../grafana-client.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";

// ── PNG dimension validation ─────────────────────────────────────────

/**
 * Extract width/height from a PNG IHDR chunk (bytes 16-23, big-endian).
 * Returns null if the buffer is too small or not a valid PNG.
 */
export function getPNGDimensions(buffer: ArrayBuffer): { width: number; height: number } | null {
  if (buffer.byteLength < 24) return null;
  const sig = new Uint8Array(buffer, 0, 4);
  // PNG magic: 0x89 0x50 0x4E 0x47
  if (sig[0] !== 0x89 || sig[1] !== 0x50 || sig[2] !== 0x4E || sig[3] !== 0x47) return null;
  const view = new DataView(buffer);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

// ── Render failure classification ────────────────────────────────────

export type RenderFailureInfo = {
  rendererAvailable: boolean;
  renderFailureReason: string;
  remediation?: string;
};

/**
 * Classify a render error into actionable information for the agent.
 * Infers renderer availability from the error type — 502 means the
 * Image Renderer plugin is missing; other errors mean the renderer
 * exists but something else went wrong.
 */
export function classifyRenderFailure(err: unknown): RenderFailureInfo {
  const message = err instanceof Error ? err.message : String(err);

  if (message.includes("Image Renderer not available")) {
    return {
      rendererAvailable: false,
      renderFailureReason: "Image Renderer plugin not installed",
      remediation:
        "Install grafana-image-renderer plugin for PNG export: https://grafana.com/docs/grafana/latest/setup-grafana/image-rendering/",
    };
  }

  if (message.includes("authentication failed")) {
    return {
      rendererAvailable: true,
      renderFailureReason: message,
      remediation: "Check that the service account token has viewer permissions on this dashboard",
    };
  }

  // For 404 (panel/dashboard not found) and other errors,
  // the renderer is available — the request itself was the problem
  return {
    rendererAvailable: true,
    renderFailureReason: message,
  };
}

export function createShareDashboardToolFactory(config: ValidatedGrafanaLensConfig) {
  const client = new GrafanaClient({
    url: config.grafana.url,
    apiKey: config.grafana.apiKey,
    orgId: config.grafana.orgId,
  });

  return (_ctx: unknown) => ({
    name: "grafana_share_dashboard",
    label: "Share Dashboard",
    description: [
      "Render a Grafana dashboard panel as an image and deliver it inline in messaging.",
      "WORKFLOW: Use after creating a dashboard or when user asks to 'show me' a chart.",
      "Requires dashboardUid and panelId. Three-tier fallback: PNG image → snapshot URL → deep link.",
      "Response includes rendererAvailable flag and remediation guidance when image rendering fails.",
      "Use grafana_search to find the dashboard UID, then grafana_get_dashboard to find panel IDs.",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        dashboardUid: {
          type: "string",
          description: "Dashboard UID (from grafana_create_dashboard or grafana_search result)",
        },
        panelId: {
          type: "number",
          description: "Panel ID to render (use grafana_get_dashboard to find panel IDs)",
        },
        from: {
          type: "string",
          description: "Time range start (e.g., 'now-6h', 'now-1d'). Default: 'now-6h'",
        },
        to: {
          type: "string",
          description: "Time range end (e.g., 'now'). Default: 'now'",
        },
        width: {
          type: "number",
          description: "Image width in pixels. Default: 1000",
        },
        height: {
          type: "number",
          description: "Image height in pixels. Default: 500",
        },
        theme: {
          type: "string",
          enum: ["light", "dark"],
          description: "Dashboard theme. Default: 'dark'",
        },
      },
      required: ["dashboardUid", "panelId"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const dashboardUid = readStringParam(params, "dashboardUid", { required: true, label: "Dashboard UID" });
      const panelId = readNumberParam(params, "panelId", { required: true, label: "Panel ID" }) as number;
      const from = readStringParam(params, "from") ?? "now-6h";
      const to = readStringParam(params, "to") ?? "now";
      const width = readNumberParam(params, "width") ?? 1000;
      const height = readNumberParam(params, "height") ?? 500;
      const theme = (readStringParam(params, "theme") ?? "dark") as "light" | "dark";

      const dashboardUrl = client.dashboardUrl(dashboardUid);

      // Pre-validate: fetch dashboard and check that panelId exists
      let dashData: { dashboard: Record<string, unknown> } | null = null;
      try {
        dashData = await client.getDashboard(dashboardUid) as { dashboard: Record<string, unknown> };
        const panels = (dashData.dashboard.panels ?? []) as Array<Record<string, unknown>>;
        // Flatten row panels — rows contain nested panels
        const allPanels = panels.flatMap((p) =>
          p.type === "row" && Array.isArray(p.panels) ? [p, ...(p.panels as Array<Record<string, unknown>>)] : [p],
        );
        const panelExists = allPanels.some((p) => p.id === panelId);
        if (!panelExists) {
          const validIds = allPanels.filter((p) => p.type !== "row").map((p) => `${p.id} (${p.title})`);
          return jsonResult({
            error: `Panel ${panelId} not found in dashboard ${dashboardUid}`,
            availablePanels: validIds,
            dashboardUrl,
          });
        }
      } catch {
        // Dashboard fetch failed — continue to render attempt (render will fail with its own error)
      }

      // Track render failure for Tier 2/3 responses
      let renderFailure: RenderFailureInfo | null = null;

      // Tier 1: Try rendering panel as PNG
      try {
        const imageBuffer = await client.renderPanel(dashboardUid, panelId, {
          width,
          height,
          from,
          to,
          theme,
        });

        // Detect placeholder PNG: Grafana returns HTTP 200 with a static
        // 478×208 warning image when Image Renderer is not installed.
        // A real render matches the requested dimensions.
        const dims = getPNGDimensions(imageBuffer);
        if (dims && (dims.width !== width || dims.height !== height)) {
          throw new Error(
            "Image Renderer not available — Grafana returned a placeholder image instead of the rendered panel",
          );
        }

        const base64 = Buffer.from(imageBuffer).toString("base64");
        const tmpPath = join(tmpdir(), `grafana-lens-${Date.now()}-panel-${panelId}.png`);
        await writeFile(tmpPath, Buffer.from(imageBuffer));

        // Best-effort cleanup after 30s (gives media parser time to read the file)
        setTimeout(() => { unlink(tmpPath).catch(() => {}); }, 30_000);

        // Construct AgentToolResult manually (imageResult not exported from SDK)
        return {
          content: [
            {
              type: "text" as const,
              text: `MEDIA:${tmpPath}\nPanel ${panelId} from dashboard ${dashboardUid} (${from} to ${to}).\nDashboard: ${dashboardUrl}`,
            },
            {
              type: "image" as const,
              data: base64,
              mimeType: "image/png",
            },
          ],
          details: {
            dashboardUid,
            panelId,
            path: tmpPath,
            deliveryTier: "image" as const,
            rendererAvailable: true,
          },
        };
      } catch (err) {
        renderFailure = classifyRenderFailure(err);
      }

      // Tier 2: Try creating a snapshot (reuse dashData if already fetched)
      try {
        if (!dashData) {
          dashData = await client.getDashboard(dashboardUid) as { dashboard: Record<string, unknown> };
        }
        const dashboard = dashData.dashboard;
        const snapshot = await client.createSnapshot(dashboard, {
          name: `Panel ${panelId} snapshot`,
          expires: 86400, // 24h
        });

        return jsonResult({
          status: "snapshot",
          deliveryTier: "snapshot",
          snapshotUrl: snapshot.url,
          dashboardUrl,
          rendererAvailable: renderFailure?.rendererAvailable ?? false,
          renderFailureReason: renderFailure?.renderFailureReason,
          ...(renderFailure?.remediation ? { remediation: renderFailure.remediation } : {}),
          message: `Image rendering unavailable — created a snapshot instead. View: ${snapshot.url}`,
        });
      } catch (snapshotErr) {
        // Tier 2 failed — fall back to deep link with both failure reasons
        const snapshotReason = snapshotErr instanceof Error ? snapshotErr.message : String(snapshotErr);

        return jsonResult({
          status: "link",
          deliveryTier: "link",
          dashboardUrl,
          rendererAvailable: renderFailure?.rendererAvailable ?? false,
          renderFailureReason: renderFailure?.renderFailureReason,
          snapshotFailureReason: snapshotReason,
          remediation: renderFailure?.remediation
            ?? "Install grafana-image-renderer plugin for PNG export or check Grafana snapshot API permissions",
          message: `Image rendering and snapshots unavailable. View the dashboard directly: ${dashboardUrl}`,
        });
      }
    },
  });
}
