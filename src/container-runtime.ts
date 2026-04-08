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
 * Detect if we are running under Apple Container (macOS-native runtime).
 * Checks for the `container` binary — stable at startup unlike the bridge
 * interface (bridge100), which only exists while a container is running.
 */
function isAppleContainer(): boolean {
  if (os.platform() !== 'darwin') return false;
  const paths = (process.env.PATH || '').split(':');
  return paths.some((dir) => {
    try {
      fs.accessSync(`${dir}/container`, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Hostname/IP containers use to reach the host machine.
 * Apple Container: host is the bridge IP (192.168.64.1); host.docker.internal is unavailable.
 * Docker Desktop (macOS/WSL): host.docker.internal resolves via the Docker VM.
 * Linux: host.docker.internal added via --add-host.
 */
export const CONTAINER_HOST_GATEWAY =
  process.env.CONTAINER_HOST_GATEWAY || detectHostGateway();

function detectHostGateway(): string {
  if (isAppleContainer()) {
    // Apple Container always uses 192.168.64.0/24; host is the .1 address.
    // Prefer reading the live bridge IP, but fall back to the well-known
    // default so the proxy binds correctly even before any container runs.
    const ifaces = os.networkInterfaces();
    for (const [name, addrs] of Object.entries(ifaces)) {
      if (name.startsWith('bridge') && addrs) {
        const ipv4 = addrs.find((a) => a.family === 'IPv4');
        if (ipv4) return ipv4.address;
      }
    }
    return '192.168.64.1'; // well-known Apple Container host gateway
  }
  return 'host.docker.internal';
}

/**
 * Address the credential proxy binds to.
 * Apple Container (macOS): bridge IP (e.g. 192.168.64.1) — containers reach the host
 *   via this IP, so the proxy must bind there rather than loopback.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || detectProxyBindHost();

function detectProxyBindHost(): string {
  // Apple Container: bind to all interfaces so the proxy is reachable once
  // bridge100 comes up (192.168.64.1). We can't bind to that IP at startup
  // because the bridge only exists while a container is running.
  if (isAppleContainer()) return '0.0.0.0';
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

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string, timeoutMs = 15000): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  // name is regex-validated above — no shell injection risk.
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, {
    stdio: 'pipe',
    timeout: timeoutMs,
  });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
    logger.debug('Container runtime already running');
  } catch {
    logger.info('Starting container runtime...');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, {
        stdio: 'pipe',
        timeout: 30000,
      });
      logger.info('Container runtime started');
    } catch (err) {
      logger.error({ err }, 'Failed to start container runtime');
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
        stopContainer(name);
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
