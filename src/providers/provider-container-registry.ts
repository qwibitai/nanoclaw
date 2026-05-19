/**
 * Host-side provider container-config registry.
 *
 * Providers that need per-spawn host-side setup (extra volume mounts, env var
 * passthrough, per-session directories) register a function here. The
 * container-runner resolves the session's effective provider name, looks up
 * the registered config fn, and merges the returned mounts/env into the spawn
 * args.
 *
 * Providers without host-side needs (e.g. `claude`, `mock`) don't appear in
 * this registry at all — the lookup returns `undefined` and the spawn path
 * proceeds with only the default mounts and env.
 *
 * Skills add a new provider's host config by creating `src/providers/<name>.ts`
 * with a top-level `registerProviderContainerConfig(...)` call, then appending
 * `import './<name>.js';` to `src/providers/index.ts` (the barrel).
 */

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

export interface ProviderContainerContext {
  /** Per-session host directory: `<DATA_DIR>/v2-sessions/<session_id>`. */
  sessionDir: string;
  /** Agent group ID, for any per-group logic. */
  agentGroupId: string;
  /** `process.env` at spawn time — pull passthrough values from here. */
  hostEnv: NodeJS.ProcessEnv;
}

export interface ProviderContainerContribution {
  /** Extra volume mounts (merged with the default session/group/agent-runner mounts). */
  mounts?: VolumeMount[];
  /** Extra env vars to pass to the container (`-e KEY=VALUE`). */
  env?: Record<string, string>;
}

export type ProviderContainerConfigFn = (ctx: ProviderContainerContext) => ProviderContainerContribution;

const registry = new Map<string, ProviderContainerConfigFn>();

export function registerProviderContainerConfig(name: string, fn: ProviderContainerConfigFn): void {
  if (registry.has(name)) {
    throw new Error(`Provider container config already registered: ${name}`);
  }
  registry.set(name, fn);
}

export function getProviderContainerConfig(name: string): ProviderContainerConfigFn | undefined {
  return registry.get(name);
}

export function listProviderContainerConfigNames(): string[] {
  return [...registry.keys()];
}
