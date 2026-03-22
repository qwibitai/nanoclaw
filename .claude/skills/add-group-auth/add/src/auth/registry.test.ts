import { describe, it, expect } from 'vitest';

import {
  registerProvider,
  getProvider,
  getAllProviders,
} from './registry.js';
import type { CredentialProvider } from './types.js';

const makeStub = (service: string): CredentialProvider => ({
  service,
  displayName: service,
  hasAuth: () => false,
  provision: () => ({ env: {} }),
  storeResult: () => {},
  authOptions: () => [],
});

describe('auth provider registry', () => {
  it('getProvider returns undefined for unknown', () => {
    expect(getProvider('nonexistent-xyz')).toBeUndefined();
  });

  it('register and get round-trip', () => {
    const stub = makeStub('reg-test');
    registerProvider(stub);
    expect(getProvider('reg-test')).toBe(stub);
  });

  it('getAllProviders includes registered', () => {
    const stub = makeStub('all-test');
    registerProvider(stub);
    const all = getAllProviders();
    expect(all.some((p) => p.service === 'all-test')).toBe(true);
  });

  it('later registration overwrites earlier', () => {
    const first = makeStub('overwrite');
    const second = makeStub('overwrite');
    registerProvider(first);
    registerProvider(second);
    expect(getProvider('overwrite')).toBe(second);
  });
});
