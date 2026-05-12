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
 * Returns true when the docker CLI is actually the Podman shim.
 * Cached after the first call.
 */
let _isPodman: boolean | undefined;
export function isPodman(): boolean {
  if (_isPodman !== undefined) return _isPodman;
  try {
    const out = execSync('docker version', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    _isPodman = /podman/i.test(out);
  } catch {
    _isPodman = false;
  }
  return _isPodman;
}

let _selinuxEnforcing: boolean | undefined;
function isSelinuxEnforcing(): boolean {
  if (_selinuxEnforcing !== undefined) return _selinuxEnforcing;
  if (os.platform() !== 'linux') return (_selinuxEnforcing = false);
  try {
    const result = execSync('getenforce', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    _selinuxEnforcing = result.trim() === 'Enforcing';
  } catch {
    _selinuxEnforcing = false;
  }
  return _selinuxEnforcing;
}

/** Returns true when SELinux is enforcing on this host. */
export { isSelinuxEnforcing };

/**
 * Returns ':z' when SELinux is enforcing, otherwise ''.
 *
 * Append to a bind-mount spec to relabel the host directory with the shared
 * container_file_t label, allowing both the host process and multiple
 * containers to access it while SELinux enforcement stays active.
 * On non-SELinux systems this suffix is ignored by the runtime.
 */
export function selinuxMountSuffix(): string {
  return isSelinuxEnforcing() ? ':z' : '';
}

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  if (os.platform() !== 'linux') return [];
  if (isPodman()) {
    // slirp4netns with allow_host_loopback=true puts the host at 10.0.2.2,
    // allowing containers to reach services bound to 127.0.0.1 on the host.
    // pasta (the default) cannot reach the host's loopback from containers.
    return ['--network=slirp4netns:allow_host_loopback=true', '--add-host=host.docker.internal:10.0.2.2'];
  }
  // Docker: host.docker.internal isn't built-in on Linux — add it explicitly.
  return ['--add-host=host.docker.internal:host-gateway'];
}

/** Returns CLI args for a readonly bind mount, with SELinux relabeling if enforcing. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  const z = isSelinuxEnforcing() ? ',z' : '';
  return ['-v', `${hostPath}:${containerPath}:ro${z}`];
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
