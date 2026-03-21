/**
 * grafana_check_alerts tool
 *
 * Seven actions in one tool:
 *   - list: Return pending alerts from the webhook store
 *   - acknowledge: Mark an alert as investigated
 *   - list_rules: List all configured alert rules from Grafana
 *   - delete_rule: Delete an alert rule by UID
 *   - silence / unsilence: Mute / unmute alerts during investigation
 *   - setup: Create webhook contact point + notification policy route in Grafana
 *
 * The "setup" action is idempotent — if the contact point already exists,
 * it returns the existing UID without creating a duplicate.
 */

import { jsonResult, readStringParam } from "openclaw/plugin-sdk";
import { GrafanaClient } from "../grafana-client.js";
import type { AlertRule, AlertRuleState, DatasourceListItem } from "../grafana-client.js";
import type { ValidatedGrafanaLensConfig } from "../config.js";
import type { AlertStore, StoredAlert } from "../services/alert-webhook.js";
import { getQueryCapability, type QueryToolName, type QueryLanguageName } from "./explore-datasources.js";

/** Shared context for enriching alert list responses with investigation hints. */
interface InvestigationContext {
  rulesByUid: Map<string, AlertRule>;
  rulesByName: Map<string, AlertRule>;
  dsMap: Map<string, DatasourceListItem>;
}

const CONTACT_POINT_NAME = "OpenClaw Alert Webhook";

export function createCheckAlertsToolFactory(
  config: ValidatedGrafanaLensConfig,
  store: AlertStore,
) {
  const client = new GrafanaClient({
    url: config.grafana.url,
    apiKey: config.grafana.apiKey,
    orgId: config.grafana.orgId,
  });

  return (_ctx: unknown) => ({
    name: "grafana_check_alerts",
    label: "Grafana Alerts",
    description: [
      "Check, acknowledge, silence, or set up Grafana alert webhooks. Manage alert rules (list/delete).",
      "WORKFLOW: Use action 'list' (default) to see pending alerts — includes suggestedInvestigation with ready-to-use query, tool, and datasource for immediate investigation.",
      "Use action 'acknowledge' with alertId to mark an alert as investigated.",
      "Use action 'list_rules' to see all configured alert rules with live evaluation state (normal/firing/pending/nodata/error), health, and lastEvaluation — one call for complete alert health. Set compact=true for minimal fields (uid, title, state, condition only).",
      "Use action 'delete_rule' with ruleUid to remove an alert rule permanently.",
      "Use action 'silence' to mute alerts matching specific labels during investigation (prevents repeat notifications).",
      "Use action 'unsilence' with silenceId to remove a silence after resolving.",
      "Use action 'setup' to create the webhook contact point and notification policy",
      "route — required once before alerts can notify the agent.",
      "Use action 'analyze' to detect alert fatigue — identifies always-firing, flapping, and high-frequency alert rules with optimization suggestions.",
      "Alerts created via grafana_create_alert auto-route to the webhook.",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["list", "acknowledge", "list_rules", "delete_rule", "silence", "unsilence", "setup", "analyze"],
          description: "Action to perform. Default: 'list'. Use 'analyze' to detect alert fatigue.",
        },
        alertId: {
          type: "string",
          description: "Alert ID to acknowledge (required for action 'acknowledge')",
        },
        matchers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "Label name" },
              value: { type: "string", description: "Label value" },
              isRegex: { type: "boolean", description: "Whether value is a regex. Default: false" },
            },
            required: ["name", "value"],
          },
          description: "Label matchers for silence (from alert's commonLabels). Required for action 'silence'.",
        },
        duration: {
          type: "string",
          description: "Silence duration (e.g., '2h', '30m', '1d'). Default: '2h'. Used with action 'silence'.",
        },
        comment: {
          type: "string",
          description: "Reason for silencing. Default: 'Silenced by agent during investigation'. Used with action 'silence'.",
        },
        ruleUid: {
          type: "string",
          description: "Alert rule UID to delete (required for action 'delete_rule'). Get UIDs from action 'list_rules'.",
        },
        silenceId: {
          type: "string",
          description: "Silence ID to remove (required for action 'unsilence')",
        },
        compact: {
          type: "boolean",
          description: "Return minimal fields only for list_rules — {uid, title, state, condition}. Drops folder, ruleGroup, health, lastEvaluation, for, labels, annotations, updated. Use in multi-tool chains. Default: false",
        },
        webhookUrl: {
          type: "string",
          description: "Webhook URL for Grafana to POST alerts to. Auto-detected from config if omitted. Only used with action 'setup'.",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const action = readStringParam(params, "action") ?? "list";

      switch (action) {
        case "list":
          return handleList();
        case "acknowledge":
          return handleAcknowledge(params);
        case "list_rules":
          return handleListRules(typeof params.compact === "boolean" ? params.compact : false);
        case "delete_rule":
          return handleDeleteRule(params);
        case "silence":
          return handleSilence(params);
        case "unsilence":
          return handleUnsilence(params);
        case "setup":
          return handleSetup(params);
        case "analyze":
          return handleAnalyze();
        default:
          return jsonResult({ error: `Unknown action '${action}'. Use: list, acknowledge, list_rules, delete_rule, silence, unsilence, setup, analyze` });
      }
    },
  });

  async function handleList() {
    const pending = store.getPendingAlerts();
    if (pending.length === 0) {
      return jsonResult({ status: "success", alerts: [], message: "No pending alerts" });
    }

    // Fetch alert rules + datasources in parallel to enrich alerts with investigation hints.
    // Placed after the empty-check to avoid 2 API round-trips when no alerts are pending.
    const enrichment = await fetchInvestigationContext();

    const MAX_INSTANCES = 5;
    return jsonResult({
      status: "success",
      alertCount: pending.length,
      alerts: pending.map((a) => {
        const allInstances = a.alerts ?? [];
        const instances = allInstances.slice(0, MAX_INSTANCES).map((inst) => ({
          status: inst.status,
          labels: inst.labels,
          annotations: inst.annotations,
          startsAt: inst.startsAt,
          values: inst.values,
        }));
        const investigation = buildInvestigationHint(a, enrichment);
        return {
          id: a.id,
          status: a.status,
          title: a.title,
          message: a.message,
          receivedAt: new Date(a.receivedAt).toISOString(),
          commonLabels: a.commonLabels,
          totalInstances: allInstances.length,
          ...(allInstances.length > MAX_INSTANCES ? { truncated: true } : {}),
          ...(investigation ? { suggestedInvestigation: investigation } : {}),
          instances,
        };
      }),
    });
  }

  /**
   * Fetch alert rules and datasources in parallel for enriching the list response.
   * Best-effort: if either fails, returns partial data — the list still works without enrichment.
   */
  async function fetchInvestigationContext(): Promise<InvestigationContext> {
    const [rulesResult, dsResult] = await Promise.allSettled([
      client.listAlertRules(),
      client.listDatasources(),
    ]);

    const rules = rulesResult.status === "fulfilled" ? rulesResult.value : [];
    const datasources = dsResult.status === "fulfilled" ? dsResult.value : [];

    const rulesByUid = new Map<string, AlertRule>();
    const rulesByName = new Map<string, AlertRule>();
    for (const r of rules) {
      rulesByUid.set(r.uid, r);
      rulesByName.set(r.title, r);
    }

    const dsMap = new Map<string, DatasourceListItem>();
    for (const ds of datasources) {
      dsMap.set(ds.uid, ds);
    }

    return { rulesByUid, rulesByName, dsMap };
  }

  function handleAcknowledge(params: Record<string, unknown>) {
    const alertId = readStringParam(params, "alertId", { required: true, label: "Alert ID" });

    const found = store.acknowledgeAlert(alertId);
    if (!found) {
      return jsonResult({ error: `Alert '${alertId}' not found` });
    }
    return jsonResult({ status: "acknowledged", alertId });
  }

  async function handleListRules(compact: boolean) {
    try {
      // Fetch rule definitions + evaluation state in parallel.
      // Eval state is best-effort: if the Prometheus endpoint fails, rules still return without state.
      const [rules, stateResult] = await Promise.allSettled([
        client.listAlertRules(),
        client.getAlertRuleStates(),
      ]).then(([rulesRes, stateRes]) => [
        rulesRes.status === "fulfilled" ? rulesRes.value : null,
        stateRes.status === "fulfilled" ? stateRes.value : null,
      ] as [AlertRule[] | null, Map<string, AlertRuleState> | null]);

      if (!rules) {
        return jsonResult({ error: "Failed to list alert rules — could not reach Grafana provisioning API" });
      }

      if (rules.length === 0) {
        return jsonResult({ status: "success", rules: [], message: "No alert rules configured" });
      }

      // ── Compact mode — {uid, title, state, condition} only ─────────
      if (compact) {
        return jsonResult({
          status: "success",
          ruleCount: rules.length,
          rules: rules.map((r) => {
            const evalState = stateResult?.get(r.uid);
            return {
              uid: r.uid,
              title: r.title,
              state: evalState ? normalizeState(evalState.state) : "unknown",
              condition: extractConditionSummary(r),
            };
          }),
        });
      }

      return jsonResult({
        status: "success",
        ruleCount: rules.length,
        rules: rules.map((r) => {
          const evalState = stateResult?.get(r.uid);
          return {
            uid: r.uid,
            title: r.title,
            folder: r.folderUID,
            ruleGroup: r.ruleGroup,
            state: evalState ? normalizeState(evalState.state) : "unknown",
            health: evalState?.health ?? "unknown",
            lastEvaluation: evalState?.lastEvaluation ?? null,
            for: r.for,
            labels: r.labels,
            annotations: r.annotations,
            condition: extractConditionSummary(r),
            updated: r.updated,
          };
        }),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return jsonResult({ error: `Failed to list alert rules: ${reason}` });
    }
  }

  async function handleDeleteRule(params: Record<string, unknown>) {
    const ruleUid = readStringParam(params, "ruleUid", { required: true, label: "Rule UID" });

    try {
      await client.deleteAlertRule(ruleUid);
      return jsonResult({
        status: "deleted",
        ruleUid,
        message: `Alert rule '${ruleUid}' deleted. It will no longer evaluate or fire.`,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return jsonResult({ error: `Failed to delete alert rule: ${reason}` });
    }
  }

  async function handleSilence(params: Record<string, unknown>) {
    const rawMatchers = params.matchers as Array<{ name: string; value: string; isRegex?: boolean }> | undefined;
    if (!rawMatchers || rawMatchers.length === 0) {
      return jsonResult({
        error: "silence requires 'matchers' — an array of label matchers from the alert's commonLabels. Example: [{ name: 'alertname', value: 'HighCost' }]",
      });
    }
    const matchers = rawMatchers.map((m) => ({
      name: m.name,
      value: m.value,
      isRegex: m.isRegex ?? false,
    }));
    const duration = readStringParam(params, "duration") ?? "2h";
    const comment = readStringParam(params, "comment") ?? "Silenced by agent during investigation";

    try {
      const result = await client.createSilence(matchers, duration, comment);
      return jsonResult({
        status: "silenced",
        silenceId: result.silenceID,
        duration,
        matchers,
        message: `Alerts matching ${matchers.map((m) => `${m.name}=${m.value}`).join(", ")} silenced for ${duration}. Use action 'unsilence' with silenceId '${result.silenceID}' to remove.`,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return jsonResult({ error: `Failed to create silence: ${reason}` });
    }
  }

  async function handleUnsilence(params: Record<string, unknown>) {
    const silenceId = readStringParam(params, "silenceId", { required: true, label: "Silence ID" });

    try {
      await client.deleteSilence(silenceId);
      return jsonResult({
        status: "unsilenced",
        silenceId,
        message: `Silence '${silenceId}' removed. Alerts will resume notifying.`,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return jsonResult({ error: `Failed to remove silence: ${reason}` });
    }
  }

  async function handleSetup(params: Record<string, unknown>) {
    const webhookUrl = readStringParam(params, "webhookUrl");

    try {
      // Check if contact point already exists
      const existing = await client.listContactPoints();
      const found = existing.find((cp) => cp.name === CONTACT_POINT_NAME);

      if (found) {
        return jsonResult({
          status: "already_exists",
          contactPointUid: found.uid,
          message: `Webhook contact point '${CONTACT_POINT_NAME}' already exists`,
        });
      }

      // Determine webhook URL
      const resolvedUrl = webhookUrl ?? resolveWebhookUrl(config);

      // Create webhook contact point
      const cp = await client.createContactPoint({
        name: CONTACT_POINT_NAME,
        type: "webhook",
        settings: {
          url: resolvedUrl,
          httpMethod: "POST",
        },
        disableResolveMessage: false,
      });

      // Add notification policy route for managed_by=openclaw alerts
      const policyTree = await client.getNotificationPolicies();

      // Check if route already exists
      const hasRoute = policyTree.routes?.some((r) =>
        r.matchers?.some(
          (m) => m.name === "managed_by" && m.value === "openclaw",
        ),
      );

      if (!hasRoute) {
        const routes = policyTree.routes ?? [];
        routes.push({
          receiver: CONTACT_POINT_NAME,
          matchers: [{ name: "managed_by", type: "=", value: "openclaw" }],
          continue: false,
        });
        await client.updateNotificationPolicies({
          ...policyTree,
          routes,
        });
      }

      return jsonResult({
        status: "created",
        contactPointUid: cp.uid,
        webhookUrl: resolvedUrl,
        message: `Webhook contact point created. Alerts with managed_by=openclaw will notify the agent.`,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return jsonResult({ error: `Failed to set up alert webhook: ${reason}` });
    }
  }

  /**
   * Analyze alert rules for fatigue patterns: always-firing, flapping, or high-frequency.
   * Uses rule eval state and last evaluation to classify each rule.
   */
  async function handleAnalyze() {
    try {
      const [rules, stateResult] = await Promise.allSettled([
        client.listAlertRules(),
        client.getAlertRuleStates(),
      ]).then(([rulesRes, stateRes]) => [
        rulesRes.status === "fulfilled" ? rulesRes.value : null,
        stateRes.status === "fulfilled" ? stateRes.value : null,
      ] as [AlertRule[] | null, Map<string, AlertRuleState> | null]);

      if (!rules) {
        return jsonResult({ error: "Failed to analyze alert rules — could not reach Grafana provisioning API" });
      }

      if (rules.length === 0) {
        return jsonResult({
          status: "success",
          totalRules: 0,
          fatigueReport: { alwaysFiring: [], flapping: [], healthy: 0 },
          overallHealth: "healthy" as const,
          suggestions: ["No alert rules configured. Use grafana_create_alert to set up monitoring."],
        });
      }

      const ALWAYS_FIRING_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h
      const alwaysFiring: Array<{ uid: string; title: string; firingDuration: string; suggestion: string }> = [];
      const flapping: Array<{ uid: string; title: string; state: string; health: string; suggestion: string }> = [];
      let healthy = 0;

      for (const rule of rules) {
        const evalState = stateResult?.get(rule.uid);
        const state = evalState ? normalizeState(evalState.state) : "unknown";
        const health = evalState?.health ?? "unknown";

        // Flapping detection first: rules with error health or nodata state suggest instability
        if (health === "error" || state === "nodata" || state === "error") {
          flapping.push({
            uid: rule.uid,
            title: rule.title,
            state,
            health,
            suggestion: state === "nodata"
              ? "Rule produces no data — check if metric exists and query is correct"
              : "Rule evaluation error — check datasource connectivity and query syntax",
          });
          continue;
        }

        if (state === "firing" && evalState?.lastEvaluation) {
          // Check if firing for > 24h
          const lastEvalTime = new Date(evalState.lastEvaluation).getTime();
          const firingAge = Date.now() - lastEvalTime;
          // If lastEvaluation is recent but state is firing, the rule has been continuously firing
          // We use the `for` duration + age heuristic: if firing and last eval is recent, it's been firing since before last eval
          if (firingAge < ALWAYS_FIRING_THRESHOLD_MS) {
            // Still actively firing — check if the rule's `for` plus active time suggests chronic firing
            // Heuristic: if state is firing and rule has been evaluated recently, it's actively firing
            // We flag it as always-firing only if we can determine long duration
            // For now, we check pending alerts in the store for additional context
            const pending = store.getPendingAlerts();
            const matchingAlert = pending.find((a) => {
              const firstInstance = a.alerts?.[0];
              if (!firstInstance?.generatorURL) return false;
              const ruleUid = extractRuleUidFromGeneratorUrl(firstInstance.generatorURL);
              return ruleUid === rule.uid;
            });

            if (matchingAlert) {
              const alertAge = Date.now() - matchingAlert.receivedAt;
              if (alertAge > ALWAYS_FIRING_THRESHOLD_MS) {
                alwaysFiring.push({
                  uid: rule.uid,
                  title: rule.title,
                  firingDuration: `${Math.round(alertAge / (60 * 60 * 1000))}h`,
                  suggestion: "Consider raising threshold, adding 'for' duration, or silencing if expected",
                });
                continue;
              }
            }
          } else {
            // Last eval was long ago but state is firing — chronic
            alwaysFiring.push({
              uid: rule.uid,
              title: rule.title,
              firingDuration: `>${Math.round(firingAge / (60 * 60 * 1000))}h`,
              suggestion: "Consider raising threshold, adding 'for' duration, or silencing if expected",
            });
            continue;
          }
        }

        healthy++;
      }

      const overallHealth = alwaysFiring.length > 3 || flapping.length > 3
        ? "severe_fatigue" as const
        : (alwaysFiring.length > 0 || flapping.length > 0 ? "moderate_fatigue" as const : "healthy" as const);

      const suggestions: string[] = [];
      if (alwaysFiring.length > 0) {
        suggestions.push(`${alwaysFiring.length} rule(s) always firing — review thresholds or add hysteresis with 'for' duration`);
      }
      if (flapping.length > 0) {
        suggestions.push(`${flapping.length} rule(s) in error/nodata state — review query syntax and datasource connectivity`);
      }
      if (suggestions.length === 0) {
        suggestions.push("All alert rules are healthy. No fatigue detected.");
      }

      return jsonResult({
        status: "success",
        totalRules: rules.length,
        fatigueReport: {
          alwaysFiring,
          flapping,
          healthy,
        },
        overallHealth,
        suggestions,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return jsonResult({ error: `Failed to analyze alert rules: ${reason}` });
    }
  }
}

/**
 * Map Grafana's Prometheus state names to agent-friendly values.
 * Grafana returns "inactive" for rules that aren't firing — map to "normal" for clarity.
 */
function normalizeState(s: string): string {
  if (s === "inactive") return "normal";
  return s;
}

function resolveWebhookUrl(config: ValidatedGrafanaLensConfig): string {
  const path = config.proactive?.webhookPath ?? "/grafana-lens/alerts";
  // Default to localhost gateway — user can override via webhookUrl param
  return `http://localhost:18789${path}`;
}

/**
 * Extract the primary query node (refId "A") from an alert rule's data array.
 * Returns the datasource UID and expression, or null if not found.
 */
function extractPrimaryQuery(rule: AlertRule): { datasourceUid: string; expr: string } | null {
  const queryNode = rule.data.find((d) => d.refId === "A");
  if (!queryNode) return null;
  const expr = queryNode.model?.expr;
  if (typeof expr !== "string" || expr.length === 0) return null;
  return { datasourceUid: queryNode.datasourceUid, expr };
}

/**
 * Extract a human-readable condition summary from an alert rule's data queries.
 * Falls back to the rule's condition refId if no PromQL/LogQL expression is found.
 */
function extractConditionSummary(rule: AlertRule): string {
  return extractPrimaryQuery(rule)?.expr ?? rule.condition;
}

/**
 * Extract rule UID from a Grafana generator URL.
 * Format: http://localhost:3000/alerting/<ruleUID>/edit (or /view)
 */
export function extractRuleUidFromGeneratorUrl(url: string): string | null {
  const match = url.match(/\/alerting\/([^/]+)\/(edit|view)/);
  return match?.[1] ?? null;
}

/**
 * Build a suggestedInvestigation hint for a pending alert by matching it to its rule.
 *
 * Resolution order:
 *   1. Extract rule UID from generatorURL in the first alert instance (most precise)
 *   2. Fall back to matching alert title to rule title
 */
function buildInvestigationHint(
  alert: StoredAlert,
  ctx: InvestigationContext,
): {
  datasourceUid: string;
  condition: string;
  tool: QueryToolName;
  queryLanguage: QueryLanguageName;
  hint: string;
} | null {
  // Resolve the alert rule
  let rule: AlertRule | undefined;

  // Try generatorURL first (more precise — contains rule UID)
  const firstInstance = alert.alerts?.[0];
  if (firstInstance?.generatorURL) {
    const ruleUid = extractRuleUidFromGeneratorUrl(firstInstance.generatorURL);
    if (ruleUid) rule = ctx.rulesByUid.get(ruleUid);
  }

  // Fall back to title match (alert title often contains rule title)
  if (!rule) {
    // Alert title format is "[FIRING:N] RuleName" — try to extract the rule name
    const titleMatch = alert.title.match(/\]\s*(.+)$/);
    const ruleName = titleMatch?.[1] ?? alert.title;
    rule = ctx.rulesByName.get(ruleName);
  }

  if (!rule) return null;

  // Extract the PromQL/LogQL expression and datasource from the query node
  const primary = extractPrimaryQuery(rule);
  if (!primary) return null;

  const { datasourceUid: dsUid, expr } = primary;
  // Skip internal expression datasources (__expr__)
  if (!dsUid || dsUid === "__expr__") return null;

  // Look up datasource type for tool routing — skip if datasource not found
  const ds = ctx.dsMap.get(dsUid);
  if (!ds) return null;
  const cap = getQueryCapability(ds.type);

  if (!cap.supported) return null;

  const hint = cap.queryLanguage === "LogQL"
    ? `Run this LogQL query with ${cap.queryTool} to investigate. Check for error patterns around the alert trigger time.`
    : `Run this PromQL query with ${cap.queryTool} to reproduce the alert condition. If the metric involves errors, also check logs with grafana_query_logs.`;

  return {
    datasourceUid: dsUid,
    condition: expr,
    tool: cap.queryTool,
    queryLanguage: cap.queryLanguage,
    hint,
  };
}
