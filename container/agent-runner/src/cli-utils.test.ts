import { describe, it, expect } from 'vitest';
import { EventEmitter, Readable } from 'stream';
import type { ChildProcess } from 'child_process';
import {
  buildCliArgs,
  parseStreamJson,
  mapAllowedTools,
  type StreamJsonMessage,
} from './cli-utils.js';

describe('mapAllowedTools', () => {
  it('replaces SDK-only tools with Agent', () => {
    const tools = mapAllowedTools([
      'Bash', 'Read',
      'Task', 'TaskOutput', 'TaskStop',
      'TeamCreate', 'TeamDelete', 'SendMessage',
    ]);
    expect(tools).toContain('Bash');
    expect(tools).toContain('Read');
    expect(tools).toContain('Agent');
    expect(tools).not.toContain('Task');
    expect(tools).not.toContain('TaskOutput');
    expect(tools).not.toContain('TaskStop');
    expect(tools).not.toContain('TeamCreate');
    expect(tools).not.toContain('TeamDelete');
    expect(tools).not.toContain('SendMessage');
  });

  it('does not add Agent if no SDK-only tools present', () => {
    const tools = mapAllowedTools(['Bash', 'Read', 'Write']);
    expect(tools).toEqual(['Bash', 'Read', 'Write']);
    expect(tools).not.toContain('Agent');
  });

  it('does not duplicate Agent if already present', () => {
    const tools = mapAllowedTools(['Agent', 'Task', 'Bash']);
    expect(tools.filter(t => t === 'Agent')).toHaveLength(1);
  });

  it('preserves non-SDK tools', () => {
    const tools = mapAllowedTools([
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch',
      'Skill', 'NotebookEdit', 'mcp__nanoclaw__*',
    ]);
    expect(tools).toEqual([
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch',
      'Skill', 'NotebookEdit', 'mcp__nanoclaw__*',
    ]);
  });
});

describe('buildCliArgs', () => {
  it('builds basic args for a new session', () => {
    const args = buildCliArgs({
      prompt: 'hello',
      mcpConfigPath: '/tmp/mcp.json',
      allowedTools: ['Bash', 'Read'],
    });
    const pIdx = args.indexOf('-p');
    expect(pIdx).toBeGreaterThan(-1);
    expect(args[pIdx + 1]).toBe('hello');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).toContain('--mcp-config');
    expect(args).toContain('/tmp/mcp.json');
    expect(args).toContain('--allowedTools');
    expect(args).toContain('Bash');
    expect(args).toContain('Read');
  });

  it('maps SDK tools to CLI tools via allowedTools', () => {
    const args = buildCliArgs({
      prompt: 'hello',
      mcpConfigPath: '/tmp/mcp.json',
      allowedTools: ['Bash', 'Task', 'TeamCreate', 'SendMessage'],
    });
    expect(args).toContain('Agent');
    expect(args).not.toContain('Task');
    expect(args).not.toContain('TeamCreate');
    expect(args).not.toContain('SendMessage');
  });

  it('includes --resume when sessionId is provided', () => {
    const args = buildCliArgs({
      prompt: 'hello',
      sessionId: 'session-123',
      mcpConfigPath: '/tmp/mcp.json',
      allowedTools: [],
    });
    const resumeIdx = args.indexOf('--resume');
    expect(resumeIdx).toBeGreaterThan(-1);
    expect(args[resumeIdx + 1]).toBe('session-123');
  });

  it('does not include --resume when sessionId is undefined', () => {
    const args = buildCliArgs({
      prompt: 'hello',
      mcpConfigPath: '/tmp/mcp.json',
      allowedTools: [],
    });
    expect(args).not.toContain('--resume');
  });

  it('includes --append-system-prompt when systemPromptAppend is provided', () => {
    const args = buildCliArgs({
      prompt: 'hello',
      mcpConfigPath: '/tmp/mcp.json',
      systemPromptAppend: 'system instructions',
      allowedTools: [],
    });
    const idx = args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe('system instructions');
  });

  it('does not include --append-system-prompt when not provided', () => {
    const args = buildCliArgs({
      prompt: 'hello',
      mcpConfigPath: '/tmp/mcp.json',
      allowedTools: [],
    });
    expect(args).not.toContain('--append-system-prompt');
  });

  it('includes --add-dir for each additional directory', () => {
    const args = buildCliArgs({
      prompt: 'hello',
      mcpConfigPath: '/tmp/mcp.json',
      additionalDirectories: ['/extra/a', '/extra/b'],
      allowedTools: [],
    });
    const firstIdx = args.indexOf('--add-dir');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(args[firstIdx + 1]).toBe('/extra/a');
    const secondIdx = args.indexOf('--add-dir', firstIdx + 1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(args[secondIdx + 1]).toBe('/extra/b');
  });

  it('puts prompt as -p flag value', () => {
    const args = buildCliArgs({
      prompt: 'my prompt',
      sessionId: 'sid',
      mcpConfigPath: '/tmp/mcp.json',
      systemPromptAppend: 'sys',
      additionalDirectories: ['/extra/x'],
      allowedTools: ['Bash'],
    });
    const pIdx = args.indexOf('-p');
    expect(pIdx).toBe(0);
    expect(args[pIdx + 1]).toBe('my prompt');
  });
});

describe('parseStreamJson', () => {
  function createMockChild(lines: string[]): ChildProcess {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const child = new EventEmitter() as unknown as ChildProcess;
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = null as unknown as ChildProcess['stdin'];

    // Emit lines asynchronously, then close
    setTimeout(() => {
      for (const line of lines) {
        stdout.push(line + '\n');
      }
      stdout.push(null);
      stderr.push(null);
      (child as EventEmitter).emit('close', 0);
    }, 10);

    return child;
  }

  it('parses system/init message and extracts session_id', async () => {
    const initMsg = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' });
    const child = createMockChild([initMsg]);
    const messages: StreamJsonMessage[] = [];
    await parseStreamJson(child, (msg) => messages.push(msg));
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('system');
    expect(messages[0].subtype).toBe('init');
    expect(messages[0].session_id).toBe('abc-123');
  });

  it('parses result message', async () => {
    const resultMsg = JSON.stringify({ type: 'result', subtype: 'success', result: 'Hello!', session_id: 'abc' });
    const child = createMockChild([resultMsg]);
    const messages: StreamJsonMessage[] = [];
    await parseStreamJson(child, (msg) => messages.push(msg));
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('result');
    expect(messages[0].result).toBe('Hello!');
  });

  it('parses multiple messages in sequence', async () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      JSON.stringify({ type: 'assistant', uuid: 'u1', message: { content: [{ type: 'text', text: 'Hi' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'Done' }),
    ];
    const child = createMockChild(lines);
    const messages: StreamJsonMessage[] = [];
    await parseStreamJson(child, (msg) => messages.push(msg));
    expect(messages).toHaveLength(3);
    expect(messages.map(m => m.type)).toEqual(['system', 'assistant', 'result']);
  });

  it('skips malformed JSON lines', async () => {
    const lines = [
      'not valid json',
      JSON.stringify({ type: 'result', result: 'ok' }),
    ];
    const child = createMockChild(lines);
    const messages: StreamJsonMessage[] = [];
    await parseStreamJson(child, (msg) => messages.push(msg));
    expect(messages).toHaveLength(1);
    expect(messages[0].result).toBe('ok');
  });

  it('handles chunked data across buffer boundaries', async () => {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const child = new EventEmitter() as unknown as ChildProcess;
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = null as unknown as ChildProcess['stdin'];

    const fullLine = JSON.stringify({ type: 'result', result: 'test' });
    // Split in the middle of the JSON
    const part1 = fullLine.slice(0, 10);
    const part2 = fullLine.slice(10) + '\n';

    setTimeout(() => {
      stdout.push(part1);
      stdout.push(part2);
      stdout.push(null);
      stderr.push(null);
      (child as EventEmitter).emit('close', 0);
    }, 10);

    const messages: StreamJsonMessage[] = [];
    await parseStreamJson(child, (msg) => messages.push(msg));
    expect(messages).toHaveLength(1);
    expect(messages[0].result).toBe('test');
  });

  it('returns exit code from child process', async () => {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const child = new EventEmitter() as unknown as ChildProcess;
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = null as unknown as ChildProcess['stdin'];

    setTimeout(() => {
      stdout.push(null);
      stderr.push(null);
      (child as EventEmitter).emit('close', 42);
    }, 10);

    const exitCode = await parseStreamJson(child, () => {});
    expect(exitCode).toBe(42);
  });

  it('rejects on child process error', async () => {
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const child = new EventEmitter() as unknown as ChildProcess;
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = null as unknown as ChildProcess['stdin'];

    setTimeout(() => {
      (child as EventEmitter).emit('error', new Error('spawn failed'));
    }, 10);

    await expect(parseStreamJson(child, () => {})).rejects.toThrow('spawn failed');
  });

  it('skips empty lines', async () => {
    const lines = ['', JSON.stringify({ type: 'result', result: 'ok' }), ''];
    const child = createMockChild(lines);
    const messages: StreamJsonMessage[] = [];
    await parseStreamJson(child, (msg) => messages.push(msg));
    expect(messages).toHaveLength(1);
  });
});
