/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 *
 * Supports both Docker and Apple Container. Runtime is selected at startup:
 *   - CONTAINER_RUNTIME=docker|container (explicit override)
 *   - otherwise auto-detected: on Darwin, prefer `container` if on PATH; else `docker`
 */
import { execSync } from 'child_process';
import os from 'os';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type Runtime = 'docker' | 'container';

function detectRuntime(): Runtime {
  const override = process.env.CONTAINER_RUNTIME;
  if (override === 'docker' || override === 'container') return override;
  if (os.platform() === 'darwin') {
    try {
      execSync('command -v container', { stdio: 'pipe' });
      return 'container';
    } catch {
      // fall through to docker
    }
  }
  return 'docker';
}

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN: Runtime = detectRuntime();

/**
 * IP address containers use to reach the host machine.
 *   - Apple Container (macOS): bridge network gateway (192.168.64.x). Detected from
 *     bridge100/bridge0, falls back to 192.168.64.1.
 *   - Docker Desktop (macOS) / Docker on Linux: host.docker.internal.
 * Can be overridden with the CONTAINER_HOST_GATEWAY env var.
 */
export const CONTAINER_HOST_GATEWAY =
  process.env.CONTAINER_HOST_GATEWAY || detectHostGateway();

function detectHostGateway(): string {
  if (CONTAINER_RUNTIME_BIN === 'container') {
    const ifaces = os.networkInterfaces();
    const bridge = ifaces['bridge100'] || ifaces['bridge0'];
    if (bridge) {
      const ipv4 = bridge.find((a) => a.family === 'IPv4');
      if (ipv4) return ipv4.address;
    }
    return '192.168.64.1';
  }
  return 'host.docker.internal';
}

/**
 * Address the credential proxy binds to.
 *   - Apple Container: CREDENTIAL_PROXY_HOST must be set in .env — there is no safe
 *     default because bridge100 only exists once a container is running, but the
 *     proxy must start first. The /convert-to-apple-container skill sets this.
 *   - Docker: defaults to 127.0.0.1 (Docker Desktop's host networking handles
 *     host.docker.internal → loopback routing).
 */
export const PROXY_BIND_HOST: string =
  process.env.CREDENTIAL_PROXY_HOST ??
  readEnvFile(['CREDENTIAL_PROXY_HOST']).CREDENTIAL_PROXY_HOST ??
  defaultProxyBindHost();

function defaultProxyBindHost(): string {
  if (CONTAINER_RUNTIME_BIN === 'container') {
    throw new Error(
      'CREDENTIAL_PROXY_HOST is not set in .env. Required for Apple Container — run /convert-to-apple-container to configure.',
    );
  }
  return '127.0.0.1';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // Docker on Linux: host.docker.internal isn't built-in — add it explicitly.
  // Apple Container resolves host via bridge gateway, no extra args needed.
  if (CONTAINER_RUNTIME_BIN === 'docker' && os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  if (CONTAINER_RUNTIME_BIN === 'container') {
    return [
      '--mount',
      `type=bind,source=${hostPath},target=${containerPath},readonly`,
    ];
  }
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Validates the name to prevent command injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  // Apple Container's `stop` does not support `-t`; Docker's does. Keep it simple.
  const stopArgs =
    CONTAINER_RUNTIME_BIN === 'docker' ? `stop -t 1 ${name}` : `stop ${name}`;
  execSync(`${CONTAINER_RUNTIME_BIN} ${stopArgs}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  if (CONTAINER_RUNTIME_BIN === 'container') {
    ensureAppleContainerRunning();
  } else {
    ensureDockerRunning();
  }
}

function ensureAppleContainerRunning(): void {
  try {
    execSync('container system status', { stdio: 'pipe' });
    logger.debug('Container runtime already running');
  } catch {
    logger.info('Starting container runtime...');
    try {
      execSync('container system start', { stdio: 'pipe', timeout: 30000 });
      logger.info('Container runtime started');
    } catch (err) {
      logger.error({ err }, 'Failed to start container runtime');
      printRuntimeFatal('Apple Container', [
        '1. Ensure Apple Container is installed',
        '2. Run: container system start',
        '3. Restart NanoClaw',
      ]);
      throw new Error('Container runtime is required but failed to start', {
        cause: err,
      });
    }
  }
}

function ensureDockerRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.debug('Container runtime already running');
  } catch (err) {
    logger.error({ err }, 'Failed to reach container runtime');
    printRuntimeFatal('Docker', [
      '1. Ensure Docker is installed and running',
      '2. Run: docker info',
      '3. Restart NanoClaw',
    ]);
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

function printRuntimeFatal(runtime: string, steps: string[]): void {
  const box = [
    '',
    '╔════════════════════════════════════════════════════════════════╗',
    '║  FATAL: Container runtime failed to start                      ║',
    '║                                                                ║',
    `║  Agents cannot run without a container runtime (${runtime}).`.padEnd(
      66,
    ) + '║',
    '║                                                                ║',
    ...steps.map((s) => `║  ${s}`.padEnd(66) + '║'),
    '╚════════════════════════════════════════════════════════════════╝',
    '',
  ];
  console.error(box.join('\n'));
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const orphans =
      CONTAINER_RUNTIME_BIN === 'container'
        ? listAppleContainerOrphans()
        : listDockerOrphans();
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

function listAppleContainerOrphans(): string[] {
  const output = execSync('container ls --format json', {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  const containers: { status: string; configuration: { id: string } }[] =
    JSON.parse(output || '[]');
  return containers
    .filter(
      (c) =>
        c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'),
    )
    .map((c) => c.configuration.id);
}

function listDockerOrphans(): string[] {
  const output = execSync(
    "docker ps --filter name=nanoclaw- --format '{{.Names}}'",
    { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
  );
  return output.trim().split('\n').filter(Boolean);
}
