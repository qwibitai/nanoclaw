/**
 * No-op replacements for container-runtime.ts and credential-proxy.ts.
 * Used by the direct runner loader to skip Docker and proxy initialization.
 * Exports everything that index.ts imports from both modules.
 */
import { logger } from './logger.js';

// ── From container-runtime.ts ───────────────────────────────────────

export const CONTAINER_RUNTIME_BIN = 'echo';
export const CONTAINER_HOST_GATEWAY = 'localhost';
export const PROXY_BIND_HOST = '127.0.0.1';

export function hostGatewayArgs(): string[] {
  return [];
}

export function readonlyMountArgs(
  _hostPath: string,
  _containerPath: string,
): string[] {
  return [];
}

export function stopContainer(_name: string): string {
  return 'true';
}

export function ensureContainerRuntimeRunning(): void {
  logger.info('Direct runner mode — container runtime not needed');
}

export function cleanupOrphans(): void {
  // No containers to clean up
}

// ── From credential-proxy.ts ────────────────────────────────────────

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  _port: number,
  _host?: string,
): Promise<null> {
  logger.info('Direct runner mode — credential proxy not needed');
  return Promise.resolve(null);
}

export function detectAuthMode(): AuthMode {
  return 'oauth';
}
