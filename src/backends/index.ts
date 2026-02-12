/**
 * Backend factory and resolution for NanoClaw.
 * Routes groups to the appropriate backend based on configuration.
 */

import { logger } from '../logger.js';
import { RegisteredGroup } from '../types.js';
import { LocalBackend } from './local-backend.js';
import { SpritesBackend } from './sprites-backend.js';
import { AgentBackend, BackendType } from './types.js';

const DEFAULT_BACKEND: BackendType = 'apple-container';

const backends = new Map<BackendType, AgentBackend>();

/** Get a backend instance by type. Lazily creates singletons. */
export function getBackend(type: BackendType): AgentBackend {
  let backend = backends.get(type);
  if (backend) return backend;

  switch (type) {
    case 'apple-container':
    case 'docker':
      backend = new LocalBackend();
      break;
    case 'sprites':
      backend = new SpritesBackend();
      break;
    default:
      throw new Error(`Unknown backend type: ${type}`);
  }

  backends.set(type, backend);
  return backend;
}

/** Resolve which backend a group should use. */
export function resolveBackend(group: RegisteredGroup): AgentBackend {
  const type = group.backend || DEFAULT_BACKEND;
  return getBackend(type);
}

/** Get the Sprites backend instance (if any groups use it). */
export function getSpritesBackend(): SpritesBackend | null {
  const backend = backends.get('sprites');
  return backend instanceof SpritesBackend ? backend : null;
}

/**
 * Initialize all backends that are in use.
 * Called once at startup, replaces the old ensureContainerSystemRunning().
 */
export async function initializeBackends(
  registeredGroups: Record<string, RegisteredGroup>,
): Promise<void> {
  // Determine which backend types are needed
  const neededTypes = new Set<BackendType>();
  neededTypes.add(DEFAULT_BACKEND); // Always initialize the default

  for (const group of Object.values(registeredGroups)) {
    if (group.backend) {
      neededTypes.add(group.backend);
    }
  }

  logger.info({ backends: [...neededTypes] }, 'Initializing backends');

  for (const type of neededTypes) {
    const backend = getBackend(type);
    await backend.initialize();
  }
}

/** Shut down all initialized backends. */
export async function shutdownBackends(): Promise<void> {
  for (const [type, backend] of backends) {
    try {
      await backend.shutdown();
    } catch (err) {
      logger.warn({ backend: type, error: err }, 'Error shutting down backend');
    }
  }
}

// Re-export types for convenience
export type { AgentBackend, BackendType, ContainerInput, ContainerOutput } from './types.js';
