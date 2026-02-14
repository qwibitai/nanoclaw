/**
 * Backend factory and resolution for NanoClaw.
 * Routes groups to the appropriate backend based on configuration.
 */

import { logger } from '../logger.js';
import { Agent, RegisteredGroup } from '../types.js';
import { DaytonaBackend } from './daytona-backend.js';
import { LocalBackend } from './local-backend.js';
import { SpritesBackend } from './sprites-backend.js';
import { AgentBackend, AgentOrGroup, BackendType, getBackendType } from './types.js';

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
    case 'daytona':
      backend = new DaytonaBackend();
      break;
    case 'railway': {
      // Lazy-load to avoid circular deps and missing module errors when not used
      const { RailwayBackend } = require('./railway-backend.js');
      backend = new RailwayBackend();
      break;
    }
    case 'hetzner': {
      // Lazy-load to avoid circular deps and missing module errors when not used
      const { HetznerBackend } = require('./hetzner-backend.js');
      backend = new HetznerBackend();
      break;
    }
    default:
      throw new Error(`Unknown backend type: ${type}`);
  }

  backends.set(type, backend!);
  return backend!;
}

/** Resolve which backend an agent or group should use. */
export function resolveBackend(entity: AgentOrGroup): AgentBackend {
  const type = getBackendType(entity);
  return getBackend(type);
}

/** Get the Sprites backend instance (if any groups use it). */
export function getSpritesBackend(): SpritesBackend | null {
  const backend = backends.get('sprites');
  return backend instanceof SpritesBackend ? backend : null;
}

/** Get the Daytona backend instance (if any groups use it). */
export function getDaytonaBackend(): DaytonaBackend | null {
  const backend = backends.get('daytona');
  return backend instanceof DaytonaBackend ? backend : null;
}

/**
 * Initialize all backends that are in use.
 * Called once at startup, replaces the old ensureContainerSystemRunning().
 * Accepts either Record<string, RegisteredGroup> or Record<string, Agent>.
 */
export async function initializeBackends(
  entities: Record<string, RegisteredGroup> | Record<string, Agent>,
): Promise<void> {
  // Determine which backend types are needed
  const neededTypes = new Set<BackendType>();
  neededTypes.add(DEFAULT_BACKEND); // Always initialize the default

  for (const entity of Object.values(entities)) {
    const type = getBackendType(entity);
    neededTypes.add(type);
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
export type { AgentBackend, AgentOrGroup, BackendType, ContainerInput, ContainerOutput } from './types.js';
