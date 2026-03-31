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
export const CONTAINER_RUNTIME_BIN = 'container';

/** Hostname/IP containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY =
  CONTAINER_RUNTIME_BIN === 'container'
    ? '192.168.64.1' // Apple Container vmnet gateway
    : 'host.docker.internal'; // Docker Desktop

/**
 * Address the credential proxy binds to.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  // Apple Container: containers reach the host via vmnet gateway (192.168.64.1),
  // but that interface only exists once a container is running. Bind to 0.0.0.0
  // so the proxy starts even before vmnet is up (e.g. after a reboot).
  if (os.platform() === 'darwin' && CONTAINER_RUNTIME_BIN === 'container') {
    return '0.0.0.0';
  }
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
  return [
    '--mount',
    `type=bind,source=${hostPath},target=${containerPath},readonly`,
  ];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Check if the container runtime is reachable, attempting auto-start if needed. */
function isRuntimeReachable(): boolean {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
    return true;
  } catch {
    // Try to start it automatically
    try {
      logger.info('Container runtime not running, attempting auto-start...');
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      logger.info('Container runtime started');
      return true;
    } catch {
      return false;
    }
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

  // Retry every 10 seconds for up to 5 minutes (0 retries in test via env)
  const RETRY_INTERVAL = parseInt(
    process.env.CONTAINER_RETRY_INTERVAL || '10000',
    10,
  );
  const MAX_RETRIES = parseInt(process.env.CONTAINER_MAX_RETRIES || '30', 10);
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
    logger.warn(
      { attempt, maxRetries: MAX_RETRIES },
      'Container runtime still unavailable',
    );
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
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: { status: string; configuration: { id: string } }[] =
      JSON.parse(output || '[]');
    const orphans = containers
      .filter(
        (c) =>
          c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'),
      )
      .map((c) => c.configuration.id);
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
