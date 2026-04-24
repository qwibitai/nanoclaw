import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './index.js';
import {
  insertToolEvent,
  getRecentToolEvents,
  pruneToolEvents,
} from './tool-events.js';

describe('tool-events', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  describe('insertToolEvent', () => {
    it('should insert a tool event', () => {
      const event = {
        session_id: 'test-session',
        group_folder: 'test-group',
        tool_name: 'Bash',
        tool_use_id: 'toolu_123',
        hook_event: 'PostToolUse',
        tool_input: '{"command": "echo hello"}',
        tool_response: '{"stdout": "hello"}',
        timestamp: new Date().toISOString(),
      };

      expect(() => insertToolEvent(event)).not.toThrow();
    });

    it('should handle optional fields', () => {
      const event = {
        session_id: 'test-session',
        group_folder: 'test-group',
        tool_name: 'Read',
        hook_event: 'PostToolUse',
        timestamp: new Date().toISOString(),
      };

      expect(() => insertToolEvent(event)).not.toThrow();
    });
  });

  describe('getRecentToolEvents', () => {
    it('should return recent events within time window', () => {
      const now = Date.now();
      const events = [
        {
          session_id: 'session-1',
          group_folder: 'group-1',
          tool_name: 'Bash',
          hook_event: 'PostToolUse',
          timestamp: new Date(now - 2 * 60_000).toISOString(), // 2 minutes ago
        },
        {
          session_id: 'session-2',
          group_folder: 'group-1',
          tool_name: 'Read',
          hook_event: 'PostToolUse',
          timestamp: new Date(now - 10 * 60_000).toISOString(), // 10 minutes ago
        },
      ];

      events.forEach((e) => insertToolEvent(e));

      const recent = getRecentToolEvents(5);
      expect(recent).toHaveLength(1);
      expect(recent[0].tool_name).toBe('Bash');
    });

    it('should return empty array when no recent events', () => {
      const recent = getRecentToolEvents(5);
      expect(recent).toEqual([]);
    });

    it('should order events by timestamp descending', () => {
      const now = Date.now();
      const events = [
        {
          session_id: 'session-1',
          group_folder: 'group-1',
          tool_name: 'Bash',
          hook_event: 'PostToolUse',
          timestamp: new Date(now - 3 * 60_000).toISOString(),
        },
        {
          session_id: 'session-2',
          group_folder: 'group-1',
          tool_name: 'Read',
          hook_event: 'PostToolUse',
          timestamp: new Date(now - 1 * 60_000).toISOString(),
        },
      ];

      events.forEach((e) => insertToolEvent(e));

      const recent = getRecentToolEvents(5);
      expect(recent[0].tool_name).toBe('Read'); // Most recent first
      expect(recent[1].tool_name).toBe('Bash');
    });
  });

  describe('pruneToolEvents', () => {
    it('should delete events older than retention period', () => {
      const now = Date.now();
      const events = [
        {
          session_id: 'session-1',
          group_folder: 'group-1',
          tool_name: 'Bash',
          hook_event: 'PostToolUse',
          timestamp: new Date(now - 8 * 86400_000).toISOString(), // 8 days ago
        },
        {
          session_id: 'session-2',
          group_folder: 'group-1',
          tool_name: 'Read',
          hook_event: 'PostToolUse',
          timestamp: new Date(now - 1 * 86400_000).toISOString(), // 1 day ago
        },
      ];

      events.forEach((e) => insertToolEvent(e));

      pruneToolEvents(7);

      const recent = getRecentToolEvents(10000); // Large window to get all
      expect(recent).toHaveLength(1);
      expect(recent[0].tool_name).toBe('Read');
    });

    it('should not delete events within retention period', () => {
      const now = Date.now();
      const event = {
        session_id: 'session-1',
        group_folder: 'group-1',
        tool_name: 'Bash',
        hook_event: 'PostToolUse',
        timestamp: new Date(now - 3 * 86400_000).toISOString(), // 3 days ago
      };

      insertToolEvent(event);

      pruneToolEvents(7);

      const recent = getRecentToolEvents(10000);
      expect(recent).toHaveLength(1);
    });
  });
});
