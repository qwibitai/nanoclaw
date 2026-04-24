import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getRecentToolEvents } from '../db/index.js';

import { handleToolEventIpc, ToolEventIpc } from './tool-events-handler.js';

describe('Tool Event IPC Handler', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('should handle tool event IPC and store in database', async () => {
    const event: ToolEventIpc = {
      session_id: 'sess-abc123',
      tool_name: 'Bash',
      tool_use_id: 'toolu_xyz',
      hook_event: 'PostToolUse',
      tool_input: '{"command":"npm test"}',
      tool_response: '{"stdout":"Tests passed"}',
      timestamp: new Date().toISOString(),
    };

    await handleToolEventIpc(event, 'test-group');

    const events = getRecentToolEvents('test-group', 60 * 1000);
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('sess-abc123');
    expect(events[0].tool_name).toBe('Bash');
    expect(events[0].hook_event).toBe('PostToolUse');
    expect(events[0].group_folder).toBe('test-group');
  });

  it('should handle PostToolUseFailure events', async () => {
    const event: ToolEventIpc = {
      session_id: 'sess-fail',
      tool_name: 'Edit',
      hook_event: 'PostToolUseFailure',
      tool_input: '{"file_path":"/nonexistent"}',
      tool_response: '{"error":"File not found"}',
      timestamp: new Date().toISOString(),
    };

    await handleToolEventIpc(event, 'ceo');

    const events = getRecentToolEvents('ceo', 60 * 1000);
    expect(events).toHaveLength(1);
    expect(events[0].hook_event).toBe('PostToolUseFailure');
  });

  it('should handle events with missing optional fields', async () => {
    const event: ToolEventIpc = {
      session_id: 'sess-minimal',
      tool_name: 'Read',
      hook_event: 'PostToolUse',
      timestamp: new Date().toISOString(),
    };

    await handleToolEventIpc(event, 'test-group');

    const events = getRecentToolEvents('test-group', 60 * 1000);
    expect(events).toHaveLength(1);
    expect(events[0].tool_input).toBeNull();
    expect(events[0].tool_response).toBeNull();
    expect(events[0].tool_use_id).toBeNull();
  });
});
