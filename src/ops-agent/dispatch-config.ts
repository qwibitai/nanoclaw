/**
 * Dispatch Config Consumer
 *
 * Fetches provider/model configuration from Agency HQ's dispatch-config API
 * and caches it locally. Polls periodically so config changes take effect
 * without a process restart.
 *
 * Falls back to env vars (AGENT_RUNNER_BACKEND, AGENT_CLI_BIN) when the API
 * is unavailable or returns no config.
 */
import { agencyFetch } from '../agency-hq-client.js';
import { AGENT_CLI_BIN, AGENT_RUNNER_BACKEND } from '../config.js';
import { logger } from '../logger.js';

// --- Types ---

export interface DispatchConfig {
  provider?: string;
  model?: string;
  cli_bin?: string;
}

export interface ResolvedConfig {
  provider: string;
  cliBin: string;
  model: string | undefined;
}

// --- Configuration ---

const POLL_INTERVAL_MS = parseInt(
  process.env.DISPATCH_CONFIG_POLL_MS || '60000',
  10,
);

// --- State ---

let cachedConfig: DispatchConfig | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// --- API ---

/**
 * Fetch dispatch-config from Agency HQ.
 * Returns the config object on success, null on any failure.
 */
export async function fetchDispatchConfig(): Promise<DispatchConfig | null> {
  try {
    const res = await agencyFetch('/dispatch-config/ops-agent');
    if (!res.ok) {
      logger.warn(
        { status: res.status },
        'dispatch-config: API returned non-ok status, using fallback',
      );
      return null;
    }
    const json = (await res.json()) as {
      success: boolean;
      data?: DispatchConfig;
    };
    if (!json.success || !json.data) {
      logger.warn(
        'dispatch-config: API returned no data, using fallback',
      );
      return null;
    }
    return json.data;
  } catch (err) {
    logger.warn(
      { err },
      'dispatch-config: Failed to fetch from Agency HQ, using fallback',
    );
    return null;
  }
}

/**
 * Resolve the effective config by merging API config over env var defaults.
 * API values take precedence when present; env vars are the fallback.
 */
export function resolveConfig(apiConfig: DispatchConfig | null): ResolvedConfig {
  return {
    provider: apiConfig?.provider || AGENT_RUNNER_BACKEND,
    cliBin: apiConfig?.cli_bin || AGENT_CLI_BIN,
    model: apiConfig?.model || undefined,
  };
}

/**
 * Get the current effective config (cached API + env fallback).
 */
export function getEffectiveConfig(): ResolvedConfig {
  return resolveConfig(cachedConfig);
}

/**
 * Refresh the cached config by fetching from Agency HQ.
 * Called on startup and periodically by the poll timer.
 */
export async function refreshConfig(): Promise<void> {
  const config = await fetchDispatchConfig();
  const prev = cachedConfig;
  cachedConfig = config;

  if (config) {
    const changed =
      prev?.provider !== config.provider ||
      prev?.model !== config.model ||
      prev?.cli_bin !== config.cli_bin;
    if (changed) {
      logger.info(
        {
          provider: config.provider,
          model: config.model,
          cliBin: config.cli_bin,
        },
        'dispatch-config: Updated from Agency HQ',
      );
    }
  }
}

/**
 * Start periodic polling for dispatch-config updates.
 * Fetches immediately on first call, then every POLL_INTERVAL_MS.
 * Returns a cleanup function to stop polling.
 */
export async function startConfigPolling(): Promise<() => void> {
  // Initial fetch
  await refreshConfig();

  const effective = getEffectiveConfig();
  logger.info(
    {
      provider: effective.provider,
      cliBin: effective.cliBin,
      model: effective.model,
      pollIntervalMs: POLL_INTERVAL_MS,
      source: cachedConfig ? 'api' : 'env-fallback',
    },
    'dispatch-config: Polling started',
  );

  pollTimer = setInterval(() => {
    refreshConfig().catch((err) => {
      logger.error({ err }, 'dispatch-config: Unexpected error during refresh');
    });
  }, POLL_INTERVAL_MS);

  return stopConfigPolling;
}

/**
 * Stop the config polling timer.
 */
export function stopConfigPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Reset internal state (for testing).
 */
export function _resetForTest(): void {
  cachedConfig = null;
  stopConfigPolling();
}
