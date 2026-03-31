/**
 * Health monitoring for NanoClaw.
 *
 * Periodically checks Telegram API reachability and exposes a health status
 * that the internal HTTP endpoint and iOS channel can read.
 *
 * If 3 of the last 5 checks fail, triggers a graceful restart via SIGTERM.
 */
import https from 'https';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes
const WINDOW_SIZE = 5;
const FAILURE_THRESHOLD = 3;

export interface HealthStatus {
  status: 'ok' | 'degraded' | 'unhealthy';
  uptime: number;
  telegram: { reachable: boolean; lastCheck: string | null };
  containers: { available: boolean; runtime: string };
  lastMessageAt: string | null;
}

// Sliding window of recent check results (true = pass, false = fail)
const checkResults: boolean[] = [];

let telegramReachable = true;
let lastCheckTime: string | null = null;
let containerAvailable = true;
let containerRuntime = 'docker';
let lastMessageAt: string | null = null;
let isShuttingDown = false;
let checkTimer: ReturnType<typeof setInterval> | null = null;

const startTime = Date.now();

/** Mark that a message was just processed. */
export function recordMessageProcessed(): void {
  lastMessageAt = new Date().toISOString();
}

/** Update container runtime status (called from container-runtime.ts). */
export function setContainerStatus(available: boolean, runtime?: string): void {
  containerAvailable = available;
  if (runtime) containerRuntime = runtime;
}

/** Mark that the process is shutting down. */
export function setShuttingDown(): void {
  isShuttingDown = true;
}

/** Get current health status for the HTTP endpoint. */
export function getHealthStatus(): HealthStatus {
  const failCount = checkResults.filter((r) => !r).length;

  let status: HealthStatus['status'] = 'ok';
  if (isShuttingDown) {
    status = 'unhealthy';
  } else if (!containerAvailable || failCount >= FAILURE_THRESHOLD) {
    status = failCount >= FAILURE_THRESHOLD ? 'unhealthy' : 'degraded';
  }

  return {
    status,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    telegram: { reachable: telegramReachable, lastCheck: lastCheckTime },
    containers: { available: containerAvailable, runtime: containerRuntime },
    lastMessageAt,
  };
}

/**
 * Get a minimal health status for the public-facing /api/health proxy.
 * Excludes lastMessageAt to avoid leaking family activity patterns.
 */
export function getPublicHealthStatus(): { status: string } {
  return { status: getHealthStatus().status };
}

/** Check Telegram API reachability via raw HTTPS GET to /bot<token>/getMe. */
async function checkTelegram(): Promise<boolean> {
  const env = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn('Health check: no TELEGRAM_BOT_TOKEN, skipping Telegram check');
    return true; // Can't check without a token — don't count as failure
  }

  return new Promise<boolean>((resolve) => {
    const req = https.get(
      `https://api.telegram.org/bot${token}/getMe`,
      { timeout: 10000 },
      (res) => {
        // Consume response body to free the socket
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** Run a single health check cycle. */
async function runCheck(): Promise<void> {
  const ok = await checkTelegram();
  telegramReachable = ok;
  lastCheckTime = new Date().toISOString();

  // Sliding window: keep only last WINDOW_SIZE results
  checkResults.push(ok);
  if (checkResults.length > WINDOW_SIZE) checkResults.shift();

  const failCount = checkResults.filter((r) => !r).length;

  if (ok) {
    logger.debug('Health check: Telegram reachable');
  } else {
    logger.warn(
      { failCount, window: WINDOW_SIZE },
      'Health check: Telegram unreachable',
    );
  }

  // Trigger graceful restart if threshold exceeded
  if (
    checkResults.length >= FAILURE_THRESHOLD &&
    failCount >= FAILURE_THRESHOLD &&
    !isShuttingDown
  ) {
    logger.error(
      { failCount, window: WINDOW_SIZE },
      'Health check threshold exceeded — triggering graceful restart',
    );
    process.kill(process.pid, 'SIGTERM');
  }
}

/** Start the periodic health check. */
export function startHealthChecks(): void {
  // Run first check after 30 seconds (give Telegram time to connect)
  setTimeout(() => {
    runCheck().catch((err) => logger.error({ err }, 'Health check error'));
    // Then run on interval
    checkTimer = setInterval(() => {
      runCheck().catch((err) => logger.error({ err }, 'Health check error'));
    }, CHECK_INTERVAL);
  }, 30000);

  logger.info(
    {
      intervalMs: CHECK_INTERVAL,
      window: WINDOW_SIZE,
      threshold: FAILURE_THRESHOLD,
    },
    'Health checks started',
  );
}

/** Stop the periodic health check. */
export function stopHealthChecks(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}
