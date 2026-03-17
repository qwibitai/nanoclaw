/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'container';

/**
 * Hostname/IP containers use to reach the host machine.
 * Apple Container (macOS): uses the bridge gateway IP directly since
 *   host.docker.internal is not supported and --add-host is unavailable.
 * Docker (Linux/WSL): uses host.docker.internal with --add-host fallback.
 */
export const CONTAINER_HOST_GATEWAY = detectHostGateway();

function detectHostGateway(): string {
  if (process.env.CONTAINER_HOST_GATEWAY) return process.env.CONTAINER_HOST_GATEWAY;

  // Apple Container on macOS: detect the bridge gateway IP from the
  // container network. The VM bridge is typically on 192.168.64.0/24
  // with the host at .1.
  if (os.platform() === 'darwin' && CONTAINER_RUNTIME_BIN === 'container') {
    try {
      // Find the bridge interface used by Apple Container (bridge100, etc.)
      const ifaces = os.networkInterfaces();
      for (const [name, addrs] of Object.entries(ifaces)) {
        if (!name.startsWith('bridge') || !addrs) continue;
        const ipv4 = addrs.find(
          (a) => a.family === 'IPv4' && a.address.startsWith('192.168.64.'),
        );
        if (ipv4) return ipv4.address;
      }
    } catch { /* fall through */ }
    // Fallback: conventional Apple Container bridge gateway
    return '192.168.64.1';
  }

  return 'host.docker.internal';
}

/**
 * Address the credential proxy binds to.
 * Apple Container (macOS): bind to the bridge interface so VMs can reach it.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  if (os.platform() === 'darwin') {
    // Apple Container: VMs reach the host via a bridge network (192.168.64.x).
    // The gateway IP isn't a bindable local address, so bind to 0.0.0.0.
    if (CONTAINER_RUNTIME_BIN === 'container') {
      return '0.0.0.0';
    }
    // Docker Desktop: VM routes host.docker.internal to loopback
    return '127.0.0.1';
  }

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
  // Apple Container uses the bridge IP directly — no --add-host needed (or supported).
  if (CONTAINER_RUNTIME_BIN === 'container') return [];

  // On Linux with Docker, host.docker.internal isn't built-in — add it explicitly
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
  return ['--mount', `type=bind,source=${hostPath},target=${containerPath},readonly`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. Retries on boot. */
export function ensureContainerRuntimeRunning(): void {
  const MAX_RETRIES = 10;
  const RETRY_DELAY_MS = 5000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system status`, {
        stdio: 'pipe',
        timeout: 10000,
      });
      logger.debug('Container runtime already running');
      return;
    } catch {
      logger.info({ attempt, maxRetries: MAX_RETRIES }, 'Container runtime not ready, attempting to start...');
      try {
        execSync(`${CONTAINER_RUNTIME_BIN} system start`, { stdio: 'pipe', timeout: 30000 });
        logger.info('Container runtime started');
        return;
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          logger.warn(
            { err, attempt, nextRetryMs: RETRY_DELAY_MS },
            'Container runtime not yet available, retrying...',
          );
          // Blocking sleep — acceptable at startup before the event loop is needed
          execSync(`sleep ${RETRY_DELAY_MS / 1000}`);
        } else {
          logger.error({ err }, 'Failed to start container runtime after all retries');
          console.error(
            '\n╔════════════════════════════════════════════════════════════════╗',
          );
          console.error(
            '║  FATAL: Container runtime failed to start                      ║',
          );
          console.error(
            '║                                                                ║',
          );
          console.error(
            '║  Agents cannot run without a container runtime. To fix:        ║',
          );
          console.error(
            '║  1. Ensure Apple Container is installed                        ║',
          );
          console.error(
            '║  2. Run: container system start                                ║',
          );
          console.error(
            '║  3. Restart NanoClaw                                           ║',
          );
          console.error(
            '╚════════════════════════════════════════════════════════════════╝\n',
          );
          throw new Error('Container runtime is required but failed to start');
        }
      }
    }
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execSync(`${CONTAINER_RUNTIME_BIN} ls --format json`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: { status: string; configuration: { id: string } }[] = JSON.parse(output || '[]');
    const orphans = containers
      .filter((c) => c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'))
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
