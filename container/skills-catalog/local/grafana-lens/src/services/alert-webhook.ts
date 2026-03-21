/**
 * Alert Webhook Handler Service
 *
 * Receives Grafana alert notifications via HTTP webhook, stores them in a
 * bounded in-memory queue, and makes them available to the agent via the
 * `grafana_check_alerts` tool.
 *
 * The flow:
 *   Grafana alert fires → POST to /grafana-lens/alerts → stored here
 *   → agent sees alerts in prompt context (before_prompt_build hook)
 *   → agent investigates with grafana_query + grafana_annotate
 *
 * Design: bounded queue (max 50, 24h TTL) keeps memory usage predictable.
 * Grafana expects fast webhook responses, so we return 200 immediately
 * and process asynchronously.
 */

import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "openclaw/plugin-sdk";
import type { ValidatedGrafanaLensConfig } from "../config.js";

// ── Grafana webhook payload types ──────────────────────────────────

export type GrafanaAlertNotification = {
  receiver: string;
  status: "firing" | "resolved";
  orgId: number;
  alerts: GrafanaAlertInstance[];
  groupLabels: Record<string, string>;
  commonLabels: Record<string, string>;
  externalURL: string;
  title: string;
  state: string;
  message: string;
};

export type GrafanaAlertInstance = {
  status: "firing" | "resolved";
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt: string;
  generatorURL: string;
  fingerprint: string;
  values: Record<string, number>;
};

// ── Internal stored alert type ─────────────────────────────────────

export type StoredAlert = {
  id: string;
  receivedAt: number;
  acknowledged: boolean;
  title: string;
  status: "firing" | "resolved";
  message: string;
  alerts: GrafanaAlertInstance[];
  commonLabels: Record<string, string>;
  groupLabels: Record<string, string>;
  externalURL: string;
};

// ── Alert Store ────────────────────────────────────────────────────

const MAX_ALERTS = 50;
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type AlertStore = {
  getPendingAlerts(): StoredAlert[];
  getAllAlerts(): StoredAlert[];
  getAlert(id: string): StoredAlert | undefined;
  acknowledgeAlert(id: string): boolean;
  acknowledgeAll(): number;
  addAlert(notification: GrafanaAlertNotification): StoredAlert;
  size(): number;
  /** Total received count (including evicted), partitioned by status. */
  totalReceived(): { firing: number; resolved: number };
};

export function createAlertStore(): AlertStore {
  const alerts: StoredAlert[] = [];
  let counter = 0;
  let firingCount = 0;
  let resolvedCount = 0;

  function evict(): void {
    const now = Date.now();
    // Remove expired alerts
    for (let i = alerts.length - 1; i >= 0; i--) {
      if (now - alerts[i].receivedAt > TTL_MS) {
        alerts.splice(i, 1);
      }
    }
    // Remove oldest if over capacity
    while (alerts.length > MAX_ALERTS) {
      alerts.shift();
    }
  }

  return {
    getPendingAlerts(): StoredAlert[] {
      evict();
      return alerts.filter((a) => !a.acknowledged);
    },

    getAllAlerts(): StoredAlert[] {
      evict();
      return [...alerts];
    },

    getAlert(id: string): StoredAlert | undefined {
      return alerts.find((a) => a.id === id);
    },

    acknowledgeAlert(id: string): boolean {
      const alert = alerts.find((a) => a.id === id);
      if (!alert) return false;
      alert.acknowledged = true;
      return true;
    },

    acknowledgeAll(): number {
      let count = 0;
      for (const alert of alerts) {
        if (!alert.acknowledged) {
          alert.acknowledged = true;
          count++;
        }
      }
      return count;
    },

    addAlert(notification: GrafanaAlertNotification): StoredAlert {
      evict();
      if (notification.status === "firing") firingCount++;
      else resolvedCount++;
      const stored: StoredAlert = {
        id: `alert-${++counter}`,
        receivedAt: Date.now(),
        acknowledged: false,
        title: notification.title,
        status: notification.status,
        message: notification.message,
        alerts: notification.alerts,
        commonLabels: notification.commonLabels,
        groupLabels: notification.groupLabels,
        externalURL: notification.externalURL,
      };
      alerts.push(stored);
      return stored;
    },

    size(): number {
      evict();
      return alerts.length;
    },

    totalReceived(): { firing: number; resolved: number } {
      return { firing: firingCount, resolved: resolvedCount };
    },
  };
}

// ── HTTP request/response types (minimal interfaces for the webhook handler) ──

type HttpRequest = {
  method?: string;
  on(event: string, cb: (data?: unknown) => void): void;
};

export type AlertWebhookHttpResponse = {
  writeHead(status: number, headers?: Record<string, string>): void;
  end(data?: string): void;
};

// ── Service factory ────────────────────────────────────────────────

export function createAlertWebhookService(
  config: ValidatedGrafanaLensConfig,
  registerHttpRoute: (params: {
    path: string;
    handler: (req: unknown, res: AlertWebhookHttpResponse) => Promise<void> | void;
  }) => void,
): { service: OpenClawPluginService; store: AlertStore } {
  const store = createAlertStore();

  const service: OpenClawPluginService = {
    id: "grafana-lens-alert-webhook",

    async start(ctx: OpenClawPluginServiceContext) {
      if (!config.proactive?.enabled) {
        ctx.logger.info("grafana-lens: alert webhook disabled (proactive.enabled = false)");
        return;
      }

      const webhookPath = config.proactive?.webhookPath ?? "/grafana-lens/alerts";

      registerHttpRoute({
        path: webhookPath,
        handler: async (req: unknown, res: AlertWebhookHttpResponse) => {
          const httpReq = req as HttpRequest;

          // Only accept POST
          if (httpReq.method !== "POST") {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed" }));
            return;
          }

          // Collect request body
          const chunks: Buffer[] = [];
          await new Promise<void>((resolve, reject) => {
            httpReq.on("data", (chunk: unknown) => {
              chunks.push(Buffer.from(chunk as Uint8Array));
            });
            httpReq.on("end", () => resolve());
            httpReq.on("error", (err: unknown) => reject(err));
          });

          try {
            const body = Buffer.concat(chunks).toString("utf-8");
            const notification = JSON.parse(body) as GrafanaAlertNotification;

            // Validate minimal fields
            if (!notification.status || !Array.isArray(notification.alerts)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid alert notification payload" }));
              return;
            }

            const stored = store.addAlert(notification);
            ctx.logger.info(
              `grafana-lens: received alert webhook — ${notification.status}: ${notification.title} (${notification.alerts.length} instances, id: ${stored.id})`,
            );

            // Return 200 immediately (Grafana expects fast responses)
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "received", id: stored.id }));
          } catch (err) {
            ctx.logger.error(`grafana-lens: failed to parse alert webhook: ${err}`);
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to parse notification payload" }));
          }
        },
      });

      ctx.logger.info(`grafana-lens: alert webhook handler started (${webhookPath})`);
    },
  };

  return { service, store };
}
