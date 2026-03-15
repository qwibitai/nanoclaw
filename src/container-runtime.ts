/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Hostname containers use to reach the host machine. */
export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';

/**
 * Returns the IPv4 address of the docker0 bridge interface, or null if not found.
 * Used by both the credential proxy bind address and the host gateway fallback.
 */
function getDockerBridgeIP(): string | null {
  const ifaces = os.networkInterfaces();
  const docker0 = ifaces['docker0'];
  if (docker0) {
    const ipv4 = docker0.find((a) => a.family === 'IPv4');
    if (ipv4) return ipv4.address;
  }
  return null;
}

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
  return getDockerBridgeIP() || '0.0.0.0';
}

/**
 * Returns the Docker Engine major.minor version, or null if it can't be determined.
 * Cached after first call.
 */
let dockerVersionCache: [number, number] | null | undefined;
function getDockerVersion(): [number, number] | null {
  if (dockerVersionCache !== undefined) return dockerVersionCache;
  try {
    const raw = execSync('docker version --format "{{.Server.Version}}"', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    const match = raw.match(/^(\d+)\.(\d+)/);
    if (match) {
      dockerVersionCache = [parseInt(match[1], 10), parseInt(match[2], 10)];
      return dockerVersionCache;
    }
  } catch {
    logger.debug('Failed to detect Docker version, will use fallback');
  }
  dockerVersionCache = null;
  return null;
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly.
  // WSL uses Docker Desktop which handles this automatically.
  if (
    os.platform() !== 'linux' ||
    fs.existsSync('/proc/sys/fs/binfmt_misc/WSLInterop')
  ) {
    return [];
  }

  // host-gateway requires Docker ≥ 20.10. On older versions it silently
  // fails, causing "Could not resolve host: host.docker.internal".
  const version = getDockerVersion();
  const supportsHostGateway =
    version !== null && (version[0] > 20 || (version[0] === 20 && version[1] >= 10));

  if (supportsHostGateway) {
    return ['--add-host=host.docker.internal:host-gateway'];
  }

  // Fallback: use the explicit docker0 bridge IP
  const bridgeIP = getDockerBridgeIP();
  if (bridgeIP) {
    logger.info(
      { bridgeIP },
      'Docker < 20.10 or version unknown — using explicit docker0 IP for host.docker.internal',
    );
    return [`--add-host=host.docker.internal:${bridgeIP}`];
  }

  // Last resort: no docker0 interface found, still try host-gateway
  // in case Docker supports it but we couldn't detect the version
  logger.warn(
    'No docker0 interface found and Docker version unknown — trying host-gateway anyway',
  );
  return ['--add-host=host.docker.internal:host-gateway'];
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

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
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
      '║  1. Ensure Docker is installed and running                     ║',
    );
    console.error(
      '║  2. Run: docker info                                           ║',
    );
    console.error(
      '║  3. Restart NanoClaw                                           ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
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
