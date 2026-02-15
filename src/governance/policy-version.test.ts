import { describe, expect, it } from 'vitest';
import { POLICY_VERSION } from './policy-version.js';

describe('POLICY_VERSION', () => {
  it('exports a semver string', () => {
    expect(POLICY_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('is 1.0.0 for Sprint 3', () => {
    expect(POLICY_VERSION).toBe('1.0.0');
  });
});
