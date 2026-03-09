/**
 * Container runtime abstraction for NanoClaw.
 * Thin re-exports from src/runtime/ for backward compatibility.
 */
import { getRuntime } from './runtime/index.js';

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(
  hostPath: string,
  containerPath: string,
): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Returns the shell command to stop a container by name. */
export function stopContainer(name: string): string {
  return getRuntime('docker').stopCommand(name);
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  getRuntime('docker').ensureRunning();
}

/** Kill orphaned NanoClaw containers from previous runs. */
export function cleanupOrphans(): void {
  getRuntime('docker').cleanupOrphans();
}
