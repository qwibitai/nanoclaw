import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './connection.js';
import {
  deleteSession,
  getAllSessions,
  getSession,
  setSession,
} from './sessions.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('sessions DAO', () => {
  it('stores and retrieves a session id by group folder', () => {
    setSession('main', 'sess-abc');
    expect(getSession('main')).toBe('sess-abc');
  });

  it('overwrites on subsequent setSession for the same folder', () => {
    setSession('g', 'v1');
    setSession('g', 'v2');
    expect(getSession('g')).toBe('v2');
  });

  it('returns undefined for unknown folder', () => {
    expect(getSession('nobody')).toBeUndefined();
  });

  it('deleteSession removes only the requested folder', () => {
    setSession('a', 'x');
    setSession('b', 'y');
    deleteSession('a');
    expect(getSession('a')).toBeUndefined();
    expect(getSession('b')).toBe('y');
  });

  it('getAllSessions returns every stored mapping', () => {
    setSession('one', 'A');
    setSession('two', 'B');
    expect(getAllSessions()).toEqual({ one: 'A', two: 'B' });
  });

  it('getAllSessions returns empty object when no sessions exist', () => {
    expect(getAllSessions()).toEqual({});
  });
});
