import { afterEach, describe, expect, it, vi } from 'vitest';

describe('agent-runner transport handling', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('surfaces SDK error results instead of swallowing them as success', async () => {
    vi.stubEnv('NANOCLAW_AGENT_RUNNER_AUTOSTART', '0');

    const mod = await import('./index.js');
    const outputs: Array<{
      status: 'success' | 'error';
      result: string | null;
      newSessionId?: string;
      error?: string;
    }> = [];

    async function* fakeQuery() {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'session-1',
      };
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['internal stream ended unexpectedly'],
      };
    }

    const result = await mod.runQuery(
      'hello',
      undefined,
      '/tmp/mcp.js',
      {
        prompt: 'hello',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      },
      {},
      undefined,
      {
        queryImpl: fakeQuery as any,
        emitOutput: (output) => outputs.push(output),
      },
    );

    expect(outputs).toEqual([
      expect.objectContaining({
        status: 'error',
        result: null,
        newSessionId: 'session-1',
        error: 'internal stream ended unexpectedly',
      }),
    ]);
    expect(result.encounteredError).toBe(true);
  });

  it('keeps normal successful SDK results as success outputs', async () => {
    vi.stubEnv('NANOCLAW_AGENT_RUNNER_AUTOSTART', '0');

    const mod = await import('./index.js');
    const outputs: Array<{
      status: 'success' | 'error';
      result: string | null;
      newSessionId?: string;
      error?: string;
    }> = [];

    async function* fakeQuery() {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'session-2',
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: 'done',
      };
    }

    const result = await mod.runQuery(
      'hello',
      undefined,
      '/tmp/mcp.js',
      {
        prompt: 'hello',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      },
      {},
      undefined,
      {
        queryImpl: fakeQuery as any,
        emitOutput: (output) => outputs.push(output),
      },
    );

    expect(outputs).toEqual([
      expect.objectContaining({
        status: 'success',
        result: 'done',
        newSessionId: 'session-2',
      }),
    ]);
    expect(result.encounteredError).toBe(false);
  });

  it('emits an explicit error after a transport throw following a success result', async () => {
    vi.stubEnv('NANOCLAW_AGENT_RUNNER_AUTOSTART', '0');

    const mod = await import('./index.js');
    const outputs: Array<{
      status: 'success' | 'error';
      result: string | null;
      newSessionId?: string;
      error?: string;
    }> = [];

    async function* fakeQuery() {
      yield {
        type: 'system',
        subtype: 'init',
        session_id: 'session-3',
      };
      yield {
        type: 'result',
        subtype: 'success',
        result: 'partial answer',
      };
      throw new Error('internal stream ended unexpectedly');
    }

    const result = await mod.runQuery(
      'hello',
      undefined,
      '/tmp/mcp.js',
      {
        prompt: 'hello',
        groupFolder: 'test-group',
        chatJid: 'test@g.us',
        isMain: false,
      },
      {},
      undefined,
      {
        queryImpl: fakeQuery as any,
        emitOutput: (output) => outputs.push(output),
      },
    );

    expect(outputs).toEqual([
      expect.objectContaining({
        status: 'success',
        result: 'partial answer',
        newSessionId: 'session-3',
      }),
      expect.objectContaining({
        status: 'error',
        result: null,
        newSessionId: 'session-3',
        error: 'internal stream ended unexpectedly',
      }),
    ]);
    expect(result.encounteredError).toBe(true);
  });
});
