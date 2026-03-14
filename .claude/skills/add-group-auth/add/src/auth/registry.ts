/**
 * Credential provider registry — same pattern as channels/registry.ts.
 * When a provider has a proxyService, it's also registered with the credential proxy.
 */
import type { CredentialProvider } from './types.js';
import { registerProxyService } from '../credential-proxy.js';

const registry = new Map<string, CredentialProvider>();

export function registerProvider(provider: CredentialProvider): void {
  registry.set(provider.service, provider);
  if (provider.proxyService) {
    registerProxyService(provider.proxyService);
  }
}

export function getProvider(service: string): CredentialProvider | undefined {
  return registry.get(service);
}

export function getAllProviders(): CredentialProvider[] {
  return [...registry.values()];
}
