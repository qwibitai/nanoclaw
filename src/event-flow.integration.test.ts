import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger before importing EventBus
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

import { EventBus } from './event-bus.js';
import type { NanoClawEvent } from './events.js';

describe('Event Flow Integration', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('message lifecycle events flow in correct order', () => {
    const events: string[] = [];
    bus.onAny((event: NanoClawEvent) => {
      events.push(event.type);
    });

    // Simulate full message lifecycle
    bus.emit('message.inbound', {
      type: 'message.inbound',
      source: 'channel',
      groupId: 'g1',
      timestamp: 1,
      payload: { chatJid: 'g1', channel: 'telegram', messageCount: 1 },
    });

    bus.emit('task.queued', {
      type: 'task.queued',
      source: 'executor',
      groupId: 'g1',
      timestamp: 2,
      payload: {
        taskId: 't1',
        groupJid: 'g1',
        priority: 'interactive' as const,
        queuePosition: 0,
      },
    });

    bus.emit('task.started', {
      type: 'task.started',
      source: 'executor',
      groupId: 'g1',
      timestamp: 3,
      payload: {
        taskId: 't1',
        groupJid: 'g1',
        containerName: 'c1',
        slotIndex: 0,
      },
    });

    bus.emit('task.progress', {
      type: 'task.progress',
      source: 'executor',
      groupId: 'g1',
      timestamp: 4,
      payload: { taskId: 't1', groupJid: 'g1', label: 'Reading Gmail' },
    });

    bus.emit('message.outbound', {
      type: 'message.outbound',
      source: 'router',
      groupId: 'g1',
      timestamp: 5,
      payload: { chatJid: 'g1', channel: 'telegram', text: 'Response text' },
    });

    bus.emit('task.complete', {
      type: 'task.complete',
      source: 'executor',
      groupId: 'g1',
      timestamp: 6,
      payload: {
        taskId: 't1',
        groupJid: 'g1',
        status: 'success',
        durationMs: 5000,
      },
    });

    expect(events).toEqual([
      'message.inbound',
      'task.queued',
      'task.started',
      'task.progress',
      'message.outbound',
      'task.complete',
    ]);
  });

  it('error in one handler does not prevent other handlers from running', () => {
    const results: string[] = [];

    // First handler throws
    bus.on('message.inbound', () => {
      throw new Error('handler 1 exploded');
    });

    // Second handler should still run
    bus.on('message.inbound', () => {
      results.push('handler 2 ran');
    });

    // Error handler captures the error
    bus.on('system.error', (event) => {
      results.push(`error captured: ${event.payload.error}`);
    });

    bus.emit('message.inbound', {
      type: 'message.inbound',
      source: 'channel',
      timestamp: Date.now(),
      payload: { chatJid: 'g1', channel: 'telegram', messageCount: 1 },
    });

    expect(results).toContain('handler 2 ran');
    expect(results).toContain('error captured: handler 1 exploded');
  });

  it('system.startup event contains correct metadata', () => {
    const handler = vi.fn();
    bus.on('system.startup', handler);

    bus.emit('system.startup', {
      type: 'system.startup',
      source: 'orchestrator',
      timestamp: Date.now(),
      payload: {
        channels: ['telegram', 'signal', 'discord'],
        groupCount: 26,
      },
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system.startup',
        payload: expect.objectContaining({
          channels: ['telegram', 'signal', 'discord'],
          groupCount: 26,
        }),
      }),
    );
  });

  it('multiple subscribers across different event types receive independently', () => {
    const inboundHandler = vi.fn();
    const completeHandler = vi.fn();
    const progressHandler = vi.fn();

    bus.on('message.inbound', inboundHandler);
    bus.on('task.complete', completeHandler);
    bus.on('task.progress', progressHandler);

    bus.emit('task.complete', {
      type: 'task.complete',
      source: 'executor',
      timestamp: Date.now(),
      payload: {
        taskId: 't1',
        groupJid: 'g1',
        status: 'success',
        durationMs: 1000,
      },
    });

    expect(completeHandler).toHaveBeenCalledTimes(1);
    expect(inboundHandler).not.toHaveBeenCalled();
    expect(progressHandler).not.toHaveBeenCalled();
  });
});
