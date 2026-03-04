import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Temp dir for credential store
const tmpDir = path.join(os.tmpdir(), `nanoclaw-provision-test-${Date.now()}`);
vi.stubEnv('HOME', tmpDir);

beforeEach(() => {
  fs.mkdirSync(path.join(tmpDir, '.config', 'nanoclaw'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock env.ts to control .env content
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

const { initCredentialStore, encrypt, saveCredential } = await import(
  './store.js'
);
const { registerProvider, getAllProviders } = await import('./registry.js');
const { resolveSecrets, importEnvToDefault } = await import('./provision.js');
const { readEnvFile } = await import('../env.js');

import type { CredentialProvider } from './types.js';
import type { RegisteredGroup } from '../types.js';

function makeGroup(
  folder: string,
  useDefaultCredentials?: boolean,
): RegisteredGroup {
  return {
    name: `Group ${folder}`,
    folder,
    trigger: '@Andy',
    added_at: new Date().toISOString(),
    containerConfig: useDefaultCredentials !== undefined
      ? { useDefaultCredentials }
      : undefined,
  };
}

describe('resolveSecrets', () => {
  beforeEach(() => {
    initCredentialStore();
  });

  it('returns empty when no credentials exist and default not allowed', () => {
    const group = makeGroup('no-creds');
    const secrets = resolveSecrets(group);
    expect(secrets).toEqual({});
  });

  it('returns group-specific credentials', () => {
    // Register a test provider
    const provider: CredentialProvider = {
      service: 'test-resolve',
      displayName: 'Test',
      hasAuth: (scope) => scope === 'my-group',
      provision: (scope) => {
        if (scope === 'my-group') return { env: { MY_KEY: 'group-value' } };
        return { env: {} as Record<string, string> };
      },
      storeResult: () => {},
      authOptions: () => [],
    };
    registerProvider(provider);

    const group = makeGroup('my-group');
    const secrets = resolveSecrets(group);
    expect(secrets.MY_KEY).toBe('group-value');
  });

  it('falls back to default scope when useDefaultCredentials is true', () => {
    const provider: CredentialProvider = {
      service: 'test-default',
      displayName: 'Test',
      hasAuth: () => false,
      provision: (scope) => {
        if (scope === 'default') return { env: { DEF_KEY: 'default-value' } };
        return { env: {} as Record<string, string> };
      },
      storeResult: () => {},
      authOptions: () => [],
    };
    registerProvider(provider);

    const group = makeGroup('some-group', true);
    const secrets = resolveSecrets(group);
    expect(secrets.DEF_KEY).toBe('default-value');
  });

  it('does NOT fall back to default when useDefaultCredentials is not set', () => {
    const provider: CredentialProvider = {
      service: 'test-no-default',
      displayName: 'Test',
      hasAuth: () => false,
      provision: (scope) => {
        if (scope === 'default')
          return { env: { BLOCKED_KEY: 'should-not-see' } };
        return { env: {} as Record<string, string> };
      },
      storeResult: () => {},
      authOptions: () => [],
    };
    registerProvider(provider);

    const group = makeGroup('isolated-group');
    const secrets = resolveSecrets(group);
    expect(secrets.BLOCKED_KEY).toBeUndefined();
  });

  it('does NOT fall back to default when useDefaultCredentials is false', () => {
    const provider: CredentialProvider = {
      service: 'test-explicit-false',
      displayName: 'Test',
      hasAuth: () => false,
      provision: (scope) => {
        if (scope === 'default')
          return { env: { NOPE: 'blocked' } };
        return { env: {} as Record<string, string> };
      },
      storeResult: () => {},
      authOptions: () => [],
    };
    registerProvider(provider);

    const group = makeGroup('locked-group', false);
    const secrets = resolveSecrets(group);
    expect(secrets.NOPE).toBeUndefined();
  });

  it('group scope takes precedence over default', () => {
    const provider: CredentialProvider = {
      service: 'test-precedence',
      displayName: 'Test',
      hasAuth: () => true,
      provision: (scope) => {
        if (scope === 'priority-group') return { env: { K: 'group' } };
        if (scope === 'default') return { env: { K: 'default' } };
        return { env: {} as Record<string, string> };
      },
      storeResult: () => {},
      authOptions: () => [],
    };
    registerProvider(provider);

    const group = makeGroup('priority-group', true);
    const secrets = resolveSecrets(group);
    expect(secrets.K).toBe('group');
  });
});

describe('importEnvToDefault', () => {
  beforeEach(() => {
    initCredentialStore();
  });

  it('calls importEnv on providers that have it', () => {
    const importEnvMock = vi.fn();
    const provider: CredentialProvider = {
      service: 'test-import',
      displayName: 'Test',
      hasAuth: () => false,
      provision: () => ({ env: {} }),
      storeResult: () => {},
      authOptions: () => [],
      importEnv: importEnvMock,
    };
    registerProvider(provider);

    importEnvToDefault();
    expect(importEnvMock).toHaveBeenCalledWith('default');
  });

  it('skips providers without importEnv', () => {
    const provider: CredentialProvider = {
      service: 'test-no-import',
      displayName: 'Test',
      hasAuth: () => false,
      provision: () => ({ env: {} }),
      storeResult: () => {},
      authOptions: () => [],
    };
    registerProvider(provider);

    // Should not throw
    importEnvToDefault();
  });
});
