/**
 * Scope resolution for container secrets.
 * Replaces readSecrets() in container-runner.ts.
 *
 * Resolution order:
 * 1. credentials/{group.folder}/ (group-specific)
 * 2. credentials/default/ (if group is allowed via useDefaultCredentials)
 */
import { logger } from '../logger.js';
import type { RegisteredGroup } from '../types.js';
import { getAllProviders } from './registry.js';

/**
 * Import .env values into the default scope via each provider's importEnv().
 * Called once at startup. Each provider decides whether to skip if already present.
 */
export function importEnvToDefault(): void {
  for (const provider of getAllProviders()) {
    provider.importEnv?.('default');
  }
}

export function resolveSecrets(group: RegisteredGroup): Record<string, string> {
  const env: Record<string, string> = {};
  const providers = getAllProviders();
  const useDefault = group.containerConfig?.useDefaultCredentials === true;

  for (const provider of providers) {
    // Try group-specific scope first
    let result = provider.provision(group.folder);

    // Fall back to default scope if allowed
    if (useDefault && Object.keys(result.env).length === 0) {
      result = provider.provision('default');
    }

    Object.assign(env, result.env);
  }

  if (Object.keys(env).length > 0) {
    logger.debug(
      { group: group.name, keys: Object.keys(env) },
      'Resolved secrets from credential store',
    );
  }

  return env;
}
