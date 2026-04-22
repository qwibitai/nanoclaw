/**
 * Config Verification Engine
 *
 * Checks dispatch-config for a given role (ops-agent, workers, reviewers,
 * watchdog) against expected values. Returns structured results that the
 * CLI formatter renders with ✅/❌ indicators.
 */
import { execSync } from 'child_process';

import { AGENCY_HQ_URL } from '../config.js';
import { PARALLEL_DISPATCH_WORKERS } from '../dispatch-pool-constants.js';
import {
  SLOT_GRACE_PERIOD_MS,
  OPS_AGENT_WATCHDOG_INTERVAL,
} from '../ops-agent-watchdog.js';

// --- Types ---

export type VerifyComponent =
  | 'ops-agent'
  | 'workers'
  | 'reviewers'
  | 'watchdog';

export const VALID_COMPONENTS: VerifyComponent[] = [
  'ops-agent',
  'workers',
  'reviewers',
  'watchdog',
];

export interface CheckResult {
  label: string;
  pass: boolean;
  expected: string;
  actual: string;
  fix?: string;
}

export interface ComponentVerification {
  component: VerifyComponent;
  checks: CheckResult[];
  summary: { passed: number; failed: number };
}

// --- Expected defaults ---

interface ComponentExpectedConfig {
  provider: string;
  model: string | null;
  cliBin: string;
}

const EXPECTED_DEFAULTS: Record<VerifyComponent, ComponentExpectedConfig> = {
  'ops-agent': {
    provider: 'anthropic',
    model: null, // dynamic — fetched from dispatch-config API
    cliBin: 'claude',
  },
  workers: {
    provider: 'anthropic',
    model: null,
    cliBin: 'claude',
  },
  reviewers: {
    provider: 'anthropic',
    model: null,
    cliBin: 'claude',
  },
  watchdog: {
    provider: 'anthropic',
    model: null,
    cliBin: 'claude',
  },
};

// --- Helpers ---

async function fetchDispatchConfigForRole(
  role: string,
): Promise<{ provider?: string; model?: string; cli_bin?: string } | null> {
  try {
    const res = await fetch(`${AGENCY_HQ_URL}/api/v1/dispatch-config/${role}`, {
      signal: AbortSignal.timeout(5_000),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      success: boolean;
      data?: { provider?: string; model?: string; cli_bin?: string };
    };
    if (!json.success || !json.data) return null;
    return json.data;
  } catch {
    return null;
  }
}

async function fetchHealthSnapshot(): Promise<Record<string, unknown> | null> {
  const port = process.env.SKILL_SERVER_PORT || '3002';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isServiceActive(): boolean {
  try {
    const output = execSync('systemctl --user is-active nanoclaw 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return output === 'active';
  } catch {
    return false;
  }
}

function getTmuxSessions(prefix: string): string[] {
  try {
    const output = execSync(
      `tmux list-sessions -F '#{session_name}' 2>/dev/null || true`,
      { encoding: 'utf-8', timeout: 5_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    if (!output) return [];
    return output.split('\n').filter((name) => name.startsWith(prefix));
  } catch {
    return [];
  }
}

function getEnvValue(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

// --- Verification per component ---

async function verifyOpsAgent(): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const expected = EXPECTED_DEFAULTS['ops-agent'];

  // Fetch live config from Agency HQ
  const apiConfig = await fetchDispatchConfigForRole('ops-agent');
  const configSource = apiConfig ? 'api' : 'env-fallback';

  const runtimeProvider =
    apiConfig?.provider || getEnvValue('AGENT_RUNNER_BACKEND', 'claude');
  const runtimeModel = apiConfig?.model || undefined;
  const runtimeCliBin =
    apiConfig?.cli_bin || getEnvValue('AGENT_CLI_BIN', 'claude');

  checks.push({
    label: 'Config source',
    pass: apiConfig !== null,
    expected: 'api',
    actual: configSource,
    fix: apiConfig
      ? undefined
      : `Ensure Agency HQ is running at ${AGENCY_HQ_URL} and /dispatch-config/ops-agent returns data`,
  });

  checks.push({
    label: 'Provider',
    pass: runtimeProvider === expected.provider,
    expected: expected.provider,
    actual: runtimeProvider,
    fix:
      runtimeProvider !== expected.provider
        ? `Update dispatch-config provider to "${expected.provider}" or set AGENT_RUNNER_BACKEND=${expected.provider}`
        : undefined,
  });

  checks.push({
    label: 'CLI binary',
    pass: runtimeCliBin === expected.cliBin,
    expected: expected.cliBin,
    actual: runtimeCliBin,
    fix:
      runtimeCliBin !== expected.cliBin
        ? `Update dispatch-config cli_bin to "${expected.cliBin}" or set AGENT_CLI_BIN=${expected.cliBin}`
        : undefined,
  });

  checks.push({
    label: 'Model',
    pass: true, // model is dynamic, just report it
    expected: apiConfig?.model || '(dynamic)',
    actual: runtimeModel || '(not set)',
  });

  // Service status
  const serviceActive = isServiceActive();
  checks.push({
    label: 'Service active (systemd)',
    pass: serviceActive,
    expected: 'active',
    actual: serviceActive ? 'active' : 'inactive',
    fix: serviceActive
      ? undefined
      : 'Run: systemctl --user start nanoclaw',
  });

  // Agency HQ reachability
  checks.push({
    label: 'Agency HQ reachable',
    pass: apiConfig !== null,
    expected: 'reachable',
    actual: apiConfig !== null ? 'reachable' : 'unreachable',
    fix: apiConfig
      ? undefined
      : `Check that Agency HQ is running at ${AGENCY_HQ_URL}`,
  });

  return checks;
}

async function verifyWorkers(): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const expected = EXPECTED_DEFAULTS.workers;

  // Fetch live config
  const apiConfig = await fetchDispatchConfigForRole('ops-agent');
  const configSource = apiConfig ? 'api' : 'env-fallback';

  const runtimeProvider =
    apiConfig?.provider || getEnvValue('AGENT_RUNNER_BACKEND', 'claude');
  const runtimeCliBin =
    apiConfig?.cli_bin || getEnvValue('AGENT_CLI_BIN', 'claude');

  checks.push({
    label: 'Config source',
    pass: apiConfig !== null,
    expected: 'api',
    actual: configSource,
    fix: apiConfig
      ? undefined
      : `Ensure Agency HQ is running at ${AGENCY_HQ_URL}`,
  });

  checks.push({
    label: 'Provider',
    pass: runtimeProvider === expected.provider,
    expected: expected.provider,
    actual: runtimeProvider,
    fix:
      runtimeProvider !== expected.provider
        ? `Update AGENT_RUNNER_BACKEND to "${expected.provider}"`
        : undefined,
  });

  checks.push({
    label: 'CLI binary',
    pass: runtimeCliBin === expected.cliBin,
    expected: expected.cliBin,
    actual: runtimeCliBin,
  });

  checks.push({
    label: 'Model',
    pass: true,
    expected: apiConfig?.model || '(dynamic)',
    actual: apiConfig?.model || getEnvValue('AGENT_RUNNER_BACKEND', 'claude'),
  });

  // Parallel dispatch mode
  const dispatchParallel = getEnvValue('DISPATCH_PARALLEL', 'unset');
  checks.push({
    label: 'Parallel dispatch mode',
    pass: dispatchParallel !== 'false',
    expected: 'enabled or auto',
    actual:
      dispatchParallel === 'true'
        ? 'force-enabled'
        : dispatchParallel === 'false'
          ? 'kill-switch (disabled)'
          : 'auto (metrics gate)',
    fix:
      dispatchParallel === 'false'
        ? 'Remove DISPATCH_PARALLEL=false to re-enable parallel dispatch'
        : undefined,
  });

  // Worker slot count
  checks.push({
    label: 'Worker slot count',
    pass: true,
    expected: String(PARALLEL_DISPATCH_WORKERS),
    actual: String(PARALLEL_DISPATCH_WORKERS),
  });

  // Active worker sessions
  const workerSessions = getTmuxSessions('nanoclaw-devworker');
  checks.push({
    label: 'Active worker sessions',
    pass: true,
    expected: `0-${PARALLEL_DISPATCH_WORKERS}`,
    actual: String(workerSessions.length),
  });

  return checks;
}

async function verifyReviewers(): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  const expected = EXPECTED_DEFAULTS.reviewers;

  // Fetch live config (reviewers share the ops-agent config endpoint)
  const apiConfig = await fetchDispatchConfigForRole('ops-agent');

  const runtimeProvider =
    apiConfig?.provider || getEnvValue('AGENT_RUNNER_BACKEND', 'claude');
  const runtimeCliBin =
    apiConfig?.cli_bin || getEnvValue('AGENT_CLI_BIN', 'claude');

  checks.push({
    label: 'Config source',
    pass: apiConfig !== null,
    expected: 'api',
    actual: apiConfig ? 'api' : 'env-fallback',
    fix: apiConfig
      ? undefined
      : `Ensure Agency HQ is running at ${AGENCY_HQ_URL}`,
  });

  checks.push({
    label: 'Provider',
    pass: runtimeProvider === expected.provider,
    expected: expected.provider,
    actual: runtimeProvider,
  });

  checks.push({
    label: 'CLI binary',
    pass: runtimeCliBin === expected.cliBin,
    expected: expected.cliBin,
    actual: runtimeCliBin,
  });

  checks.push({
    label: 'Model',
    pass: true,
    expected: apiConfig?.model || '(dynamic)',
    actual: apiConfig?.model || '(not set)',
  });

  // Health endpoint
  const health = await fetchHealthSnapshot();
  checks.push({
    label: 'Health endpoint',
    pass: health !== null,
    expected: 'responsive',
    actual: health !== null ? 'responsive' : 'unreachable',
    fix: health
      ? undefined
      : `Check that NanoClaw is running and health endpoint is at http://127.0.0.1:${getEnvValue('SKILL_SERVER_PORT', '3002')}/health`,
  });

  return checks;
}

async function verifyWatchdog(): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  // Service running
  const serviceActive = isServiceActive();
  checks.push({
    label: 'Service active (systemd)',
    pass: serviceActive,
    expected: 'active',
    actual: serviceActive ? 'active' : 'inactive',
    fix: serviceActive
      ? undefined
      : 'Run: systemctl --user start nanoclaw',
  });

  // Watchdog interval
  const intervalMin = Math.round(OPS_AGENT_WATCHDOG_INTERVAL / 60_000);
  checks.push({
    label: 'Watchdog interval',
    pass: true,
    expected: `${intervalMin} min`,
    actual: `${intervalMin} min`,
  });

  // Grace period
  const gracePeriodMin = Math.round(SLOT_GRACE_PERIOD_MS / 60_000);
  checks.push({
    label: 'Slot grace period',
    pass: true,
    expected: `${gracePeriodMin} min`,
    actual: `${gracePeriodMin} min`,
  });

  // Active tmux sessions (watchdog monitors these)
  const sessions = getTmuxSessions('nanoclaw-');
  checks.push({
    label: 'Active nanoclaw sessions',
    pass: true,
    expected: '(informational)',
    actual: String(sessions.length),
  });

  // Active worker sessions
  const workerSessions = getTmuxSessions('nanoclaw-devworker');
  checks.push({
    label: 'Active worker sessions',
    pass: true,
    expected: `0-${PARALLEL_DISPATCH_WORKERS}`,
    actual: String(workerSessions.length),
  });

  // Agency HQ reachable
  const apiConfig = await fetchDispatchConfigForRole('ops-agent');
  checks.push({
    label: 'Agency HQ reachable',
    pass: apiConfig !== null,
    expected: 'reachable',
    actual: apiConfig !== null ? 'reachable' : 'unreachable',
    fix: apiConfig
      ? undefined
      : `Check that Agency HQ is running at ${AGENCY_HQ_URL}`,
  });

  return checks;
}

// --- Public API ---

const COMPONENT_VERIFIERS: Record<
  VerifyComponent,
  () => Promise<CheckResult[]>
> = {
  'ops-agent': verifyOpsAgent,
  workers: verifyWorkers,
  reviewers: verifyReviewers,
  watchdog: verifyWatchdog,
};

export async function verifyComponent(
  component: VerifyComponent,
): Promise<ComponentVerification> {
  const checks = await COMPONENT_VERIFIERS[component]();
  const passed = checks.filter((c) => c.pass).length;
  const failed = checks.filter((c) => !c.pass).length;

  return {
    component,
    checks,
    summary: { passed, failed },
  };
}

export async function verifyAllComponents(): Promise<ComponentVerification[]> {
  const results: ComponentVerification[] = [];
  for (const component of VALID_COMPONENTS) {
    results.push(await verifyComponent(component));
  }
  return results;
}
