import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { processJsonIpcDirectory } from '../ipc/file-processor.js';
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
      event_type: 'PostToolUse',
      tool_name: 'Bash',
      payload: {
        group_folder: 'ceo',
        tool_use_id: 'toolu_01ABC',
        tool_input: '{"command":"ls"}',
        tool_response: '{"stdout":"file.txt"}',
      },
    });

    const events = getRecentToolEvents(10);
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('sess-1');
    expect(events[0].event_type).toBe('PostToolUse');
    expect(events[0].tool_name).toBe('Bash');
    const parsed = JSON.parse(events[0].payload!);
    expect(parsed.group_folder).toBe('ceo');
    expect(parsed.tool_use_id).toBe('toolu_01ABC');
    expect(parsed.tool_input).toBe('{"command":"ls"}');
    expect(parsed.tool_response).toBe('{"stdout":"file.txt"}');
  });

  it('truncates payload to 4KB', () => {
    const longValue = 'x'.repeat(5000);
    insertToolCallEvent({
      session_id: 'sess-2',
      event_type: 'PostToolUse',
      tool_name: 'Read',
      payload: { tool_response: longValue },
    });

    const events = getRecentToolEvents(10);
    expect(events).toHaveLength(1);
    expect(events[0].payload!.length).toBe(4096);
  });

  it('handles null payload', () => {
    insertToolCallEvent({
      session_id: 'sess-3',
      event_type: 'PostToolUseFailure',
      tool_name: 'Edit',
    });

    const events = getRecentToolEvents(10);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toBeNull();
  });
});

describe('getRecentToolEvents', () => {
  it('returns events within the time window', () => {
    insertToolCallEvent({
      session_id: 'sess-1',
      event_type: 'PostToolUse',
      tool_name: 'Bash',
    });

    // Events inserted just now should be within a 5-minute window
    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(1);
  });

  it('returns events ordered by created_at DESC', () => {
    insertToolCallEvent({
      session_id: 'sess-1',
      event_type: 'PostToolUse',
      tool_name: 'Bash',
    });
    insertToolCallEvent({
      session_id: 'sess-1',
      event_type: 'PostToolUse',
      tool_name: 'Read',
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
        event_type: 'PostToolUse',
        tool_name: `Tool${i}`,
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
      event_type: 'PostToolUse',
      tool_name: 'Bash',
    });

    const pruned = pruneToolEvents(7);
    expect(pruned).toBe(0);

    const events = getRecentToolEvents(10);
    expect(events).toHaveLength(1);
  });
});

describe('end-to-end: IPC file -> SQLite -> getRecentToolEvents', () => {
  let tmpDir: string;
  let toolEventsDir: string;
  let errorDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-events-e2e-'));
    toolEventsDir = path.join(tmpDir, 'tool-events');
    errorDir = path.join(tmpDir, 'errors');
    fs.mkdirSync(toolEventsDir, { recursive: true });
    fs.mkdirSync(errorDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ingests a hook-written JSON file into SQLite and retrieves via getRecentToolEvents', async () => {
    // Simulate what tool-observer.sh writes: a JSON event file
    const hookOutput = {
      tool_name: 'Bash',
      tool_use_id: 'toolu_abc123',
      session_id: 'e2e-sess-1',
      hook_event: 'PostToolUse',
      tool_input: '{"command":"git status"}',
      tool_response: '{"stdout":"On branch main"}',
    };
    fs.writeFileSync(
      path.join(toolEventsDir, '1234567890-Bash.json'),
      JSON.stringify(hookOutput),
    );

    // Run the IPC processor (same logic as startIpcWatcher uses)
    const sourceGroup = 'test-group';
    await processJsonIpcDirectory({
      directory: toolEventsDir,
      errorDirectory: errorDir,
      sourceGroup,
      createLogger: () =>
        ({ warn: () => {}, debug: () => {}, error: () => {}, info: () => {} }) as any,
      handle: async (data) => {
        const event = data as typeof hookOutput;
        insertToolCallEvent({
          session_id: event.session_id,
          event_type: event.hook_event || 'PostToolUse',
          tool_name: event.tool_name,
          payload: {
            group_folder: sourceGroup,
            tool_use_id: event.tool_use_id ?? null,
            tool_input: event.tool_input,
            tool_response: event.tool_response,
          },
        });
      },
    });

    // Verify the event is stored and retrievable
    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(1);
    expect(events[0].session_id).toBe('e2e-sess-1');
    expect(events[0].event_type).toBe('PostToolUse');
    expect(events[0].tool_name).toBe('Bash');

    const payload = JSON.parse(events[0].payload!);
    expect(payload.group_folder).toBe('test-group');
    expect(payload.tool_use_id).toBe('toolu_abc123');
    expect(payload.tool_input).toBe('{"command":"git status"}');

    // Verify the JSON file was consumed (deleted by processJsonIpcDirectory)
    const remaining = fs.readdirSync(toolEventsDir);
    expect(remaining).toHaveLength(0);
  });

  it('processes multiple tool events from a sequence (Bash, Read, WebFetch)', async () => {
    const tools = ['Bash', 'Read', 'WebFetch'];
    for (let i = 0; i < tools.length; i++) {
      const hookOutput = {
        tool_name: tools[i],
        tool_use_id: `toolu_${i}`,
        session_id: 'e2e-sess-2',
        hook_event: 'PostToolUse',
        tool_input: `input-${i}`,
        tool_response: `response-${i}`,
      };
      fs.writeFileSync(
        path.join(toolEventsDir, `${Date.now()}-${tools[i]}.json`),
        JSON.stringify(hookOutput),
      );
    }

    await processJsonIpcDirectory({
      directory: toolEventsDir,
      errorDirectory: errorDir,
      sourceGroup: 'e2e-group',
      createLogger: () =>
        ({ warn: () => {}, debug: () => {}, error: () => {}, info: () => {} }) as any,
      handle: async (data) => {
        const event = data as { tool_name: string; tool_use_id: string; session_id: string; hook_event: string; tool_input: string; tool_response: string };
        insertToolCallEvent({
          session_id: event.session_id,
          event_type: event.hook_event,
          tool_name: event.tool_name,
          payload: {
            group_folder: 'e2e-group',
            tool_use_id: event.tool_use_id,
            tool_input: event.tool_input,
            tool_response: event.tool_response,
          },
        });
      },
    });

    // All 3 events should be stored
    const events = getRecentToolEvents(5);
    expect(events).toHaveLength(3);
    const toolNames = events.map((e) => e.tool_name).sort();
    expect(toolNames).toEqual(['Bash', 'Read', 'WebFetch']);

    // All files consumed
    expect(fs.readdirSync(toolEventsDir)).toHaveLength(0);
  });
});
