import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './connection.js';
import {
  getAllRegisteredGroups,
  getRegisteredGroup,
  setGroupEffort,
  setGroupModel,
  setGroupThinkingBudget,
  setRegisteredGroup,
} from './registered-groups.js';

beforeEach(() => {
  _initTestDatabase();
});

const base = {
  name: 'Test',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: '2026-01-01T00:00:00.000Z',
};

describe('registered-groups DAO', () => {
  it('setRegisteredGroup + getRegisteredGroup round-trip', () => {
    setRegisteredGroup('chat@g.us', { ...base, isMain: true });
    const g = getRegisteredGroup('chat@g.us');
    expect(g?.name).toBe('Test');
    expect(g?.isMain).toBe(true);
  });

  it('getRegisteredGroup returns undefined for missing jid', () => {
    expect(getRegisteredGroup('missing@g.us')).toBeUndefined();
  });

  it('persists containerConfig as JSON and round-trips it', () => {
    setRegisteredGroup('chat@g.us', {
      ...base,
      containerConfig: {
        additionalMounts: [{ hostPath: '/tmp', containerPath: 'tmp' }],
        timeout: 60_000,
      },
    });
    const g = getRegisteredGroup('chat@g.us');
    expect(g?.containerConfig?.timeout).toBe(60_000);
    expect(g?.containerConfig?.additionalMounts).toHaveLength(1);
  });

  it('rejects setRegisteredGroup with unsafe folder', () => {
    expect(() =>
      setRegisteredGroup('bad@g.us', { ...base, folder: '../escape' }),
    ).toThrow(/Invalid group folder/);
  });

  it('getAllRegisteredGroups returns every persisted entry keyed by jid', () => {
    setRegisteredGroup('a@g.us', { ...base, folder: 'a' });
    setRegisteredGroup('b@g.us', { ...base, folder: 'b', isMain: true });
    const all = getAllRegisteredGroups();
    expect(Object.keys(all).sort()).toEqual(['a@g.us', 'b@g.us']);
    expect(all['b@g.us'].isMain).toBe(true);
  });

  it('requiresTrigger defaults to true when not specified, persists when false', () => {
    setRegisteredGroup('def@g.us', base);
    expect(getRegisteredGroup('def@g.us')?.requiresTrigger).toBe(true);
    setRegisteredGroup('no-trig@g.us', { ...base, requiresTrigger: false });
    expect(getRegisteredGroup('no-trig@g.us')?.requiresTrigger).toBe(false);
  });

  it('setGroupModel, setGroupEffort, setGroupThinkingBudget update the row', () => {
    setRegisteredGroup('chat@g.us', base);
    setGroupModel('chat@g.us', 'claude-opus-4-20250514');
    setGroupEffort('chat@g.us', 'high');
    setGroupThinkingBudget('chat@g.us', 'adaptive');
    const g = getRegisteredGroup('chat@g.us');
    expect(g?.model).toBe('claude-opus-4-20250514');
    expect(g?.effort).toBe('high');
    expect(g?.thinking_budget).toBe('adaptive');
  });

  it('setting a field to null clears it', () => {
    setRegisteredGroup('chat@g.us', { ...base, model: 'opus' });
    setGroupModel('chat@g.us', null);
    expect(getRegisteredGroup('chat@g.us')?.model).toBeUndefined();
  });
});
