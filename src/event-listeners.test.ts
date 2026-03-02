import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { EventBus } from './event-bus.js';
import { registerEventListeners, ListenerDeps } from './event-listeners.js';

vi.mock('./config.js', () => ({
  IDLE_TIMEOUT: 5000,
}));

vi.mock('./logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

function createDeps(overrides?: Partial<ListenerDeps>): ListenerDeps {
  return {
    bus: new EventBus(),
    queue: { closeStdin: vi.fn() } as any,
    channels: [],
    findChannel: vi.fn(),
    sessions: {},
    deleteSession: vi.fn(),
    ...overrides,
  };
}

describe('event-listeners', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------
  // 1. Session clearing on agent error
  // -----------------------------------------------------------------

  describe('session clearing on error', () => {
    it('clears session when agent completes with error', () => {
      const sessions: Record<string, string> = { mygroup: 'session-123' };
      const deleteSession = vi.fn();
      const deps = createDeps({ sessions, deleteSession });
      registerEventListeners(deps);

      deps.bus.emit('agent:completed', {
        timestamp: new Date().toISOString(),
        groupFolder: 'mygroup',
        chatJid: 'chat@g.us',
        status: 'error',
        durationMs: 100,
      });

      expect(sessions['mygroup']).toBeUndefined();
      expect(deleteSession).toHaveBeenCalledWith('mygroup');
    });

    it('emits session:cleared after clearing', () => {
      const deps = createDeps({ sessions: { g: 's' } });
      registerEventListeners(deps);
      const handler = vi.fn();
      deps.bus.on('session:cleared', handler);

      deps.bus.emit('agent:completed', {
        timestamp: new Date().toISOString(),
        groupFolder: 'g',
        chatJid: 'c@g.us',
        status: 'error',
        durationMs: 0,
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].reason).toBe('agent-error');
    });

    it('does not clear session on success', () => {
      const sessions: Record<string, string> = { mygroup: 'session-123' };
      const deleteSession = vi.fn();
      const deps = createDeps({ sessions, deleteSession });
      registerEventListeners(deps);

      deps.bus.emit('agent:completed', {
        timestamp: new Date().toISOString(),
        groupFolder: 'mygroup',
        chatJid: 'chat@g.us',
        status: 'success',
        durationMs: 100,
      });

      expect(sessions['mygroup']).toBe('session-123');
      expect(deleteSession).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // 2. Typing indicator
  // -----------------------------------------------------------------

  describe('typing indicator', () => {
    it('sets typing on when agent is invoked', () => {
      const setTyping = vi.fn();
      const channel = { setTyping, ownsJid: () => true } as any;
      const deps = createDeps({
        channels: [channel],
        findChannel: () => channel,
      });
      registerEventListeners(deps);

      deps.bus.emit('agent:invoked', {
        timestamp: new Date().toISOString(),
        groupFolder: 'test',
        chatJid: 'chat@g.us',
        messageCount: 1,
        hasSession: false,
      });

      expect(setTyping).toHaveBeenCalledWith('chat@g.us', true);
    });

    it('sets typing off when agent completes', () => {
      const setTyping = vi.fn();
      const channel = { setTyping, ownsJid: () => true } as any;
      const deps = createDeps({
        channels: [channel],
        findChannel: () => channel,
      });
      registerEventListeners(deps);

      deps.bus.emit('agent:completed', {
        timestamp: new Date().toISOString(),
        groupFolder: 'test',
        chatJid: 'chat@g.us',
        status: 'success',
        durationMs: 100,
      });

      expect(setTyping).toHaveBeenCalledWith('chat@g.us', false);
    });

    it('handles missing channel gracefully', () => {
      const deps = createDeps({ findChannel: () => undefined });
      registerEventListeners(deps);

      // Should not throw
      expect(() =>
        deps.bus.emit('agent:invoked', {
          timestamp: new Date().toISOString(),
          groupFolder: 'test',
          chatJid: 'unknown@g.us',
          messageCount: 1,
          hasSession: false,
        }),
      ).not.toThrow();
    });
  });

  // -----------------------------------------------------------------
  // 3. Idle timeout
  // -----------------------------------------------------------------

  describe('idle timeout', () => {
    it('closes stdin after idle timeout when output received', () => {
      const closeStdin = vi.fn();
      const deps = createDeps({ queue: { closeStdin } as any });
      registerEventListeners(deps);

      deps.bus.emit('container:output', {
        timestamp: new Date().toISOString(),
        groupFolder: 'test',
        chatJid: 'chat@g.us',
        result: 'some output',
        status: 'success',
      });

      expect(closeStdin).not.toHaveBeenCalled();

      // Advance past IDLE_TIMEOUT (5000ms in mock)
      vi.advanceTimersByTime(5001);

      expect(closeStdin).toHaveBeenCalledWith('chat@g.us');
    });

    it('resets timer on subsequent output', () => {
      const closeStdin = vi.fn();
      const deps = createDeps({ queue: { closeStdin } as any });
      registerEventListeners(deps);

      deps.bus.emit('container:output', {
        timestamp: new Date().toISOString(),
        groupFolder: 'test',
        chatJid: 'chat@g.us',
        result: 'first output',
        status: 'success',
      });

      // Advance partway
      vi.advanceTimersByTime(3000);
      expect(closeStdin).not.toHaveBeenCalled();

      // Second output resets the timer
      deps.bus.emit('container:output', {
        timestamp: new Date().toISOString(),
        groupFolder: 'test',
        chatJid: 'chat@g.us',
        result: 'second output',
        status: 'success',
      });

      // Advance past what would have been the original timeout
      vi.advanceTimersByTime(3000);
      expect(closeStdin).not.toHaveBeenCalled();

      // Advance past the reset timeout
      vi.advanceTimersByTime(2001);
      expect(closeStdin).toHaveBeenCalledOnce();
    });

    it('clears timer when agent completes', () => {
      const closeStdin = vi.fn();
      const deps = createDeps({ queue: { closeStdin } as any });
      registerEventListeners(deps);

      deps.bus.emit('container:output', {
        timestamp: new Date().toISOString(),
        groupFolder: 'test',
        chatJid: 'chat@g.us',
        result: 'output',
        status: 'success',
      });

      // Agent completes — timer should be cleared
      deps.bus.emit('agent:completed', {
        timestamp: new Date().toISOString(),
        groupFolder: 'test',
        chatJid: 'chat@g.us',
        status: 'success',
        durationMs: 100,
      });

      // Advance past timeout — closeStdin should NOT fire
      vi.advanceTimersByTime(6000);
      expect(closeStdin).not.toHaveBeenCalled();
    });

    it('ignores null results (session-update markers)', () => {
      const closeStdin = vi.fn();
      const deps = createDeps({ queue: { closeStdin } as any });
      registerEventListeners(deps);

      deps.bus.emit('container:output', {
        timestamp: new Date().toISOString(),
        groupFolder: 'test',
        chatJid: 'chat@g.us',
        result: null,
        status: 'success',
      });

      vi.advanceTimersByTime(6000);
      expect(closeStdin).not.toHaveBeenCalled();
    });
  });
});
