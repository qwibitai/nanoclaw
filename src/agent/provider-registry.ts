import { builtInProviders } from './providers/index.js';
import type { AgentProvider } from './provider-types.js';

export class AgentProviderRegistry {
  private readonly providers = new Map<string, AgentProvider>();

  register(provider: AgentProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Agent provider "${provider.id}" is already registered.`);
    }

    this.providers.set(provider.id, provider);
  }

  getProvider(providerId: string): AgentProvider {
    const provider = this.providers.get(providerId);

    if (provider) {
      return provider;
    }

    const registeredProviders = [...this.providers.keys()].sort().join(', ');
    throw new Error(
      `Unknown agent provider "${providerId}". Registered providers: ${registeredProviders}.`,
    );
  }

  listProviders(): AgentProvider[] {
    return [...this.providers.values()];
  }
}

export function createProviderRegistry(
  providers: Iterable<AgentProvider> = builtInProviders,
): AgentProviderRegistry {
  const registry = new AgentProviderRegistry();

  for (const provider of providers) {
    registry.register(provider);
  }

  return registry;
}
