import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StatusBarManager } from '../status-bar.js';
import { EventBus } from '../event-bus.js';
import type { TaskStartedEvent, TaskCompleteEvent } from '../events.js';

describe('StatusBarManager', () => {
  let bus: EventBus;
  let manager: StatusBarManager;
  let lastUpdate: string | null;
  let mockProgressHandle: {
    update: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new EventBus();
    lastUpdate = null;
    mockProgressHandle = {
      update: vi.fn(async (text: string) => {
        lastUpdate = text;
      }),
      clear: vi.fn(),
    };
    manager = new StatusBarManager(bus, {
      sendProgress: vi.fn(async (text: string) => {
        lastUpdate = text;
        return mockProgressHandle;
      }),
      sendMessage: vi.fn(async (text: string) => {
        lastUpdate = text;
      }),
    });
  });

  afterEach(() => {
    manager.destroy();
    bus.removeAllListeners();
    vi.useRealTimers();
  });

  it('updates when a task starts', async () => {
    bus.emit('task.started', {
      type: 'task.started',
      source: 'executor',
      timestamp: Date.now(),
      payload: {
        taskId: 't1',
        groupJid: 'tg:123',
        containerName: 'c1',
        slotIndex: 0,
      },
    } as TaskStartedEvent);

    await vi.advanceTimersByTimeAsync(2000);
    expect(lastUpdate).not.toBeNull();
    expect(lastUpdate).toContain('ACTIVE');
  });

  it('removes task on completion', async () => {
    bus.emit('task.started', {
      type: 'task.started',
      source: 'executor',
      timestamp: Date.now(),
      payload: {
        taskId: 't1',
        groupJid: 'tg:123',
        containerName: 'c1',
        slotIndex: 0,
      },
    } as TaskStartedEvent);

    bus.emit('task.complete', {
      type: 'task.complete',
      source: 'executor',
      timestamp: Date.now(),
      payload: {
        taskId: 't1',
        groupJid: 'tg:123',
        status: 'success',
        durationMs: 5000,
      },
    } as TaskCompleteEvent);

    await vi.advanceTimersByTimeAsync(2000);
    expect(lastUpdate).not.toContain('t1');
  });

  it('tracks daily auto-handled count', async () => {
    manager.incrementAutoHandled();
    manager.incrementAutoHandled();
    manager.incrementAutoHandled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(lastUpdate).toContain('3');
  });

  it('uses edit-in-place after first render', async () => {
    manager.incrementAutoHandled();
    await vi.advanceTimersByTimeAsync(2000);
    // First render creates progress handle

    manager.incrementAutoHandled();
    await vi.advanceTimersByTimeAsync(2000);
    // Second render should use handle.update
    expect(mockProgressHandle.update).toHaveBeenCalled();
  });

  it('debounces rapid updates', async () => {
    const sendProgress = vi.fn(async (text: string) => {
      lastUpdate = text;
      return mockProgressHandle;
    });
    manager.destroy();
    manager = new StatusBarManager(bus, {
      sendProgress,
      sendMessage: vi.fn(),
    });

    for (let i = 0; i < 10; i++) {
      manager.incrementAutoHandled();
    }

    await vi.advanceTimersByTimeAsync(2000);
    expect(sendProgress).toHaveBeenCalledTimes(1);
  });
});
