// src/management/stream-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseStreamJsonLine } from './stream-parser.js';

describe('parseStreamJsonLine', () => {
  // ── stream_event: text_delta → chat.delta ──────────────────────────

  it('parses stream_event text_delta as chat.delta', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'Hello world' },
      },
    });
    const events = parseStreamJsonLine(line, 'session-1', 'run-1');
    expect(events).toEqual([
      {
        event: 'chat.delta',
        payload: {
          sessionKey: 'session-1',
          runId: 'run-1',
          content: 'Hello world',
        },
      },
    ]);
  });

  it('emits separate deltas for each stream_event', () => {
    const line1 = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'Hello' },
      },
    });
    const line2 = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: ' world' },
      },
    });
    const ev1 = parseStreamJsonLine(line1, 's1', 'r1');
    const ev2 = parseStreamJsonLine(line2, 's1', 'r1');
    expect(ev1[0].payload.content).toBe('Hello');
    expect(ev2[0].payload.content).toBe(' world');
  });

  it('ignores thinking_delta stream events', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Let me think...' },
      },
    });
    const events = parseStreamJsonLine(line, 's1', 'r1');
    expect(events).toEqual([]);
  });

  it('ignores content_block_start stream events', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      },
    });
    const events = parseStreamJsonLine(line, 's1', 'r1');
    expect(events).toEqual([]);
  });

  it('ignores content_block_stop stream events', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 1 },
    });
    const events = parseStreamJsonLine(line, 's1', 'r1');
    expect(events).toEqual([]);
  });

  it('ignores message_start stream events', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: { type: 'message_start', message: {} },
    });
    const events = parseStreamJsonLine(line, 's1', 'r1');
    expect(events).toEqual([]);
  });

  // ── assistant: only tool_use extracted ─────────────────────────────

  it('extracts tool_use from assistant messages', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Read', input: { path: '/foo' } }],
      },
    });
    const events = parseStreamJsonLine(line, 's1', 'r1');
    expect(events).toEqual([
      {
        event: 'agent.tool',
        payload: {
          sessionKey: 's1',
          runId: 'r1',
          tool: 'Read',
          input: { path: '/foo' },
          output: null,
        },
      },
    ]);
  });

  it('ignores text blocks in assistant messages (deltas come from stream_event)', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'full accumulated text' }],
      },
    });
    const events = parseStreamJsonLine(line, 's1', 'r1');
    expect(events).toEqual([]);
  });

  it('extracts tool_use but ignores text in mixed assistant content', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me search...' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    });
    const events = parseStreamJsonLine(line, 's1', 'r1');
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('agent.tool');
  });

  // ── result → chat.final ────────────────────────────────────────────

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
          sessionKey: 's1',
          runId: 'r1',
          content: 'Done!',
          sessionId: 'sess-abc',
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

  // ── edge cases ─────────────────────────────────────────────────────

  it('returns empty array for non-JSON input', () => {
    expect(parseStreamJsonLine('not json', 's1', 'r1')).toEqual([]);
  });

  it('returns empty array for system type', () => {
    const line = JSON.stringify({ type: 'system', session_id: 'x' });
    expect(parseStreamJsonLine(line, 's1', 'r1')).toEqual([]);
  });

  it('returns empty array for rate_limit_event', () => {
    const line = JSON.stringify({
      type: 'rate_limit_event',
      rate_limit_info: {},
    });
    expect(parseStreamJsonLine(line, 's1', 'r1')).toEqual([]);
  });
});
