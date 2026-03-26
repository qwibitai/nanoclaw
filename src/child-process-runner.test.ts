import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';

// Create a controllable fake ChildProcess (same pattern as container-runner.test.ts)
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn — references fakeProc which is reassigned in beforeEach
vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
  };
});

import { ChildProcessRunner } from './child-process-runner.js';
import type { AgentRunner } from './management/agent-runner.js';

const spawnMock = vi.mocked(spawn);

describe('ChildProcessRunner', () => {
  it('should conform to AgentRunner interface', () => {
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    const asRunner: AgentRunner = runner;
    expect(asRunner).toBeDefined();
  });

  beforeEach(() => {
    fakeProc = createFakeProcess();
    // Ensure the pre-flight API key check passes in tests
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  });

  afterEach(async () => {
    vi.clearAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('should spawn a child process for an agent session', async () => {
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    const session = await runner.spawn({
      sessionKey: 'test-session-1',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'You are a helpful assistant.',
    });
    expect(session).toBeDefined();
    expect(session.sessionKey).toBe('test-session-1');
    expect(session.pid).toBeGreaterThan(0);
    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      [
        '-p',
        '--verbose',
        '--model',
        'claude-sonnet-4-20250514',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--dangerously-skip-permissions',
        '--system-prompt',
        'You are a helpful assistant.',
      ],
      expect.objectContaining({
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    await runner.kill(session.sessionKey);
  });

  it('should omit --system-prompt when systemPrompt is empty', async () => {
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    await runner.spawn({
      sessionKey: 'no-prompt',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      [
        '-p',
        '--verbose',
        '--model',
        'claude-sonnet-4-20250514',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--dangerously-skip-permissions',
      ],
      expect.anything(),
    );
    await runner.killAll();
  });

  it('should pass --resume before system-prompt and initialPrompt', async () => {
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    await runner.spawn({
      sessionKey: 'resume-test',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: 'You are helpful.',
      initialPrompt: 'Continue the conversation',
      resumeSessionId: 'sess-abc123',
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      [
        '-p',
        '--verbose',
        '--model',
        'claude-sonnet-4-20250514',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--dangerously-skip-permissions',
        '--resume',
        'sess-abc123',
        '--system-prompt',
        'You are helpful.',
        'Continue the conversation',
      ],
      expect.anything(),
    );
    await runner.killAll();
  });

  it('should pass initialPrompt as positional arg after flags', async () => {
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    await runner.spawn({
      sessionKey: 'with-prompt',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
      initialPrompt: 'Hello, world!',
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'claude',
      [
        '-p',
        '--verbose',
        '--model',
        'claude-sonnet-4-20250514',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--dangerously-skip-permissions',
        'Hello, world!',
      ],
      expect.anything(),
    );
    await runner.killAll();
  });

  it('should enforce max concurrent limit', async () => {
    const runner = new ChildProcessRunner({ maxConcurrent: 1 });
    await runner.spawn({
      sessionKey: 's1',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
    });
    await expect(
      runner.spawn({
        sessionKey: 's2',
        model: 'claude-sonnet-4-20250514',
        systemPrompt: '',
      }),
    ).rejects.toThrow(/max concurrent/i);
    await runner.killAll();
  });

  it('should reject duplicate session keys', async () => {
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    await runner.spawn({
      sessionKey: 'dup',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
    });
    await expect(
      runner.spawn({
        sessionKey: 'dup',
        model: 'claude-sonnet-4-20250514',
        systemPrompt: '',
      }),
    ).rejects.toThrow(/already exists/i);
    await runner.killAll();
  });

  it('should capture stdout from agent process', async () => {
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    const onOutput = vi.fn();
    const session = await runner.spawn({
      sessionKey: 'test-output',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
      onOutput,
    });

    // Push data through the fake stdout
    fakeProc.stdout.push('{"type":"assistant","message":"hello"}\n');

    // Let the event loop process the data event
    await new Promise((r) => setTimeout(r, 10));

    expect(onOutput).toHaveBeenCalledWith(expect.stringContaining('assistant'));
    await runner.kill(session.sessionKey);
  });

  it('should capture stderr via onError callback', async () => {
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    const onError = vi.fn();
    await runner.spawn({
      sessionKey: 'test-stderr',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
      onError,
    });

    fakeProc.stderr.push('Warning: something happened\n');
    await new Promise((r) => setTimeout(r, 10));

    expect(onError).toHaveBeenCalledWith(expect.stringContaining('Warning'));
    await runner.killAll();
  });

  it('should emit events and clean up session on process exit', async () => {
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    const onExit = vi.fn();
    const exitEvent = vi.fn();
    runner.on('exit', exitEvent);

    await runner.spawn({
      sessionKey: 'exit-test',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
      onExit,
    });

    expect(runner.activeCount).toBe(1);

    // Simulate process exit
    fakeProc.emit('exit', 0);
    await new Promise((r) => setTimeout(r, 10));

    expect(onExit).toHaveBeenCalledWith(0);
    expect(exitEvent).toHaveBeenCalledWith('exit-test', 0);
    expect(runner.activeCount).toBe(0);
  });

  it('should send messages to a session via stdin', async () => {
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    const writeSpy = vi.spyOn(fakeProc.stdin, 'write');

    await runner.spawn({
      sessionKey: 'msg-test',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
    });

    await runner.sendMessage('msg-test', 'Hello agent');
    expect(writeSpy).toHaveBeenCalledWith('Hello agent\n');
    await runner.killAll();
  });

  it('should throw when sending to nonexistent session', async () => {
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    await expect(runner.sendMessage('nonexistent', 'hello')).rejects.toThrow(
      /not found/i,
    );
  });

  it('should report activeCount correctly', async () => {
    const runner = new ChildProcessRunner({ maxConcurrent: 3 });
    expect(runner.activeCount).toBe(0);

    await runner.spawn({
      sessionKey: 'a',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
    });
    expect(runner.activeCount).toBe(1);

    // Need a new fake process for the second spawn
    const secondProc = createFakeProcess();
    secondProc.pid = 12346;
    spawnMock.mockReturnValueOnce(secondProc as never);

    await runner.spawn({
      sessionKey: 'b',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
    });
    expect(runner.activeCount).toBe(2);

    await runner.kill('a');
    expect(runner.activeCount).toBe(1);

    await runner.killAll();
    expect(runner.activeCount).toBe(0);
  });

  it('should retrieve session by key via getSession', async () => {
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    await runner.spawn({
      sessionKey: 'lookup',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
    });

    const session = runner.getSession('lookup');
    expect(session).toBeDefined();
    expect(session!.sessionKey).toBe('lookup');
    expect(session!.pid).toBe(12345);
    expect(session!.startedAt).toBeInstanceOf(Date);

    expect(runner.getSession('nonexistent')).toBeUndefined();
    await runner.killAll();
  });

  it('kill should call SIGTERM on the child process', async () => {
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    await runner.spawn({
      sessionKey: 'kill-test',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
    });

    await runner.kill('kill-test');
    expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('kill on nonexistent session should be a no-op', async () => {
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    // Should not throw
    await runner.kill('does-not-exist');
  });

  it('should throw when no Anthropic credentials are configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    await expect(
      runner.spawn({
        sessionKey: 'no-creds',
        model: 'claude-sonnet-4-20250514',
        systemPrompt: '',
      }),
    ).rejects.toThrow(/No Anthropic credentials configured/);
  });

  it('should allow spawn when ANTHROPIC_BASE_URL is set instead of API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_BASE_URL = 'http://bifrost:8080';
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    const session = await runner.spawn({
      sessionKey: 'bifrost-test',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
    });
    expect(session).toBeDefined();
    await runner.killAll();
    delete process.env.ANTHROPIC_BASE_URL;
  });

  it('should allow spawn when CLAUDE_CODE_OAUTH_TOKEN is set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-test-token';
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    const session = await runner.spawn({
      sessionKey: 'oauth-test',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
    });
    expect(session).toBeDefined();
    await runner.killAll();
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  it('should remap setup-token from ANTHROPIC_API_KEY to CLAUDE_CODE_OAUTH_TOKEN', async () => {
    // Simulate user passing a setup-token via ANTHROPIC_API_KEY (wrong var)
    process.env.ANTHROPIC_API_KEY = 'sk-ant-oat01-setup-token-value';
    const runner = new ChildProcessRunner({ maxConcurrent: 2 });
    const session = await runner.spawn({
      sessionKey: 'remap-test',
      model: 'claude-sonnet-4-20250514',
      systemPrompt: '',
    });
    expect(session).toBeDefined();
    // Verify the spawn call got the right env vars
    const spawnCall = spawnMock.mock.calls[spawnMock.mock.calls.length - 1];
    const spawnEnv = spawnCall[2]?.env as Record<string, string | undefined>;
    expect(spawnEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
      'sk-ant-oat01-setup-token-value',
    );
    expect(spawnEnv?.ANTHROPIC_API_KEY).toBeUndefined();
    await runner.killAll();
  });
});
