/**
 * Auth barrel — re-exports and registers built-in providers.
 */
export { initCredentialStore } from './store.js';
export { resolveSecrets } from './provision.js';
export { importEnvToDefault } from './provision.js';
export { createAuthGuard } from './guard.js';
export { registerProvider, getProvider, getAllProviders } from './registry.js';

// Register built-in providers
import { registerProvider } from './registry.js';
import { claudeProvider } from './providers/claude.js';

registerProvider(claudeProvider);
