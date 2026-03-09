/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';

import { logger } from './logger.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'container';

/**
 * Hostname containers use to reach the host machine.
 * Apple Container's default network subnet varies across machines (e.g. 192.168.64.0/24,
 * 192.168.65.0/24). Detect the gateway (.1) from `container network ls` at startup.
 */
export const CONTAINER_HOST_GATEWAY = detectHostGateway();

function detectHostGateway(): string {
  try {
    const output = execSync('container network ls --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 5000,
    });
    const networks: {
      id: string;
      state: string;
      status?: { ipv4Gateway?: string; ipv4Subnet?: string };
    }[] = JSON.parse(output || '[]');
    const defaultNet = networks.find((n) => n.id === 'default');
    if (defaultNet?.status?.ipv4Gateway) {
      logger.debug(
        { gateway: defaultNet.status.ipv4Gateway, subnet: defaultNet.status.ipv4Subnet },
        'Detected Apple Container gateway',
      );
      return defaultNet.status.ipv4Gateway;
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to detect Apple Container gateway, using fallback');
  }
  return '192.168.64.1';
}

/**
 * Address the credential proxy binds to.
 * Apple Container VMs reach the host via the bridge gateway (detected above),
 * so the proxy must listen on all interfaces to be reachable from the VM.
 */
export const PROXY_BIND_HOST =
  process.env.CREDENTIAL_PROXY_HOST || '0.0.0.0';

/**
 * CLI args needed for the container to resolve the host gateway.
 * Apple Container provides host networking natively on macOS — no extra args needed.
 */
export function hostGatewayArgs(): string[] {
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['--mount', `type=bind,source=${hostPath},target=${containerPath},readonly`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return `${CONTAINER_RUNTIME_BIN} stop ${name}`;
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} system status`, { stdio: 'pipe' });
    logger.debug('Container runtime already running');
  } catch {
    logger.info('Starting container runtime...');
    try {
      execSync(`${CONTAINER_RUNTIME_BIN} system start`, { stdio: 'pipe', timeout: 30000 });
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
      } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}
