import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  getSession,
  setSession,
  getAllSessions,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('session persistence', () => {
  describe('OpenCode session IDs', () => {
    it('stores and retrieves OpenCode format session ID', () => {
      const openCodeSessionId = 'ses_abc123def456ghi789jkl012mno345';
      setSession('test-group', openCodeSessionId);

      const retrieved = getSession('test-group');
      expect(retrieved).toBe(openCodeSessionId);
    });

    it('stores and retrieves Claude format session ID', () => {
      const claudeSessionId = 'sess_550e8400-e29b-41d4-a716-446655440000';
      setSession('test-group', claudeSessionId);

      const retrieved = getSession('test-group');
      expect(retrieved).toBe(claudeSessionId);
    });

    it('persists sessions across getAllSessions calls', () => {
      const openCodeSessionId = 'ses_abc123def456ghi789jkl012mno345';
      setSession('group1', openCodeSessionId);
      setSession('group2', 'sess_550e8400-e29b-41d4-a716-446655440000');

      const allSessions = getAllSessions();
      expect(allSessions['group1']).toBe(openCodeSessionId);
      expect(allSessions['group2']).toBe(
        'sess_550e8400-e29b-41d4-a716-446655440000',
      );
    });

    it('updates existing session ID', () => {
      const oldSessionId = 'ses_old123def456ghi789jkl012mno345';
      const newSessionId = 'ses_new789abc123def456ghi789jkl012';

      setSession('test-group', oldSessionId);
      expect(getSession('test-group')).toBe(oldSessionId);

      setSession('test-group', newSessionId);
      expect(getSession('test-group')).toBe(newSessionId);
    });

    it('handles multiple groups independently', () => {
      setSession('group-a', 'ses_abc123def456ghi789jkl012mno345');
      setSession('group-b', 'ses_def456ghi789jkl012mno345abc123');
      setSession('group-c', 'sess_550e8400-e29b-41d4-a716-446655440000');

      const allSessions = getAllSessions();
      expect(Object.keys(allSessions)).toHaveLength(3);
      expect(allSessions['group-a']).toBe('ses_abc123def456ghi789jkl012mno345');
      expect(allSessions['group-b']).toBe('ses_def456ghi789jkl012mno345abc123');
      expect(allSessions['group-c']).toBe(
        'sess_550e8400-e29b-41d4-a716-446655440000',
      );
    });
  });

  describe('invalid session ID handling', () => {
    it('returns undefined for non-existent group', () => {
      const session = getSession('non-existent-group');
      expect(session).toBeUndefined();
    });

    it('rejects too short session IDs', () => {
      setSession('test-group', 'ab'); // only 2 chars
      const retrieved = getSession('test-group');
      expect(retrieved).toBeUndefined();
    });

    it('rejects empty string session ID', () => {
      setSession('test-group', '');
      const retrieved = getSession('test-group');
      expect(retrieved).toBeUndefined();
    });

    it('rejects null-like session IDs', () => {
      setSession('test-group', 'null');
      setSession('test-group', 'undefined');
      const retrieved = getSession('test-group');
      expect(retrieved).toBeUndefined();
    });

    it('filters out invalid sessions from getAllSessions', () => {
      setSession('valid-group', 'ses_abc123def456ghi789jkl012mno345');
      setSession('invalid-group', ''); // empty string is invalid

      const allSessions = getAllSessions();
      expect(Object.keys(allSessions)).toHaveLength(1);
      expect(allSessions['valid-group']).toBe(
        'ses_abc123def456ghi789jkl012mno345',
      );
      expect(allSessions['invalid-group']).toBeUndefined();
    });

    it('handles corrupted session IDs gracefully', () => {
      const corruptedIds = [
        '', // empty string
        'ab', // too short (less than 3 chars)
        'a', // single char
        'null', // null string literal
        'undefined', // undefined string literal
      ];

      corruptedIds.forEach((id, index) => {
        setSession(`corrupted-${index}`, id);
      });

      const allSessions = getAllSessions();
      expect(Object.keys(allSessions)).toHaveLength(0);
    });

    it('preserves valid sessions when filtering invalid ones', () => {
      setSession('valid-1', 'ses_abc123def456ghi789jkl012mno345');
      setSession('invalid-1', ''); // empty string
      setSession('valid-2', 'sess_550e8400-e29b-41d4-a716-446655440000');
      setSession('invalid-2', 'null'); // null string
      setSession('valid-3', 'ses_xyz789abc123def456ghi789jkl012');

      const allSessions = getAllSessions();
      expect(Object.keys(allSessions)).toHaveLength(3);
      expect(allSessions['valid-1']).toBeDefined();
      expect(allSessions['valid-2']).toBeDefined();
      expect(allSessions['valid-3']).toBeDefined();
      expect(allSessions['invalid-1']).toBeUndefined();
      expect(allSessions['invalid-2']).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('handles session IDs with unicode characters', () => {
      const unicodeId = 'sess_测试_🎉';
      setSession('test-group', unicodeId);
      expect(getSession('test-group')).toBe(unicodeId);
    });

    it('accepts various OpenCode-like formats', () => {
      // OpenCode format variations (alphanumeric after ses_ prefix)
      const variations = [
        'ses_abc123def456ghi789', // 20 chars after prefix
        'ses_' + 'a'.repeat(32), // 32 chars after prefix
        'ses_' + 'a'.repeat(50), // 50 chars after prefix - still accepted
        'SES_ABC123DEF456GHI789JKL012MNO345', // uppercase
        'ses_abc', // short but valid
      ];

      variations.forEach((id, index) => {
        setSession(`test-group-${index}`, id);
        expect(getSession(`test-group-${index}`)).toBe(id);
      });
    });

    it('handles case sensitivity correctly', () => {
      const lowerCaseId = 'ses_abc123def456ghi789jkl012mno345';
      const upperCaseId = 'SES_ABC123DEF456GHI789JKL012MNO345';

      setSession('test-group', lowerCaseId);
      expect(getSession('test-group')).toBe(lowerCaseId);

      setSession('test-group', upperCaseId);
      expect(getSession('test-group')).toBe(upperCaseId);
    });
  });
});
