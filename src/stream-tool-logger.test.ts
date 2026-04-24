import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StreamToolLogger } from './stream-tool-logger.js';
import * as toolEvents from './db/tool-events.js';

vi.mock('./db/tool-events.js');
vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

describe('StreamToolLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts session_id from system/init message', () => {
    const logger = new StreamToolLogger('test-group');

    logger.processLine(
      '{"type":"system","subtype":"init","session_id":"sess-123"}',
    );

    expect(logger.getSessionId()).toBe('sess-123');
  });

  it('logs tool use and result pair', () => {
    const logger = new StreamToolLogger('test-group');
    const insertMock = vi.mocked(toolEvents.insertToolCallEvent);

    // Set session ID
    logger.processLine(
      '{"type":"system","subtype":"init","session_id":"sess-123"}',
    );

    // Tool use
    logger.processLine(
      '{"type":"tool_use","id":"tool-1","name":"Bash","input":{"command":"ls"}}',
    );

    // Tool result
    logger.processLine(
      '{"type":"tool_result","tool_use_id":"tool-1","content":"file1.txt\\nfile2.txt"}',
    );

    expect(insertMock).toHaveBeenCalledWith({
      session_id: 'sess-123',
      event_type: 'PostToolUse',
      tool_name: 'Bash',
      payload: {
        group_folder: 'test-group',
        tool_use_id: 'tool-1',
        tool_input: '{"command":"ls"}',
        tool_response: expect.stringContaining('file1.txt'),
      },
    });
  });

  it('handles tool result with array content', () => {
    const logger = new StreamToolLogger('test-group');
    const insertMock = vi.mocked(toolEvents.insertToolCallEvent);

    logger.processLine(
      '{"type":"system","subtype":"init","session_id":"sess-123"}',
    );
    logger.processLine(
      '{"type":"tool_use","id":"tool-2","name":"Read","input":{"file_path":"/foo/bar.txt"}}',
    );
    logger.processLine(
      '{"type":"tool_result","tool_use_id":"tool-2","content":[{"type":"text","text":"Hello World"}]}',
    );

    expect(insertMock).toHaveBeenCalledWith({
      session_id: 'sess-123',
      event_type: 'PostToolUse',
      tool_name: 'Read',
      payload: {
        group_folder: 'test-group',
        tool_use_id: 'tool-2',
        tool_input: '{"file_path":"/foo/bar.txt"}',
        tool_response: 'Hello World',
      },
    });
  });

  it('truncates tool_response to 2000 chars', () => {
    const logger = new StreamToolLogger('test-group');
    const insertMock = vi.mocked(toolEvents.insertToolCallEvent);

    const longContent = 'x'.repeat(3000);

    logger.processLine(
      '{"type":"system","subtype":"init","session_id":"sess-123"}',
    );
    logger.processLine(
      '{"type":"tool_use","id":"tool-3","name":"WebFetch","input":{}}',
    );
    logger.processLine(
      `{"type":"tool_result","tool_use_id":"tool-3","content":"${longContent}"}`,
    );

    expect(insertMock).toHaveBeenCalledWith({
      session_id: 'sess-123',
      event_type: 'PostToolUse',
      tool_name: 'WebFetch',
      payload: expect.objectContaining({
        tool_response: expect.stringMatching(/^x{2000}$/),
      }),
    });
  });

  it('ignores tool_result without matching tool_use', () => {
    const logger = new StreamToolLogger('test-group');
    const insertMock = vi.mocked(toolEvents.insertToolCallEvent);

    logger.processLine(
      '{"type":"system","subtype":"init","session_id":"sess-123"}',
    );
    logger.processLine(
      '{"type":"tool_result","tool_use_id":"nonexistent","content":"foo"}',
    );

    expect(insertMock).not.toHaveBeenCalled();
  });

  it('ignores tool_result without session_id', () => {
    const logger = new StreamToolLogger('test-group');
    const insertMock = vi.mocked(toolEvents.insertToolCallEvent);

    logger.processLine(
      '{"type":"tool_use","id":"tool-4","name":"Bash","input":{}}',
    );
    logger.processLine(
      '{"type":"tool_result","tool_use_id":"tool-4","content":"output"}',
    );

    expect(insertMock).not.toHaveBeenCalled();
  });

  it('handles invalid JSON gracefully', () => {
    const logger = new StreamToolLogger('test-group');

    expect(() => {
      logger.processLine('not json at all');
      logger.processLine('{"type":"system","broken');
    }).not.toThrow();
  });

  it('handles empty and whitespace lines', () => {
    const logger = new StreamToolLogger('test-group');

    expect(() => {
      logger.processLine('');
      logger.processLine('   ');
      logger.processLine('\n');
    }).not.toThrow();
  });

  it('processes multiple tool use/result pairs', () => {
    const logger = new StreamToolLogger('test-group');
    const insertMock = vi.mocked(toolEvents.insertToolCallEvent);

    logger.processLine(
      '{"type":"system","subtype":"init","session_id":"sess-123"}',
    );

    // First tool
    logger.processLine(
      '{"type":"tool_use","id":"tool-1","name":"Read","input":{}}',
    );
    logger.processLine(
      '{"type":"tool_result","tool_use_id":"tool-1","content":"data1"}',
    );

    // Second tool
    logger.processLine(
      '{"type":"tool_use","id":"tool-2","name":"Write","input":{}}',
    );
    logger.processLine(
      '{"type":"tool_result","tool_use_id":"tool-2","content":"data2"}',
    );

    expect(insertMock).toHaveBeenCalledTimes(2);
    expect(insertMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ tool_name: 'Read' }),
    );
    expect(insertMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tool_name: 'Write' }),
    );
  });
});
