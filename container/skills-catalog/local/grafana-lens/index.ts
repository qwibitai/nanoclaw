/**
 * Grafana Lens — OpenClaw Extension Entry Point
 *
 * This is the main entry point for the Grafana Lens extension.
 * It follows the same pattern as diagnostics-otel:
 *
 *   1. Export a default OpenClawPluginDefinition
 *   2. In register(), set up services and tools using the Plugin API
 *   3. Services handle background work (metrics collection via OTLP push)
 *   4. Tools handle agent-invoked actions (dashboard creation)
 *
 * Architecture (self-contained — all Grafana interaction via bundled GrafanaClient):
 *   - MetricsCollector service: subscribes to diagnostic events → pushes via OTLP
 *   - createDashboardTool: agent tool wrapping Grafana's dashboard API
 *   - Skill file (skills/SKILL.md): teaches the agent when to use these tools
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createRequire } from "node:module";
import { parseConfig, validateConfig } from "./src/config.js";
import { GrafanaClient } from "./src/grafana-client.js";
import { createMetricsCollectorService } from "./src/services/metrics-collector.js";

const require = createRequire(import.meta.url);
const { version: PLUGIN_VERSION } = require("./package.json") as { version: string };
import { createAlertWebhookService } from "./src/services/alert-webhook.js";
import { createDashboardToolFactory } from "./src/tools/create-dashboard.js";
import { createQueryToolFactory } from "./src/tools/query.js";
import { createAlertToolFactory } from "./src/tools/create-alert.js";
import { createShareDashboardToolFactory } from "./src/tools/share-dashboard.js";
import { createAnnotateToolFactory } from "./src/tools/annotate.js";
import { createExploreDatasourcesToolFactory } from "./src/tools/explore-datasources.js";
import { createListMetricsToolFactory } from "./src/tools/list-metrics.js";
import { createSearchToolFactory } from "./src/tools/search.js";
import { createGetDashboardToolFactory } from "./src/tools/get-dashboard.js";
import { createCheckAlertsToolFactory } from "./src/tools/check-alerts.js";
import { createPushMetricsToolFactory } from "./src/tools/push-metrics.js";
import { createQueryLogsToolFactory } from "./src/tools/query-logs.js";
import { createUpdateDashboardToolFactory } from "./src/tools/update-dashboard.js";
import { createExplainMetricToolFactory } from "./src/tools/explain-metric.js";
import { createSecurityCheckToolFactory } from "./src/tools/security-check.js";
import { createQueryTracesToolFactory } from "./src/tools/query-traces.js";
import { createInvestigateToolFactory } from "./src/tools/investigate.js";
import type {
  SessionStartEvent, SessionStartCtx,
  SessionEndEvent, SessionEndCtx,
  LlmInputEvent, LlmInputCtx,
  LlmOutputEvent, LlmOutputCtx,
  AgentEndEvent, AgentEndCtx,
  MessageReceivedEvent, MessageReceivedCtx,
  MessageSentEvent, MessageSentCtx,
  BeforeCompactionEvent, BeforeCompactionCtx,
  AfterCompactionEvent, AfterCompactionCtx,
  SubagentSpawnedEvent, SubagentSpawnedCtx,
  SubagentEndedEvent, SubagentEndedCtx,
  AfterToolCallEvent, AfterToolCallCtx,
  BeforeResetEvent, BeforeResetCtx,
  BeforeToolCallEvent, BeforeToolCallCtx,
  GatewayStartEvent,
  GatewayStopEvent,
} from "./src/services/lifecycle-telemetry.js";

const plugin = {
  id: "openclaw-grafana-lens",
  name: "Grafana Lens",
  description:
    "Agent-driven Grafana — query, visualize, alert, and deliver to messaging channels",

  register(api: OpenClawPluginApi) {
    // ── Parse plugin config (never throws — credentials may be missing) ──
    const config = parseConfig(api.pluginConfig);
    if (config._warnings) {
      for (const w of config._warnings) api.logger.warn(`grafana-lens: ${w}`);
    }
    const validation = validateConfig(config);

    if (!validation.valid) {
      api.logger.warn(
        `grafana-lens: plugin loaded but Grafana tools are disabled — ${validation.errors.join("; ")}`,
      );
      return;
    }

    const validConfig = validation.config;
    api.logger.info(`grafana-lens: connecting to ${validConfig.grafana.url}`);

    // ── Verify Grafana connectivity on startup ─────────────────────
    const client = new GrafanaClient({
      url: validConfig.grafana.url,
      apiKey: validConfig.grafana.apiKey,
      orgId: validConfig.grafana.orgId,
    });

    client.healthCheck().then((ok) => {
      if (ok) {
        api.logger.info("grafana-lens: Grafana connection verified");
      } else {
        api.logger.warn(
          `grafana-lens: could not reach Grafana at ${validConfig.grafana.url} — dashboards will fail until connectivity is restored`,
        );
      }
    }).catch((err) => {
      api.logger.warn(`grafana-lens: failed to verify Grafana connection: ${err instanceof Error ? err.message : err}`);
    });

    // ── Register alert webhook service ───────────────────────────────
    const { service: alertService, store: alertStore } =
      createAlertWebhookService(validConfig, api.registerHttpRoute.bind(api));
    api.registerService(alertService);

    // ── Register metrics collector service ──────────────────────────
    const { service: metricsService, getCustomMetricsStore, getLifecycleTelemetry } =
      createMetricsCollectorService(validConfig, alertStore, PLUGIN_VERSION);
    api.registerService(metricsService);

    // ── Register agent tools ────────────────────────────────────────
    api.registerTool(createDashboardToolFactory(validConfig));
    api.registerTool(createQueryToolFactory(validConfig));
    api.registerTool(createAlertToolFactory(validConfig));
    api.registerTool(createShareDashboardToolFactory(validConfig));
    api.registerTool(createAnnotateToolFactory(validConfig));
    api.registerTool(createExploreDatasourcesToolFactory(validConfig));
    api.registerTool(createListMetricsToolFactory(validConfig, getCustomMetricsStore));
    api.registerTool(createSearchToolFactory(validConfig));
    api.registerTool(createGetDashboardToolFactory(validConfig));
    api.registerTool(createCheckAlertsToolFactory(validConfig, alertStore));
    api.registerTool(createPushMetricsToolFactory(validConfig, getCustomMetricsStore));
    api.registerTool(createQueryLogsToolFactory(validConfig));
    api.registerTool(createUpdateDashboardToolFactory(validConfig));
    api.registerTool(createExplainMetricToolFactory(validConfig));
    api.registerTool(createSecurityCheckToolFactory(validConfig));
    api.registerTool(createQueryTracesToolFactory(validConfig));
    api.registerTool(createInvestigateToolFactory(validConfig, alertStore));

    // ── Register before_agent_start hook for alert awareness ─────────
    api.on("before_agent_start", (_event: unknown, _ctx: unknown) => {
      const pending = alertStore.getPendingAlerts();
      if (pending.length === 0) return;

      const summary = pending
        .map(
          (a) =>
            `- [${a.status.toUpperCase()}] ${a.title} (${new Date(a.receivedAt).toISOString()})`,
        )
        .join("\n");

      return {
        prependContext: `GRAFANA ALERTS (${pending.length} pending):\n${summary}\nUse grafana_check_alerts to see details, then investigate with grafana_query.\n`,
      };
    });

    // ══════════════════════════════════════════════════════════════════
    // LIFECYCLE HOOKS — gen_ai-compliant session-scoped traces
    // Only registered when metrics/telemetry is enabled (default: true).
    // Follows memory-lancedb pattern: conditional hook registration.
    // When metrics disabled, skip registration entirely — avoids OpenClaw
    // invoking handlers and passing event data (LLM inputs, session state)
    // for users who explicitly opted out of telemetry.
    // ══════════════════════════════════════════════════════════════════

    if (validConfig.metrics?.enabled !== false) {
      // Helper for hooks not yet in the published PluginHookName type
      const apiOn = (name: string, handler: (...args: unknown[]) => void) =>
        (api as unknown as { on: (name: string, handler: (...args: unknown[]) => void) => void }).on(name, handler);

      // ── TIER 1: Critical (root-cause analysis + gen_ai compliance) ────

      api.on("session_start", (event: SessionStartEvent, ctx: SessionStartCtx) => {
        getLifecycleTelemetry()?.onSessionStart(event, ctx);
      });

      api.on("session_end", async (event: SessionEndEvent, ctx: SessionEndCtx) => {
        getLifecycleTelemetry()?.onSessionEnd(event, ctx);
        // Flush session summary log + trace spans immediately (avoid batch delay data loss)
        await getLifecycleTelemetry()?.flushAll();
      });

      api.on("llm_input", (event: LlmInputEvent, ctx: LlmInputCtx) => {
        getLifecycleTelemetry()?.onLlmInput(event, ctx);
      });

      api.on("llm_output", (event: LlmOutputEvent, ctx: LlmOutputCtx) => {
        getLifecycleTelemetry()?.onLlmOutput(event, ctx);
      });

      api.on("agent_end", async (event: AgentEndEvent, ctx: AgentEndCtx) => {
        getLifecycleTelemetry()?.onAgentEnd(event, ctx);
        // Flush FINAL summary log + closed root span immediately (same pattern as session_end)
        await getLifecycleTelemetry()?.flushAll();
      });

      // ── TIER 2: High value (operational awareness) ────────────────────

      api.on("message_received", (event: MessageReceivedEvent, ctx: MessageReceivedCtx) => {
        getLifecycleTelemetry()?.onMessageReceived(event, ctx);
      });

      api.on("message_sent", (event: MessageSentEvent, ctx: MessageSentCtx) => {
        getLifecycleTelemetry()?.onMessageSent(event, ctx);
      });

      api.on("before_compaction", (event: BeforeCompactionEvent, ctx: BeforeCompactionCtx) => {
        getLifecycleTelemetry()?.onBeforeCompaction(event, ctx);
      });

      api.on("after_compaction", (event: AfterCompactionEvent, ctx: AfterCompactionCtx) => {
        getLifecycleTelemetry()?.onAfterCompaction(event, ctx);
      });

      // ── TIER 3: Multi-agent visibility ────────────────────────────────

      // subagent_spawned/subagent_ended exist in openclaw source but are not yet
      // in the published npm PluginHookName type — cast needed (same as tool.loop pattern)
      apiOn("subagent_spawned", (event: unknown, ctx: unknown) => {
        getLifecycleTelemetry()?.onSubagentSpawned(
          event as SubagentSpawnedEvent,
          ctx as SubagentSpawnedCtx,
        );
      });

      apiOn("subagent_ended", (event: unknown, ctx: unknown) => {
        getLifecycleTelemetry()?.onSubagentEnded(
          event as SubagentEndedEvent,
          ctx as SubagentEndedCtx,
        );
      });

      // ── UPGRADED: after_tool_call → gen_ai execute_tool convention ────
      api.on("after_tool_call", (event: AfterToolCallEvent, ctx: AfterToolCallCtx) => {
        getLifecycleTelemetry()?.onAfterToolCall(event, ctx);
      });

      // ── TIER 4: New SRE hooks (Part 5) ─────────────────────────────────

      // before_reset — session context wipe detection
      apiOn("before_reset", (event: unknown, ctx: unknown) => {
        getLifecycleTelemetry()?.onBeforeReset(
          event as BeforeResetEvent,
          ctx as BeforeResetCtx,
        );
      });

      // before_tool_call — tool invocation intent + span pairing
      apiOn("before_tool_call", (event: unknown, ctx: unknown) => {
        getLifecycleTelemetry()?.onBeforeToolCall(
          event as BeforeToolCallEvent,
          ctx as BeforeToolCallCtx,
        );
      });

      // gateway_start — infrastructure availability
      apiOn("gateway_start", (event: unknown) => {
        getLifecycleTelemetry()?.onGatewayStart(event as GatewayStartEvent);
      });

      // gateway_stop — infrastructure shutdown
      apiOn("gateway_stop", (event: unknown) => {
        getLifecycleTelemetry()?.onGatewayStop(event as GatewayStopEvent);
      });

      api.logger.info("grafana-lens: registered 17 tools, services, and 16 lifecycle hooks");
    } else {
      api.logger.info("grafana-lens: registered 17 tools and services (lifecycle hooks skipped — metrics disabled)");
    }
  },
};

export default plugin;
