/**
 * Credential provider registry — same pattern as channels/registry.ts.
 */
import type { CredentialProvider } from './types.js';

const registry = new Map<string, CredentialProvider>();

export function registerProvider(provider: CredentialProvider): void {
  registry.set(provider.service, provider);
}

export function getProvider(service: string): CredentialProvider | undefined {
  return registry.get(service);
}

export function getAllProviders(): CredentialProvider[] {
  return [...registry.values()];
}
