import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createHandlers, sessionRunIds } from './handlers.js';
import type { AgentRunner, AgentSession } from './agent-runner.js';

function createMockRunner(
  overrides: Partial<AgentRunner> = {},
): AgentRunner & EventEmitter {
  const emitter = new EventEmitter();
  const sessions = new Map<string, AgentSession>();
  const mock = Object.assign(emitter, {
    spawn: vi.fn(async (opts: { sessionKey: string }) => {
      const session: AgentSession = {
        sessionKey: opts.sessionKey,
        startedAt: new Date(),
      };
      sessions.set(opts.sessionKey, session);
      return session;
    }),
    sendMessage: vi.fn(async () => {}),
    kill: vi.fn(async (key: string) => {
      sessions.delete(key);
    }),
    killAll: vi.fn(async () => {
      sessions.clear();
    }),
    getSession: (key: string) => sessions.get(key),
    on: emitter.on.bind(emitter),
    ...overrides,
  });
  Object.defineProperty(mock, 'activeCount', {
    get: () => sessions.size,
    enumerable: true,
  });
  return mock as unknown as AgentRunner & EventEmitter;
}

describe('createHandlers', () => {
  let runner: ReturnType<typeof createMockRunner>;
  let handlers: Record<string, (params: any) => Promise<any>>;
  let pushEvent: ReturnType<
    typeof vi.fn<(event: string, payload: Record<string, unknown>) => void>
  >;

  beforeEach(() => {
    sessionRunIds.clear();
    runner = createMockRunner();
    pushEvent =
      vi.fn<(event: string, payload: Record<string, unknown>) => void>();
    handlers = createHandlers(runner, pushEvent);
  });

  describe('health', () => {
    it('returns status ok with uptime and activeAgents', async () => {
      const result = await handlers.health({});
      expect(result.status).toBe('ok');
      expect(typeof result.uptime).toBe('number');
      expect(result.activeAgents).toBe(0);
    });

    it('reflects activeCount from runner', async () => {
      await handlers['chat.send']({
        sessionKey: 'sess-1',
        message: 'hello',
      });
      const result = await handlers.health({});
      expect(result.activeAgents).toBe(1);
    });
  });

  describe('chat.send', () => {
    it('spawns a new agent and returns runId', async () => {
      const result = await handlers['chat.send']({
        sessionKey: 'sess-1',
        message: 'hello',
      });
      expect(result.runId).toBeDefined();
      expect(result.sessionKey).toBe('sess-1');
      expect(runner.spawn).toHaveBeenCalledOnce();
      expect(sessionRunIds.get('sess-1')).toBe(result.runId);
    });

    it('kills existing session before spawning', async () => {
      // Spawn a first session
      await handlers['chat.send']({
        sessionKey: 'sess-1',
        message: 'first',
      });
      // Spawn again with same key
      await handlers['chat.send']({
        sessionKey: 'sess-1',
        message: 'second',
      });
      expect(runner.kill).toHaveBeenCalledWith('sess-1');
    });

    it('pushes chat.error event on spawn failure', async () => {
      const failRunner = createMockRunner({
        spawn: vi.fn(async () => {
          throw new Error('no API key');
        }),
      });
      const failHandlers = createHandlers(failRunner, pushEvent);
      const result = await failHandlers['chat.send']({
        sessionKey: 'sess-1',
        message: 'hello',
      });
      expect(result.runId).toBeDefined();
      expect(pushEvent).toHaveBeenCalledWith('chat.error', {
        sessionKey: 'sess-1',
        runId: result.runId,
        error: 'no API key',
      });
    });

    it('does not throw when pushEvent is not provided', async () => {
      const failRunner = createMockRunner({
        spawn: vi.fn(async () => {
          throw new Error('fail');
        }),
      });
      const noPushHandlers = createHandlers(failRunner);
      const result = await noPushHandlers['chat.send']({
        sessionKey: 'sess-1',
        message: 'hello',
      });
      expect(result.runId).toBeDefined();
    });

    it('passes resumeSessionId to spawn', async () => {
      await handlers['chat.send']({
        sessionKey: 'sess-1',
        message: 'hello',
        resumeSessionId: 'prev-session',
      });
      expect(runner.spawn).toHaveBeenCalledWith(
        expect.objectContaining({ resumeSessionId: 'prev-session' }),
      );
    });
  });

  describe('chat.abort', () => {
    it('kills the session and cleans up runId', async () => {
      await handlers['chat.send']({
        sessionKey: 'sess-1',
        message: 'hello',
      });
      expect(sessionRunIds.has('sess-1')).toBe(true);

      const result = await handlers['chat.abort']({ sessionKey: 'sess-1' });
      expect(result.aborted).toBe(true);
      expect(sessionRunIds.has('sess-1')).toBe(false);
      expect(runner.kill).toHaveBeenCalledWith('sess-1');
    });
  });

  describe('sessions.list', () => {
    it('returns empty array', async () => {
      const result = await handlers['sessions.list']({});
      expect(result).toEqual([]);
    });
  });

  describe('chat.history', () => {
    it('returns empty array', async () => {
      const result = await handlers['chat.history']({
        sessionKey: 'sess-1',
      });
      expect(result).toEqual([]);
    });
  });
});
