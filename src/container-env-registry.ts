/**
 * Registry for per-spawn container env contributors.
 *
 * Container-runner calls `collectContainerEnv(ctx)` once per session
 * spawn, after provider-contributed env and before the host-gateway
 * args. Each registered contributor returns its own list of env
 * pairs; the union is appended as `-e KEY=VAL` args.
 *
 * Used to push extension-specific env vars in without piling
 * conditional logic into container-runner. Class feature uses it
 * for `GIT_AUTHOR_*` injection from agent_groups.metadata.
 */
import type { AgentGroup } from './types.js';

export interface ContainerEnvContext {
  agentGroup: AgentGroup;
}

export type ContainerEnvContributor = (ctx: ContainerEnvContext) => Array<[string, string]>;

const contributors: ContainerEnvContributor[] = [];

/**
 * Append a contributor to the chain. All registered contributors run
 * on every spawn. Order doesn't matter for env pairs (last writer
 * wins is handled by Docker, which the loop in container-runner
 * pushes in registration order).
 */
export function registerContainerEnvContributor(contributor: ContainerEnvContributor): void {
  contributors.push(contributor);
}

/**
 * Collect env pairs from all contributors. Returns a flat list. Empty
 * when no contributors are registered (default install).
 */
export function collectContainerEnv(ctx: ContainerEnvContext): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const contributor of contributors) {
    for (const pair of contributor(ctx)) {
      out.push(pair);
    }
  }
  return out;
}

/** Test hook — clear the contributor chain. */
export function _resetContributorsForTest(): void {
  contributors.length = 0;
}
