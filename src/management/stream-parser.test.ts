// src/management/stream-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseStreamJsonLine } from './stream-parser.js';

describe('parseStreamJsonLine', () => {
  it('parses assistant text block as chat.delta', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello world' }] },
    });
    const events = parseStreamJsonLine(line, 'session-1', 'run-1');
    expect(events).toEqual([
      { event: 'chat.delta', payload: { sessionKey: 'session-1', runId: 'run-1', content: 'Hello world' } },
    ]);
  });

  it('parses tool_use block as agent.tool', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Read', input: { path: '/foo' } }] },
    });
    const events = parseStreamJsonLine(line, 's1', 'r1');
    expect(events).toEqual([
      { event: 'agent.tool', payload: { sessionKey: 's1', runId: 'r1', tool: 'Read', input: { path: '/foo' }, output: null } },
    ]);
  });

  it('parses result as chat.final with session ID', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'Done!',
      session_id: 'sess-abc',
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const events = parseStreamJsonLine(line, 's1', 'r1');
    expect(events).toEqual([
      {
        event: 'chat.final',
        payload: {
          sessionKey: 's1', runId: 'r1', content: 'Done!', sessionId: 'sess-abc',
          usage: { inputTokens: 100, outputTokens: 50 },
        },
      },
    ]);
  });

  it('parses result without session ID', () => {
    const line = JSON.stringify({
      type: 'result',
      result: 'Done!',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const events = parseStreamJsonLine(line, 's1', 'r1');
    expect(events[0].payload).not.toHaveProperty('sessionId');
  });

  it('returns empty array for non-JSON input', () => {
    expect(parseStreamJsonLine('not json', 's1', 'r1')).toEqual([]);
  });

  it('returns empty array for system type', () => {
    const line = JSON.stringify({ type: 'system', session_id: 'x' });
    expect(parseStreamJsonLine(line, 's1', 'r1')).toEqual([]);
  });

  it('handles multiple content blocks in one assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'thinking...' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    const events = parseStreamJsonLine(line, 's1', 'r1');
    expect(events).toHaveLength(2);
    expect(events[0].event).toBe('chat.delta');
    expect(events[1].event).toBe('agent.tool');
  });
});
