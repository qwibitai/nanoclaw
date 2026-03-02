import { describe, it, expect, beforeEach, vi } from 'vitest';

import { EventBus } from './event-bus.js';

// Suppress logger output during tests
vi.mock('./logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('delivers typed events to listeners', () => {
    const handler = vi.fn();
    bus.on('agent:completed', handler);

    const payload = {
      timestamp: new Date().toISOString(),
      groupFolder: 'main',
      chatJid: 'test@g.us',
      status: 'success' as const,
      durationMs: 1234,
    };
    bus.emit('agent:completed', payload);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('supports multiple listeners on the same event', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.on('container:spawned', handler1);
    bus.on('container:spawned', handler2);

    const payload = {
      timestamp: new Date().toISOString(),
      groupFolder: 'test',
      containerName: 'nanoclaw-test-123',
      isMain: false,
      isScheduledTask: false,
    };
    bus.emit('container:spawned', payload);

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
  });

  it('once() listener fires exactly once', () => {
    const handler = vi.fn();
    bus.once('system:shutdown', handler);

    const payload = {
      timestamp: new Date().toISOString(),
      signal: 'SIGTERM',
      activeContainers: 0,
    };
    bus.emit('system:shutdown', payload);
    bus.emit('system:shutdown', payload);

    expect(handler).toHaveBeenCalledOnce();
  });

  it('isolates listener errors — emit never throws', () => {
    const badHandler = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const goodHandler = vi.fn();

    bus.on('agent:completed', badHandler);
    bus.on('agent:completed', goodHandler);

    const payload = {
      timestamp: new Date().toISOString(),
      groupFolder: 'main',
      chatJid: 'test@g.us',
      status: 'error' as const,
      durationMs: 500,
    };

    // Should not throw
    expect(() => bus.emit('agent:completed', payload)).not.toThrow();

    // Bad handler was called (and threw internally)
    expect(badHandler).toHaveBeenCalledOnce();
    // Good handler still ran
    expect(goodHandler).toHaveBeenCalledOnce();
  });

  it('removeAllListeners clears specific event', () => {
    const handler = vi.fn();
    bus.on('container:spawned', handler);
    bus.on('agent:completed', handler);

    bus.removeAllListeners('container:spawned');

    bus.emit('container:spawned', {
      timestamp: new Date().toISOString(),
      groupFolder: 'test',
      containerName: 'test',
      isMain: false,
      isScheduledTask: false,
    });
    bus.emit('agent:completed', {
      timestamp: new Date().toISOString(),
      groupFolder: 'main',
      chatJid: 'test@g.us',
      status: 'success' as const,
      durationMs: 100,
    });

    // container:spawned listener was removed, agent:completed was not
    expect(handler).toHaveBeenCalledOnce();
  });

  it('removeAllListeners(event) does not break off() for other events', () => {
    const spawned = vi.fn();
    const completed = vi.fn();
    bus.on('container:spawned', spawned);
    bus.on('agent:completed', completed);

    // Remove only container:spawned listeners
    bus.removeAllListeners('container:spawned');

    // off() for agent:completed should still work
    bus.off('agent:completed', completed);
    expect(bus.listenerCount('agent:completed')).toBe(0);

    bus.emit('agent:completed', {
      timestamp: new Date().toISOString(),
      groupFolder: 'main',
      chatJid: 'test@g.us',
      status: 'success' as const,
      durationMs: 100,
    });

    expect(completed).not.toHaveBeenCalled();
  });

  it('removeAllListeners with no args clears everything', () => {
    const handler = vi.fn();
    bus.on('container:spawned', handler);
    bus.on('agent:completed', handler);

    bus.removeAllListeners();

    bus.emit('container:spawned', {
      timestamp: new Date().toISOString(),
      groupFolder: 'test',
      containerName: 'test',
      isMain: false,
      isScheduledTask: false,
    });
    bus.emit('agent:completed', {
      timestamp: new Date().toISOString(),
      groupFolder: 'main',
      chatJid: 'test@g.us',
      status: 'success' as const,
      durationMs: 100,
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('listenerCount reflects registered listeners', () => {
    expect(bus.listenerCount('agent:invoked')).toBe(0);

    const h1 = vi.fn();
    const h2 = vi.fn();
    bus.on('agent:invoked', h1);
    bus.on('agent:invoked', h2);

    expect(bus.listenerCount('agent:invoked')).toBe(2);

    bus.removeAllListeners('agent:invoked');
    expect(bus.listenerCount('agent:invoked')).toBe(0);
  });

  it('off() removes the correct listener', () => {
    const handler = vi.fn();
    bus.on('session:cleared', handler);

    bus.emit('session:cleared', {
      timestamp: new Date().toISOString(),
      groupFolder: 'test',
      reason: 'test',
    });
    expect(handler).toHaveBeenCalledOnce();

    // Remove and verify it no longer fires
    bus.off('session:cleared', handler);
    bus.emit('session:cleared', {
      timestamp: new Date().toISOString(),
      groupFolder: 'test',
      reason: 'test',
    });
    expect(handler).toHaveBeenCalledOnce(); // still 1, not 2
    expect(bus.listenerCount('session:cleared')).toBe(0);
  });

  it('emitting with no listeners is a no-op', () => {
    // Should not throw
    expect(() =>
      bus.emit('session:cleared', {
        timestamp: new Date().toISOString(),
        groupFolder: 'test',
        reason: 'test',
      }),
    ).not.toThrow();
  });
});
