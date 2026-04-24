import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './index.js';
import {
  insertToolEvent,
  getRecentToolEvents,
  pruneToolEvents,
} from './tool-events.js';

describe('Tool Events', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('should insert and retrieve tool events', () => {
    const now = new Date().toISOString();

    insertToolEvent({
      session_id: 'sess-123',
      group_folder: 'test-group',
      tool_name: 'Bash',
      tool_use_id: 'toolu_abc',
      hook_event: 'PostToolUse',
      tool_input: '{"command":"ls"}',
      tool_response: '{"stdout":"file1\\nfile2"}',
      timestamp: now,
    });

    const events = getRecentToolEvents('test-group', 60 * 1000);
    expect(events).toHaveLength(1);
    expect(events[0].tool_name).toBe('Bash');
    expect(events[0].hook_event).toBe('PostToolUse');
    expect(events[0].session_id).toBe('sess-123');
  });

  it('should filter events by group folder', () => {
    const now = new Date().toISOString();

    insertToolEvent({
      session_id: 'sess-1',
      group_folder: 'group-a',
      tool_name: 'Read',
      hook_event: 'PostToolUse',
      timestamp: now,
    });

    insertToolEvent({
      session_id: 'sess-2',
      group_folder: 'group-b',
      tool_name: 'Write',
      hook_event: 'PostToolUse',
      timestamp: now,
    });

    const eventsA = getRecentToolEvents('group-a', 60 * 1000);
    const eventsB = getRecentToolEvents('group-b', 60 * 1000);

    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
    expect(eventsA[0].tool_name).toBe('Read');
    expect(eventsB[0].tool_name).toBe('Write');
  });

  it('should filter events by time window', () => {
    const now = Date.now();
    const oldTimestamp = new Date(now - 10 * 60 * 1000).toISOString(); // 10 minutes ago
    const recentTimestamp = new Date(now - 2 * 60 * 1000).toISOString(); // 2 minutes ago

    insertToolEvent({
      session_id: 'sess-old',
      group_folder: 'test-group',
      tool_name: 'OldTool',
      hook_event: 'PostToolUse',
      timestamp: oldTimestamp,
    });

    insertToolEvent({
      session_id: 'sess-recent',
      group_folder: 'test-group',
      tool_name: 'RecentTool',
      hook_event: 'PostToolUse',
      timestamp: recentTimestamp,
    });

    // Get events from last 5 minutes
    const events = getRecentToolEvents('test-group', 5 * 60 * 1000);
    expect(events).toHaveLength(1);
    expect(events[0].tool_name).toBe('RecentTool');
  });

  it('should handle PostToolUseFailure events', () => {
    const now = new Date().toISOString();

    insertToolEvent({
      session_id: 'sess-fail',
      group_folder: 'test-group',
      tool_name: 'Bash',
      hook_event: 'PostToolUseFailure',
      tool_input: '{"command":"invalid"}',
      tool_response: '{"error":"Command failed"}',
      timestamp: now,
    });

    const events = getRecentToolEvents('test-group', 60 * 1000);
    expect(events).toHaveLength(1);
    expect(events[0].hook_event).toBe('PostToolUseFailure');
  });

  it('should prune old events', () => {
    const now = Date.now();
    const oldTimestamp = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago
    const recentTimestamp = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago

    insertToolEvent({
      session_id: 'sess-old',
      group_folder: 'test-group',
      tool_name: 'OldTool',
      hook_event: 'PostToolUse',
      timestamp: oldTimestamp,
    });

    insertToolEvent({
      session_id: 'sess-recent',
      group_folder: 'test-group',
      tool_name: 'RecentTool',
      hook_event: 'PostToolUse',
      timestamp: recentTimestamp,
    });

    const pruned = pruneToolEvents(7);
    expect(pruned).toBe(1);

    // Verify only recent event remains
    const events = getRecentToolEvents('test-group', 30 * 24 * 60 * 60 * 1000);
    expect(events).toHaveLength(1);
    expect(events[0].tool_name).toBe('RecentTool');
  });

  it('should return events in reverse chronological order', () => {
    const now = Date.now();

    insertToolEvent({
      session_id: 'sess-1',
      group_folder: 'test-group',
      tool_name: 'First',
      hook_event: 'PostToolUse',
      timestamp: new Date(now - 3000).toISOString(),
    });

    insertToolEvent({
      session_id: 'sess-2',
      group_folder: 'test-group',
      tool_name: 'Second',
      hook_event: 'PostToolUse',
      timestamp: new Date(now - 2000).toISOString(),
    });

    insertToolEvent({
      session_id: 'sess-3',
      group_folder: 'test-group',
      tool_name: 'Third',
      hook_event: 'PostToolUse',
      timestamp: new Date(now - 1000).toISOString(),
    });

    const events = getRecentToolEvents('test-group', 60 * 1000);
    expect(events).toHaveLength(3);
    expect(events[0].tool_name).toBe('Third');
    expect(events[1].tool_name).toBe('Second');
    expect(events[2].tool_name).toBe('First');
  });
});
