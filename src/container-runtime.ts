/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/**
 * CLI args mapping `host.docker.internal` for the agent container.
 *
 * The default `host-gateway` resolves to the bridge gateway on Linux
 * (172.17.0.1) and relies on the host's port-forward path back into the
 * loopback namespace. In rootless Docker setups that path is brittle —
 * OneCLI binds 127.0.0.1:10255 inside rootlesskit and the bridge gateway
 * routinely loses its forward across host restarts, leaving the agent
 * container unable to reach the proxy and the SDK call dies with
 * ConnectionRefused (the silent-task-failure trigger we shipped runner-
 * side detection for).
 *
 * When OneCLI's own bridge IP is known, pin host.docker.internal to it
 * directly — the agent container reaches OneCLI as a direct container-
 * to-container hop on the shared bridge, no rootlesskit involved.
 *
 * Falls back to `host-gateway` when OneCLI isn't on the bridge or the
 * lookup fails (rootful Docker, OneCLI not installed, etc.) so the
 * default behaviour is unchanged.
 */
export function hostGatewayArgs(opts: { onecliBridgeIp?: string | null } = {}): string[] {
  if (os.platform() !== 'linux') return [];
  const target = opts.onecliBridgeIp ?? 'host-gateway';
  return [`--add-host=host.docker.internal:${target}`];
}

/**
 * Resolve OneCLI's IP on the default `bridge` Docker network.
 *
 * Returns null when:
 *   - OneCLI isn't running,
 *   - it's not attached to the bridge network (e.g. only on a
 *     compose-private network), or
 *   - `docker inspect` fails for any reason.
 *
 * Cheap (<10 ms) and called once per container spawn.
 */
export function getOnecliBridgeIp(): string | null {
  try {
    const out = execSync(
      `${CONTAINER_RUNTIME_BIN} inspect onecli --format '{{ index .NetworkSettings.Networks "bridge" "IPAddress" }}'`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 5000 },
    ).trim();
    return /^\d+\.\d+\.\d+\.\d+$/.test(out) ? out : null;
  } catch {
    return null;
  }
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
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
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
