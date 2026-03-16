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

/**
 * CONTRACT: Session persistence API
 * These functions define the contract for storing and retrieving Claude session IDs
 * per group folder. The migration to opencode depends on these contracts.
 */
describe('DB CONTRACT: Session persistence contracts', () => {
  describe('setSession / getSession round-trip', () => {
    it('stores and retrieves a session ID for a group folder', () => {
      // CONTRACT: setSession persists sessionId for a group folder
      setSession('group-a', 'session-abc-123');

      // CONTRACT: getSession retrieves the stored sessionId
      const retrieved = getSession('group-a');
      expect(retrieved).toBe('session-abc-123');
    });

    it('returns undefined for non-existent group folder', () => {
      // CONTRACT: getSession returns undefined when no session exists
      const retrieved = getSession('non-existent-group');
      expect(retrieved).toBeUndefined();
    });

    it('updates existing session ID (upsert behavior)', () => {
      // Set initial session
      setSession('group-b', 'session-old');
      expect(getSession('group-b')).toBe('session-old');

      // Update to new session
      setSession('group-b', 'session-new');
      expect(getSession('group-b')).toBe('session-new');
    });

    it('handles special characters in session IDs', () => {
      const sessionIdWithSpecialChars = 'sess_123-abc.xyz:utf8';
      setSession('group-c', sessionIdWithSpecialChars);
      expect(getSession('group-c')).toBe(sessionIdWithSpecialChars);
    });

    it('handles long session IDs', () => {
      const longSessionId = 'a'.repeat(500);
      setSession('group-d', longSessionId);
      expect(getSession('group-d')).toBe(longSessionId);
    });
  });

  describe('getAllSessions behavior', () => {
    it('returns empty object when no sessions exist', () => {
      // CONTRACT: getAllSessions returns empty Record when no sessions
      const all = getAllSessions();
      expect(all).toEqual({});
    });

    it('returns all stored sessions as a Record', () => {
      // Set up multiple sessions
      setSession('main', 'session-main-001');
      setSession('family-chat', 'session-family-002');
      setSession('work-group', 'session-work-003');

      // CONTRACT: getAllSessions returns all sessions as group_folder -> session_id mapping
      const all = getAllSessions();
      expect(all).toEqual({
        main: 'session-main-001',
        'family-chat': 'session-family-002',
        'work-group': 'session-work-003',
      });
    });

    it('reflects updates after setSession calls', () => {
      setSession('group-e', 'session-1');
      let all = getAllSessions();
      expect(all['group-e']).toBe('session-1');

      setSession('group-e', 'session-2');
      all = getAllSessions();
      expect(all['group-e']).toBe('session-2');
    });
  });

  describe('Session table schema contracts', () => {
    it('uses group_folder as primary key', () => {
      // This test verifies the schema: group_folder is PRIMARY KEY
      // Multiple sets for same group should result in one record (upsert)
      setSession('same-group', 'session-1');
      setSession('same-group', 'session-2');
      setSession('same-group', 'session-3');

      const all = getAllSessions();
      // CONTRACT: group_folder is PRIMARY KEY - only one entry per group
      expect(Object.keys(all)).toHaveLength(1);
      expect(all['same-group']).toBe('session-3');
    });

    it('isolates sessions between different group folders', () => {
      // Sessions for different groups should not interfere
      setSession('group-1', 'session-for-group-1');
      setSession('group-2', 'session-for-group-2');

      // CONTRACT: Each group folder has its own isolated session
      expect(getSession('group-1')).toBe('session-for-group-1');
      expect(getSession('group-2')).toBe('session-for-group-2');
      expect(getSession('group-1')).not.toBe(getSession('group-2'));
    });
  });

  describe('Session ID propagation contracts', () => {
    it('preserves exact session ID string', () => {
      // Session IDs must be stored and retrieved without modification
      const exactSessionId = 'sess_v1_a1b2c3d4e5f6g7h8i9j0';
      setSession('exact-test', exactSessionId);

      // CONTRACT: Session ID is preserved exactly (no truncation, no encoding changes)
      expect(getSession('exact-test')).toBe(exactSessionId);
    });

    it('handles unicode characters in session IDs', () => {
      const unicodeSessionId = 'sess_测试_🎉';
      setSession('unicode-test', unicodeSessionId);

      // CONTRACT: Unicode session IDs are preserved
      expect(getSession('unicode-test')).toBe(unicodeSessionId);
    });
  });
});
