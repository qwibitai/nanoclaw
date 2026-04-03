import { describe, expect, it } from 'vitest';

import {
  AgentProviderRegistry,
  createProviderRegistry,
} from './provider-registry.js';
import type { AgentProvider } from './provider-types.js';

function createTestProvider(id: string): AgentProvider {
  return {
    id,
    displayName: `Provider ${id}`,
    capabilities: {
      persistentSessions: true,
      projectMemory: true,
      remoteControl: false,
      agentTeams: false,
      providerSkills: false,
    },
    validateHost() {
      return [];
    },
    prepareSession() {
      return {
        providerStateDir: `/tmp/${id}`,
        memoryFiles: [],
      };
    },
    buildContainerSpec() {
      return {
        mounts: [],
        env: {},
      };
    },
    serializeRuntimeInput() {
      return {
        providerId: id,
      };
    },
  };
}

describe('provider registry', () => {
  it('returns built-in providers by ID from the bootstrap registry', () => {
    // Arrange
    const registry = createProviderRegistry();

    // Act
    const claudeProvider = registry.getProvider('claude-code');
    const codexProvider = registry.getProvider('codex');

    // Assert
    expect(claudeProvider.id).toBe('claude-code');
    expect(codexProvider.id).toBe('codex');
  });

  it('rejects duplicate provider registration', () => {
    // Arrange
    const registry = new AgentProviderRegistry();
    const provider = createTestProvider('duplicate-provider');
    registry.register(provider);

    // Act
    const registerDuplicate = () => {
      registry.register(createTestProvider('duplicate-provider'));
    };

    // Assert
    expect(registerDuplicate).toThrowError(
      'Agent provider "duplicate-provider" is already registered.',
    );
  });

  it('throws an explicit error for unknown provider IDs', () => {
    // Arrange
    const registry = createProviderRegistry();

    // Act
    const getUnknownProvider = () => {
      registry.getProvider('missing-provider');
    };

    // Assert
    expect(getUnknownProvider).toThrowError(
      'Unknown agent provider "missing-provider". Registered providers: claude-code, codex.',
    );
  });
});
