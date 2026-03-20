/**
 * X Integration Health Check
 *
 * Proactively detects when x-client-transaction-id is broken (Twitter
 * changed their frontend JS) and attempts auto-update when a fix is
 * available on npm.
 */

import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger as rootLogger } from './logger.js';
import { runScript } from './x-ipc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const logger = rootLogger.child({ module: 'x-health' });

const PACKAGE_NAME = 'x-client-transaction-id';
const HEALTH_CHECK_TIMEOUT_MS = 30_000;
const NPM_VIEW_TIMEOUT_MS = 15_000;
const NPM_INSTALL_TIMEOUT_MS = 60_000;

interface HealthCheckData {
  isTransactionIdError: boolean;
}

interface HealthCheckResult {
  healthy: boolean;
  isTransactionIdError: boolean;
  message: string;
}

/**
 * Spawn the health-check.ts script to probe x-client-transaction-id.
 */
export async function checkXHealth(): Promise<HealthCheckResult> {
  const result = await runScript('health-check', {}, HEALTH_CHECK_TIMEOUT_MS);

  if (result.success) {
    return { healthy: true, isTransactionIdError: false, message: result.message };
  }

  const data = result.data as HealthCheckData | undefined;
  const isTransactionIdError = data?.isTransactionIdError ?? false;

  return {
    healthy: false,
    isTransactionIdError,
    message: result.message,
  };
}

/**
 * Read the installed version of x-client-transaction-id from node_modules.
 */
export function getInstalledVersion(): string | null {
  const pkgPath = path.join(PROJECT_ROOT, 'node_modules', PACKAGE_NAME, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Query npm for the latest published version.
 */
export async function getLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const proc = execFile(
      npmBin,
      ['view', PACKAGE_NAME, 'version'],
      { timeout: NPM_VIEW_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          logger.warn({ err }, 'Failed to fetch latest version from npm');
          resolve(null);
          return;
        }
        const version = stdout.trim();
        resolve(version || null);
      },
    );
    proc.unref?.();
  });
}

/**
 * Update the overrides entry in package.json to pin a specific version.
 */
export function updateOverride(version: string): void {
  const pkgPath = path.join(PROJECT_ROOT, 'package.json');
  const raw = fs.readFileSync(pkgPath, 'utf-8');
  const pkg = JSON.parse(raw);

  if (!pkg.overrides) {
    pkg.overrides = {};
  }
  pkg.overrides[PACKAGE_NAME] = version;

  // Preserve formatting: detect indent from original file
  const indentMatch = raw.match(/^(\s+)"/m);
  const indent = indentMatch ? indentMatch[1].length : 2;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + '\n');
}

/**
 * Run npm install to apply the updated override.
 */
export async function runNpmInstall(): Promise<boolean> {
  return new Promise((resolve) => {
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const proc = execFile(
      npmBin,
      ['install'],
      { cwd: PROJECT_ROOT, timeout: NPM_INSTALL_TIMEOUT_MS },
      (err, _stdout, stderr) => {
        if (err) {
          logger.error({ err, stderrTail: stderr?.slice(-500) }, 'npm install failed');
          resolve(false);
          return;
        }
        resolve(true);
      },
    );
    proc.unref?.();
  });
}

/**
 * Orchestrate auto-update: check latest -> update override -> npm install -> re-check.
 * Returns true if the update fixed the issue.
 */
export async function attemptAutoUpdate(): Promise<boolean> {
  const installedVersion = getInstalledVersion();
  const latestVersion = await getLatestVersion();

  if (!latestVersion) {
    logger.warn('Cannot determine latest version, skipping auto-update');
    return false;
  }

  if (installedVersion === latestVersion) {
    logger.info(
      { version: installedVersion },
      'Already on latest version, no fix available yet',
    );
    return false;
  }

  logger.info(
    { from: installedVersion, to: latestVersion },
    'Newer version available, attempting update',
  );

  updateOverride(latestVersion);

  const installOk = await runNpmInstall();
  if (!installOk) {
    logger.error('npm install failed during auto-update');
    return false;
  }

  // Verify the fix worked
  const recheck = await checkXHealth();
  if (recheck.healthy) {
    logger.info(
      { version: latestVersion },
      'Auto-update successful, x-client-transaction-id is healthy',
    );
    return true;
  }

  logger.warn(
    { version: latestVersion, message: recheck.message },
    'Auto-update installed but package is still broken',
  );
  return false;
}

/**
 * Full health check cycle: probe -> auto-update if broken -> log results.
 */
export async function runXHealthCheck(): Promise<void> {
  logger.info('Starting X health check');

  const result = await checkXHealth();

  if (result.healthy) {
    logger.info('X integration health check passed');
    return;
  }

  if (!result.isTransactionIdError) {
    // Non-transaction-ID error (network, timeout, etc.) -- don't auto-update
    logger.warn(
      { message: result.message },
      'X health check failed with non-transaction-ID error, skipping auto-update',
    );
    return;
  }

  // Transaction ID error -- attempt auto-update
  logger.warn(
    { message: result.message },
    'x-client-transaction-id is broken, attempting auto-update',
  );

  const fixed = await attemptAutoUpdate();

  if (fixed) {
    logger.info(
      'Auto-update resolved the issue. Consider restarting the service to pick up changes in long-running processes.',
    );
  } else {
    logger.error(
      'Auto-update did not resolve the issue. Manual intervention may be required.',
    );
  }
}

/**
 * Start periodic health checks with an initial delay.
 * Returns a cleanup function to stop the interval.
 */
export function startXHealthCheck(intervalMs: number): () => void {
  const INITIAL_DELAY_MS = 30_000;

  let intervalId: ReturnType<typeof setInterval> | null = null;

  const timeoutId = setTimeout(() => {
    // Run immediately after initial delay
    runXHealthCheck().catch((err) => {
      logger.error({ err }, 'X health check failed unexpectedly');
    });

    // Then repeat on interval
    intervalId = setInterval(() => {
      runXHealthCheck().catch((err) => {
        logger.error({ err }, 'X health check failed unexpectedly');
      });
    }, intervalMs);
  }, INITIAL_DELAY_MS);

  return () => {
    clearTimeout(timeoutId);
    if (intervalId !== null) {
      clearInterval(intervalId);
    }
  };
}
