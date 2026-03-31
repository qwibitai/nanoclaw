import { describe, it, expect } from 'vitest';

import { validateProjectName } from './scaffold-project.js';

describe('validateProjectName', () => {
  it('accepts valid lowercase-hyphenated names', () => {
    expect(validateProjectName('gravity-misinfo')).toBeNull();
    expect(validateProjectName('my-project')).toBeNull();
    expect(validateProjectName('a')).toBeNull();
    expect(validateProjectName('project123')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(validateProjectName('')).toMatch(/must match/i);
  });

  it('rejects names with uppercase', () => {
    expect(validateProjectName('MyProject')).toMatch(/must match/i);
  });

  it('rejects names with path separators', () => {
    expect(validateProjectName('foo/bar')).toMatch(/must match/i);
    expect(validateProjectName('../etc')).toMatch(/must match/i);
  });

  it('rejects names with dots', () => {
    expect(validateProjectName('my.project')).toMatch(/must match/i);
  });

  it('rejects names with spaces', () => {
    expect(validateProjectName('my project')).toMatch(/must match/i);
  });

  it('rejects names starting with hyphen', () => {
    expect(validateProjectName('-bad')).toMatch(/must match/i);
  });

  it('rejects names longer than 63 characters', () => {
    expect(validateProjectName('a'.repeat(64))).toMatch(/must match/i);
  });

  it('accepts names exactly 63 characters', () => {
    expect(validateProjectName('a'.repeat(63))).toBeNull();
  });

  it('rejects reserved names', () => {
    expect(validateProjectName('main')).toMatch(/reserved/i);
    expect(validateProjectName('global')).toMatch(/reserved/i);
    expect(validateProjectName('test')).toMatch(/reserved/i);
    expect(validateProjectName('node-modules')).toMatch(/reserved/i);
  });
});
