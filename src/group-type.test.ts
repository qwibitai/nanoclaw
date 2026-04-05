import { describe, it, expect } from 'vitest';

import {
  resolveGroupType,
  hasPrivilege,
  getDefaultAllowedTools,
} from './group-type.js';
import type { RegisteredGroup } from './types.js';

function makeGroup(type: unknown): RegisteredGroup {
  return {
    name: 'test',
    folder: 'test',
    trigger: '!',
    added_at: '2026-01-01T00:00:00.000Z',
    type: type as RegisteredGroup['type'],
  };
}

// --- resolveGroupType ---

describe('resolveGroupType', () => {
  it('returns valid types as-is', () => {
    expect(resolveGroupType(makeGroup('main'))).toBe('main');
    expect(resolveGroupType(makeGroup('override'))).toBe('override');
    expect(resolveGroupType(makeGroup('chat'))).toBe('chat');
    expect(resolveGroupType(makeGroup('thread'))).toBe('thread');
  });

  it('falls back to "chat" when type is undefined/null', () => {
    expect(resolveGroupType(makeGroup(undefined))).toBe('chat');
    expect(resolveGroupType(makeGroup(null))).toBe('chat');
  });

  it('falls back to "chat" for unknown/invalid type strings', () => {
    expect(resolveGroupType(makeGroup('admin'))).toBe('chat');
    expect(resolveGroupType(makeGroup(''))).toBe('chat');
    expect(resolveGroupType(makeGroup('MAIN'))).toBe('chat');
  });
});

// --- hasPrivilege ---

describe('hasPrivilege', () => {
  it('returns true for main', () => {
    expect(hasPrivilege(makeGroup('main'))).toBe(true);
  });

  it('returns true for override', () => {
    expect(hasPrivilege(makeGroup('override'))).toBe(true);
  });

  it('returns false for chat', () => {
    expect(hasPrivilege(makeGroup('chat'))).toBe(false);
  });

  it('returns false for thread', () => {
    expect(hasPrivilege(makeGroup('thread'))).toBe(false);
  });

  it('returns false for undefined type (falls back to chat)', () => {
    expect(hasPrivilege(makeGroup(undefined))).toBe(false);
  });

  it('returns false for invalid type string (falls back to chat)', () => {
    expect(hasPrivilege(makeGroup('superadmin'))).toBe(false);
  });
});

// --- getDefaultAllowedTools ---

describe('getDefaultAllowedTools', () => {
  it('returns undefined (unrestricted) for main', () => {
    expect(getDefaultAllowedTools('main')).toBeUndefined();
  });

  it('returns undefined (unrestricted) for override', () => {
    expect(getDefaultAllowedTools('override')).toBeUndefined();
  });

  it('returns ["Read"] for chat', () => {
    expect(getDefaultAllowedTools('chat')).toEqual(['Read']);
  });

  it('returns ["Read"] for thread', () => {
    expect(getDefaultAllowedTools('thread')).toEqual(['Read']);
  });
});
