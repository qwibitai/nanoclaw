import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FailureEscalator } from '../failure-escalator.js';
import { EventBus } from '../event-bus.js';
import type { TaskCompleteEvent } from '../events.js';

describe('FailureEscalator', () => {
  let bus: EventBus;
  let escalator: FailureEscalator;
  let lastEscalation: {
    text: string;
    actions: Array<{ label: string }>;
  } | null;

  beforeEach(() => {
    bus = new EventBus();
    lastEscalation = null;
    escalator = new FailureEscalator(bus, {
      onEscalate: (text, actions) => {
        lastEscalation = { text, actions };
      },
    });
  });

  afterEach(() => {
    escalator.destroy();
    bus.removeAllListeners();
  });

  it('escalates on task error', () => {
    bus.emit('task.complete', {
      type: 'task.complete',
      source: 'executor',
      timestamp: Date.now(),
      payload: {
        taskId: 't1',
        groupJid: 'tg:123',
        status: 'error',
        durationMs: 3000,
      },
    } as TaskCompleteEvent);

    expect(lastEscalation).not.toBeNull();
    expect(lastEscalation!.text).toContain('🚨');
    expect(lastEscalation!.text).toContain('failed');
    expect(lastEscalation!.actions.length).toBeGreaterThan(0);
  });

  it('does not escalate on success', () => {
    bus.emit('task.complete', {
      type: 'task.complete',
      source: 'executor',
      timestamp: Date.now(),
      payload: {
        taskId: 't1',
        groupJid: 'tg:123',
        status: 'success',
        durationMs: 3000,
      },
    } as TaskCompleteEvent);

    expect(lastEscalation).toBeNull();
  });
});
