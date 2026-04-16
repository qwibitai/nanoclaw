import { beforeEach, describe, expect, it } from 'vitest';

import { _initTestDatabase } from './connection.js';
import { getRouterState, setRouterState } from './router-state.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('router-state DAO', () => {
  it('stores and retrieves a value by key', () => {
    setRouterState('last_timestamp', '2026-01-01T00:00:00.000Z');
    expect(getRouterState('last_timestamp')).toBe('2026-01-01T00:00:00.000Z');
  });

  it('returns undefined for an unknown key', () => {
    expect(getRouterState('missing')).toBeUndefined();
  });

  it('overwrites the value on a second set', () => {
    setRouterState('cursor', 'a');
    setRouterState('cursor', 'b');
    expect(getRouterState('cursor')).toBe('b');
  });
});
