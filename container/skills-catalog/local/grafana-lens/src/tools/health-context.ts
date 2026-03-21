/**
 * Health context for well-known OpenClaw metrics.
 *
 * When grafana_query returns a value for a known metric, this module
 * provides SRE-grade interpretive context: status, thresholds, and
 * a human-readable description. This lets the agent act as a virtual
 * SRE without memorizing operational thresholds.
 *
 * Thresholds are defined in the shared metric-definitions registry
 * (src/metric-definitions.ts) — single source of truth.
 */

import { HEALTH_RULES_MAP, type HealthDirection } from "../metric-definitions.js";

export type HealthStatus = "healthy" | "warning" | "critical";

// Re-export from metric-definitions (canonical source) for backward compatibility
export type { HealthDirection } from "../metric-definitions.js";

export interface HealthContext {
  status: HealthStatus;
  thresholds: { warning: number; critical: number };
  description: string;
  direction: HealthDirection;
}

interface HealthRule {
  warning: number;
  critical: number;
  description: string;
  direction: HealthDirection;
}

/**
 * Well-known OpenClaw gauge metrics with operational thresholds.
 * Derived from the shared metric-definitions registry.
 * Only gauge metrics make sense here — counter/histogram values are
 * cumulative and need rate() for meaningful health assessment.
 */
const HEALTH_RULES: Record<string, HealthRule> = HEALTH_RULES_MAP;

/**
 * Evaluate a numeric value against a health rule.
 */
function evaluateHealth(value: number, rule: HealthRule): HealthStatus {
  if (rule.direction === "higher_is_worse") {
    if (value >= rule.critical) return "critical";
    if (value >= rule.warning) return "warning";
    return "healthy";
  }
  // lower_is_worse
  if (value <= rule.critical) return "critical";
  if (value <= rule.warning) return "warning";
  return "healthy";
}

/**
 * Extract a plain metric name from a PromQL expression.
 * Returns the name only for simple expressions (bare metric name,
 * optionally with label selectors). Complex expressions (rate, sum,
 * binary operators) return undefined — health context doesn't apply.
 */
export function extractMetricName(expr: string): string | undefined {
  // Match: metric_name or metric_name{labels}
  const match = expr.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\s*\{.*\})?\s*$/);
  return match?.[1];
}

/**
 * Resolve the health rule for a PromQL expression, if the metric is well-known.
 * Extracts the plain metric name and looks up the rule once. Use this to avoid
 * re-parsing the same expression in a loop (e.g., per instant query result).
 */
export function getHealthRule(expr: string): HealthRule | undefined {
  const metricName = extractMetricName(expr);
  if (!metricName) return undefined;
  return HEALTH_RULES[metricName];
}

/**
 * Evaluate a value against a resolved health rule.
 * Use with `getHealthRule()` for per-result evaluation without re-parsing expr.
 */
export function evaluateHealthContext(
  rule: HealthRule,
  value: string,
): HealthContext | undefined {
  const numValue = parseFloat(value);
  if (!isFinite(numValue)) return undefined;

  return {
    status: evaluateHealth(numValue, rule),
    thresholds: { warning: rule.warning, critical: rule.critical },
    description: rule.description,
    direction: rule.direction,
  };
}

/**
 * Get health context for a metric value, if the metric is well-known.
 * Returns undefined for unknown metrics or complex PromQL expressions.
 * Convenience wrapper over getHealthRule() + evaluateHealthContext().
 */
export function getHealthContext(
  expr: string,
  value: string,
): HealthContext | undefined {
  const rule = getHealthRule(expr);
  if (!rule) return undefined;
  return evaluateHealthContext(rule, value);
}

/** Exported for testing. */
export const _HEALTH_RULES = HEALTH_RULES;
