/**
 * Sprint Smoke Test — 3-gate pre-sprint health check.
 *
 * Validates that the system meets the same prerequisites as the parallel
 * dispatch metrics gate before a sprint can safely begin:
 *
 *   Gate 1: ≥3 distinct non-test agents
 *   Gate 2: ≥7 calendar days of notification history
 *   Gate 3: No test-seeded rows present
 *
 * Used as a pre-flight check before enabling parallel dispatch or starting
 * a new sprint cycle.
 */

export interface GateStats {
  agent_count: number;
  date_range_days: number;
  has_test_rows: boolean;
  test_agents: string[];
}

export interface GateResult {
  pass: boolean;
  fail_reasons: string[];
  stats: GateStats;
}

const MIN_AGENTS = 3;
const MIN_DATE_RANGE_DAYS = 7;

/**
 * Evaluate the 3-gate pre-sprint health check against the provided stats.
 */
export function evaluateGates(stats: GateStats): GateResult {
  const fail_reasons: string[] = [];

  if (stats.agent_count < MIN_AGENTS) {
    fail_reasons.push(
      `Insufficient agents: ${stats.agent_count} < ${MIN_AGENTS} required`,
    );
  }

  if (stats.date_range_days < MIN_DATE_RANGE_DAYS) {
    fail_reasons.push(
      `Insufficient history: ${stats.date_range_days} days < ${MIN_DATE_RANGE_DAYS} required`,
    );
  }

  if (stats.has_test_rows) {
    const agents = stats.test_agents.length > 0
      ? ` (${stats.test_agents.join(', ')})`
      : '';
    fail_reasons.push(`Test rows detected${agents}`);
  }

  return {
    pass: fail_reasons.length === 0,
    fail_reasons,
    stats,
  };
}
