import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

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
        files: [],
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
        prompt: `prompt-${id}`,
        groupFolder: `group-${id}`,
        chatJid: `${id}@g.us`,
        isMain: false,
      };
    },
  };
}

describe('provider registry', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    while (tempRoots.length > 0) {
      const tempRoot = tempRoots.pop();
      if (tempRoot) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  });

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

  it('reuses legacy .claude state when the new provider namespace is empty', () => {
    // Arrange
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-provider-registry-'),
    );
    tempRoots.push(tempRoot);

    const registry = createProviderRegistry();
    const claudeProvider = registry.getProvider('claude-code');
    const dataDir = path.join(tempRoot, 'data');
    const groupDir = path.join(tempRoot, 'groups', 'whatsapp_main');
    const legacyStateDir = path.join(
      dataDir,
      'sessions',
      'whatsapp_main',
      '.claude',
    );
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(legacyStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyStateDir, 'sessions-index.json'),
      JSON.stringify({ entries: [{ sessionId: 'legacy-session' }] }),
    );

    // Act
    const preparedSession = claudeProvider.prepareSession({
      projectRoot: tempRoot,
      dataDir,
      groupFolder: 'whatsapp_main',
      groupDir,
      isMain: true,
    });

    // Assert
    expect(preparedSession.providerStateDir).toBe(legacyStateDir);
    expect(preparedSession.allowedStateRoots).toEqual([legacyStateDir]);
  });

  it('seeds claude settings only when the provider settings file is missing', () => {
    // Arrange
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-provider-registry-'),
    );
    tempRoots.push(tempRoot);

    const registry = createProviderRegistry();
    const claudeProvider = registry.getProvider('claude-code');
    const dataDir = path.join(tempRoot, 'data');
    const groupDir = path.join(tempRoot, 'groups', 'whatsapp_main');
    fs.mkdirSync(groupDir, { recursive: true });

    // Act
    const preparedSession = claudeProvider.prepareSession({
      projectRoot: tempRoot,
      dataDir,
      groupFolder: 'whatsapp_main',
      groupDir,
      isMain: true,
    });
    const settingsFile = preparedSession.files.find(
      (file) =>
        file.targetPath ===
        path.join(
          dataDir,
          'sessions',
          'whatsapp_main',
          'claude-code',
          'settings.json',
        ),
    );

    // Assert
    expect(settingsFile).toBeDefined();
    expect(settingsFile?.onlyIfMissing).toBe(true);
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
