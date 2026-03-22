/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { logger } from './logger.js';

/** The container runtime binary name. */
export function detectContainerRuntimeBin(): string {
  const configuredRuntime = process.env.CONTAINER_RUNTIME_BIN?.trim();
  if (configuredRuntime) return configuredRuntime;
  return os.platform() === 'darwin' ? 'container' : 'docker';
}

export const CONTAINER_RUNTIME_BIN = detectContainerRuntimeBin();

const APPLE_CONTAINER_BRIDGE_INTERFACE = 'bridge100';
const DEFAULT_CONTAINER_HOST_GATEWAY = 'host.docker.internal';

function isAppleContainerRuntime(
  runtimeBin = detectContainerRuntimeBin(),
): boolean {
  return runtimeBin === 'container';
}

export function getRuntimeStatusCommand(
  runtimeBin = detectContainerRuntimeBin(),
): {
  command: string;
  timeout: number;
} {
  if (isAppleContainerRuntime(runtimeBin)) {
    return { command: `${runtimeBin} system status`, timeout: 30000 };
  }
  return { command: `${runtimeBin} info`, timeout: 10000 };
}

export function getRuntimeStartCommand(
  runtimeBin = detectContainerRuntimeBin(),
): { command: string; timeout: number } | null {
  if (isAppleContainerRuntime(runtimeBin)) {
    return { command: `${runtimeBin} system start`, timeout: 30000 };
  }
  return null;
}

export function getRuntimeErrorGuidance(
  runtimeBin = detectContainerRuntimeBin(),
): string[] {
  if (isAppleContainerRuntime(runtimeBin)) {
    return [
      'Ensure Apple Container is installed',
      'Run: container system start',
      'Restart NanoClaw',
    ];
  }
  return [
    `Ensure ${runtimeBin} is installed and running`,
    `Run: ${runtimeBin} info`,
    'Restart NanoClaw',
  ];
}

function getAppleContainerBridgeHost(): string | null {
  const bridge = os.networkInterfaces()[APPLE_CONTAINER_BRIDGE_INTERFACE];
  if (!bridge) return null;

  const ipv4 = bridge.find((a) => a.family === 'IPv4' && !a.internal);
  return ipv4?.address || null;
}

/** Hostname/IP containers use to reach the host machine. */
export function getContainerHostGateway(): string {
  if (process.env.CONTAINER_HOST_GATEWAY) {
    return process.env.CONTAINER_HOST_GATEWAY;
  }

  if (os.platform() === 'darwin' && isAppleContainerRuntime()) {
    const bridgeHost = getAppleContainerBridgeHost();
    if (bridgeHost) return bridgeHost;
  }

  return DEFAULT_CONTAINER_HOST_GATEWAY;
}

/**
 * Address the credential proxy binds to.
 * Apple Container (macOS): bridge100 IPv4 so only the VM-facing interface can reach it.
 * Docker Desktop (macOS): 127.0.0.1 — the VM routes host.docker.internal to loopback.
 * Docker (Linux): bind to the docker0 bridge IP so only containers can reach it,
 *   falling back to 0.0.0.0 if the interface isn't found.
 */
export function getProxyBindHost(): string {
  if (process.env.CREDENTIAL_PROXY_HOST) {
    return process.env.CREDENTIAL_PROXY_HOST;
  }

  if (os.platform() === 'darwin' && isAppleContainerRuntime()) {
    const bridgeHost = getAppleContainerBridgeHost();
    if (bridgeHost) return bridgeHost;

    logger.warn(
      { interface: APPLE_CONTAINER_BRIDGE_INTERFACE },
      'Apple Container bridge not found, falling back to loopback for credential proxy',
    );
    return '127.0.0.1';
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
  if (os.platform() === 'linux' && !isAppleContainerRuntime()) {
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
export function stopContainer(
  name: string,
  runtimeBin = detectContainerRuntimeBin(),
): string {
  return `${runtimeBin} stop ${name}`;
}

function printFatalRuntimeGuidance(
  runtimeBin = detectContainerRuntimeBin(),
): void {
  const lines = [
    'FATAL: Container runtime failed to start',
    '',
    'Agents cannot run without a container runtime. To fix:',
    ...getRuntimeErrorGuidance(runtimeBin),
  ];

  console.error(
    '\n╔════════════════════════════════════════════════════════════════╗',
  );
  for (const line of lines) {
    console.error(`║  ${line.padEnd(60)}║`);
  }
  console.error(
    '╚════════════════════════════════════════════════════════════════╝\n',
  );
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  const runtimeBin = detectContainerRuntimeBin();
  const statusCommand = getRuntimeStatusCommand(runtimeBin);
  const startCommand = getRuntimeStartCommand(runtimeBin);

  try {
    execSync(statusCommand.command, {
      stdio: 'pipe',
      timeout: statusCommand.timeout,
    });
    logger.debug('Container runtime already running');
  } catch (statusErr) {
    if (startCommand) {
      logger.info('Starting container runtime...');
      try {
        execSync(startCommand.command, {
          stdio: 'pipe',
          timeout: startCommand.timeout,
        });
        logger.info('Container runtime started');
        return;
      } catch (err) {
        logger.error({ err }, 'Failed to start container runtime');
        printFatalRuntimeGuidance(runtimeBin);
        throw new Error('Container runtime is required but failed to start');
      }
    }

    logger.error({ err: statusErr }, 'Failed to reach container runtime');
    printFatalRuntimeGuidance(runtimeBin);
    throw new Error('Container runtime is required but failed to start');
  }
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const runtimeBin = detectContainerRuntimeBin();
    let orphans: string[];
    if (isAppleContainerRuntime(runtimeBin)) {
      const output = execSync(`${runtimeBin} ls --format json`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      const containers: { status: string; configuration: { id: string } }[] =
        JSON.parse(output || '[]');
      orphans = containers
        .filter(
          (c) =>
            c.status === 'running' &&
            c.configuration.id.startsWith('nanoclaw-'),
        )
        .map((c) => c.configuration.id);
    } else {
      const output = execSync(
        `${runtimeBin} ps --filter name=nanoclaw- --format '{{.Names}}'`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
      );
      orphans = output.trim().split('\n').filter(Boolean);
    }

    for (const name of orphans) {
      try {
        execSync(stopContainer(name, runtimeBin), { stdio: 'pipe' });
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
