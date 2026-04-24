import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './index.js';
import {
  getRecentToolEvents,
  insertToolCallEvent,
  pruneToolEvents,
} from './tool-events.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('insertToolCallEvent', () => {
  it('inserts an event and retrieves it', () => {
    insertToolCallEvent({
      session_id: 'sess-1',
      group_folder: 'ceo',
      tool_name: 'Bash',
      tool_use_id: 'toolu_01ABC',
      hook_event: 'PostToolUse',
      tool_input: '{"command":"ls"}',
      tool_response: '{"stdout":"file.txt"}',
    });

    const events = getRecentToolEvents(10);
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('sess-1');
    expect(events[0].group_folder).toBe('ceo');
    expect(events[0].tool_name).toBe('Bash');
    expect(events[0].tool_use_id).toBe('toolu_01ABC');
    expect(events[0].hook_event).toBe('PostToolUse');
    expect(events[0].tool_input).toBe('{"command":"ls"}');
    expect(events[0].tool_response).toBe('{"stdout":"file.txt"}');
  });

  it('truncates tool_response to 2KB', () => {
    const longResponse = 'x'.repeat(5000);
    insertToolCallEvent({
      session_id: 'sess-2',
      group_folder: 'ceo',
      tool_name: 'Read',
      hook_event: 'PostToolUse',
      tool_response: longResponse,
    });

    const events = getRecentToolEvents(10);
    expect(events).toHaveLength(1);
    expect(events[0].tool_response!.length).toBe(2048);
  });

  it('handles null optional fields', () => {
    insertToolCallEvent({
      session_id: 'sess-3',
      group_folder: 'ceo',
      tool_name: 'Edit',
      hook_event: 'PostToolUseFailure',
    });

    const events = getRecentToolEvents(10);
    expect(events).toHaveLength(1);
    expect(events[0].tool_use_id).toBeNull();
    expect(events[0].tool_input).toBeNull();
    expect(events[0].tool_response).toBeNull();
  });
});

describe('getRecentToolEvents', () => {
  it('returns events within the time window', () => {
    insertToolCallEvent({
      session_id: 'sess-1',
      group_folder: 'ceo',
      tool_name: 'Bash',
      hook_event: 'PostToolUse',
    });

    // Events inserted just now should be within a 5-minute window
    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(1);
  });

  it('returns events ordered by created_at DESC', () => {
    insertToolCallEvent({
      session_id: 'sess-1',
      group_folder: 'ceo',
      tool_name: 'Bash',
      hook_event: 'PostToolUse',
    });
    insertToolCallEvent({
      session_id: 'sess-1',
      group_folder: 'ceo',
      tool_name: 'Read',
      hook_event: 'PostToolUse',
    });

    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(2);
    // Most recent first
    expect(events[0].tool_name).toBe('Read');
    expect(events[1].tool_name).toBe('Bash');
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      insertToolCallEvent({
        session_id: 'sess-1',
        group_folder: 'ceo',
        tool_name: `Tool${i}`,
        hook_event: 'PostToolUse',
      });
    }

    const events = getRecentToolEvents(5, 3);
    expect(events).toHaveLength(3);
  });

  it('returns empty array when no events exist', () => {
    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(0);
  });
});

describe('pruneToolEvents', () => {
  it('returns 0 when no events to prune', () => {
    const pruned = pruneToolEvents(7);
    expect(pruned).toBe(0);
  });

  it('does not prune recent events', () => {
    insertToolCallEvent({
      session_id: 'sess-1',
      group_folder: 'ceo',
      tool_name: 'Bash',
      hook_event: 'PostToolUse',
    });

    const pruned = pruneToolEvents(7);
    expect(pruned).toBe(0);

    const events = getRecentToolEvents(10);
    expect(events).toHaveLength(1);
  });
});
