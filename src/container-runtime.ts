/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Env for container runtime commands — ensures DOCKER_HOST is set on macOS. */
function dockerEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (os.platform() === 'darwin' && !env.DOCKER_HOST) {
    const sock = `${env.HOME}/.docker/run/docker.sock`;
    if (fs.existsSync(sock)) {
      env.DOCKER_HOST = `unix://${sock}`;
    }
  }
  return env;
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
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execFileSync(CONTAINER_RUNTIME_BIN, ['stop', '-t', '1', name], { stdio: 'pipe', env: dockerEnv() });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  // Check by probing the socket — no subprocess spawn needed.
  const env = dockerEnv();
  const sockPath = env.DOCKER_HOST?.replace(/^unix:\/\//, '') ?? '/var/run/docker.sock';
  if (!fs.existsSync(sockPath)) {
    log.warn('Docker socket not found — agents will not be able to run containers', { sockPath });
    return;
  }
  log.debug('Container runtime socket present', { sockPath });
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  try {
    const output = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['ps', '--filter', 'name=nanoclaw-', '--format', '{{.Names}}'],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', env: dockerEnv() },
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
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
