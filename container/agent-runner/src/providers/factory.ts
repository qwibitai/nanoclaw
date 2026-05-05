import type { AgentProvider, ProviderOptions } from './types.js';
import { getProviderFactory } from './provider-registry.js';

/**
 * Any registered provider name. Kept as a named alias for readability; the
 * set of valid names is open and determined at runtime by whichever provider
 * modules the `providers/index.ts` barrel imports.
 */
export type ProviderName = string;

export function createProvider(name: ProviderName, options: ProviderOptions = {}): AgentProvider {
  return getProviderFactory(name)(options);
}
