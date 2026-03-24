/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { setContainerStatus } from './health.js';
import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') return '127.0.0.1';

  // WSL uses Docker Desktop (same VM routing as macOS) — loopback is correct.
  // Check /proc filesystem, not env vars — WSL_DISTRO_NAME isn't set under systemd.
  if (fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')) return '127.0.0.1';

  // Bare-metal Linux: bind to the docker0 bridge IP instead of 0.0.0.0
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return '0.0.0.0';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Check if the container runtime is reachable right now. */
function isRuntimeReachable(): boolean {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the container runtime is running, with retries.
 * Returns true if available, false if entering degraded mode.
 */
export function ensureContainerRuntimeRunning(): boolean {
  if (isRuntimeReachable()) {
    logger.debug('Container runtime already running');
    setContainerStatus(true, CONTAINER_RUNTIME_BIN);
    return true;
  }

  // Retry every 10 seconds for up to 5 minutes
  const RETRY_INTERVAL = 10000;
  const MAX_RETRIES = 30; // 5 minutes
  let attempt = 0;

  logger.warn('Container runtime not available, retrying...');

  while (attempt < MAX_RETRIES) {
    attempt++;
    // Synchronous sleep (acceptable during startup only)
    const start = Date.now();
    while (Date.now() - start < RETRY_INTERVAL) {
      // busy wait — only runs at startup before event loop matters
    }

    if (isRuntimeReachable()) {
      logger.info(
        { attempt },
        'Container runtime became available after retry',
      );
      setContainerStatus(true, CONTAINER_RUNTIME_BIN);
      return true;
    }
    logger.warn({ attempt, maxRetries: MAX_RETRIES }, 'Container runtime still unavailable');
  }

  // Degraded mode — start without container support
  logger.error(
    'Container runtime unavailable after 5 minutes — starting in degraded mode',
  );
  setContainerStatus(false, CONTAINER_RUNTIME_BIN);

  // Start background polling to detect when runtime comes back
  const pollInterval = setInterval(() => {
    if (isRuntimeReachable()) {
      logger.info('Container runtime recovered — exiting degraded mode');
      setContainerStatus(true, CONTAINER_RUNTIME_BIN);
      clearInterval(pollInterval);
    }
  }, 30000);

  return false;
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        execSync(stopContainer(name), { stdio: 'pipe' });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
