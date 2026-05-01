import { beforeEach, describe, expect, it } from 'vitest';
import { createAgentGroup } from './db/agent-groups.js';
import { closeDb, initTestDb, runMigrations } from './db/index.js';
import { resolveAgentGroupByOneCliIdentifier, toOneCliAgentIdentifier } from './onecli-agent-identifier.js';

describe('OneCLI agent identifiers', () => {
  beforeEach(() => {
    closeDb();
    const db = initTestDb();
    runMigrations(db);
  });

  it('converts agent group IDs from underscores to hyphens', () => {
    expect(toOneCliAgentIdentifier('ag_f249a3521081')).toBe('ag-f249a3521081');
  });

  it('leaves already-valid OneCLI identifiers unchanged', () => {
    expect(toOneCliAgentIdentifier('ag-123')).toBe('ag-123');
    expect(toOneCliAgentIdentifier('ag-1777670186074-bomj1q')).toBe('ag-1777670186074-bomj1q');
  });

  it('converts all underscores and satisfies OneCLI validation', () => {
    const identifier = toOneCliAgentIdentifier('ag_foo_bar');

    expect(identifier).toBe('ag-foo-bar');
    expect(identifier).toMatch(/^[a-z0-9-]+$/);
  });

  it('resolves a normalized OneCLI identifier back to the database agent group', () => {
    createAgentGroup({
      id: 'ag_f249a3521081',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: 'claude',
      created_at: new Date().toISOString(),
    });

    expect(resolveAgentGroupByOneCliIdentifier('ag-f249a3521081')?.id).toBe('ag_f249a3521081');
  });

  it('throws when normalization still produces an invalid OneCLI identifier', () => {
    expect(() => toOneCliAgentIdentifier('ag_Foo')).toThrow(/invalid OneCLI identifier/);
    expect(() => toOneCliAgentIdentifier('ag/foo')).toThrow(/invalid OneCLI identifier/);
    expect(() => toOneCliAgentIdentifier('')).toThrow(/invalid OneCLI identifier/);
  });

  it('does not resolve ambiguous normalized identifiers', () => {
    createAgentGroup({
      id: 'ag_foo',
      name: 'Underscore Agent',
      folder: 'underscore-agent',
      agent_provider: 'claude',
      created_at: new Date().toISOString(),
    });

    createAgentGroup({
      id: 'ag-foo',
      name: 'Hyphen Agent',
      folder: 'hyphen-agent',
      agent_provider: 'claude',
      created_at: new Date().toISOString(),
    });

    expect(resolveAgentGroupByOneCliIdentifier('ag-foo')).toBeUndefined();
  });
});
