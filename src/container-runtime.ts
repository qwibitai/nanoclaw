import {
  getAgentRuntime,
  PROXY_BIND_HOST,
  getRuntimeStatus,
} from './runtime-adapter.js';

export { PROXY_BIND_HOST };

export function stopSession(name: string): string {
  return getAgentRuntime().stopSession(name);
}

export function hasSession(name: string): boolean {
  return getAgentRuntime().hasSession(name);
}

export function ensureContainerRuntimeRunning(): void {
  getAgentRuntime().ensureReady();
}

export function cleanupOrphans(): void {
  getAgentRuntime().cleanupOrphans();
}

export { getRuntimeStatus };
