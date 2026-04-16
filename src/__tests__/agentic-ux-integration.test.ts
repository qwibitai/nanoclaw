import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../event-bus.js';
import { classifyAndFormat } from '../router.js';
import { MessageBatcher } from '../message-batcher.js';
import { StatusBarManager } from '../status-bar.js';
import { AutoApprovalTimer } from '../auto-approval.js';
import { FailureEscalator } from '../failure-escalator.js';

describe('Agentic UX Integration', () => {
  let bus: EventBus;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new EventBus();
  });

  afterEach(() => {
    bus.removeAllListeners();
    vi.useRealTimers();
  });

  it('full pipeline: financial message → classify → format → buttons', () => {
    const result = classifyAndFormat(
      'Chase — 2 incoming wires to account ····7958. Total: $54,900. Were both expected?',
    );

    expect(result.meta.category).toBe('financial');
    expect(result.meta.urgency).toBe('action-required');
    expect(result.meta.questionType).toBe('financial-confirm');
    expect(result.text).toContain('💰');
    expect(result.meta.actions).toHaveLength(3);
    expect(result.meta.actions[0].label).toBe('Yes, all expected');
  });

  it('batcher collects auto-handled items and flushes', () => {
    const flushed: string[][] = [];
    const batcher = new MessageBatcher({
      maxItems: 3,
      maxWaitMs: 10_000,
      onFlush: (items) => flushed.push([...items]),
    });

    const items = [
      'Newsletter dismissed — AUTO, no action.',
      'Receipt — $25. AUTO, no action.',
      'Promo email — AUTO, no action.',
    ];

    for (const item of items) {
      const result = classifyAndFormat(item);
      if (result.meta.batchable) {
        batcher.add(item);
      }
    }

    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(3);
    batcher.destroy();
  });

  it('status bar + failure escalator work together', async () => {
    let statusText = '';
    let escalation: string | null = null;

    const statusBar = new StatusBarManager(bus, {
      sendProgress: vi.fn(async (text: string) => {
        statusText = text;
        return {
          update: async (t: string) => {
            statusText = t;
          },
          clear: async () => {},
        };
      }),
      sendMessage: vi.fn(async (text: string) => {
        statusText = text;
      }),
    });

    const _escalator = new FailureEscalator(bus, {
      onEscalate: (text) => {
        escalation = text;
      },
    });

    // Task starts
    bus.emit('task.started', {
      type: 'task.started',
      source: 'executor',
      timestamp: Date.now(),
      payload: {
        taskId: 't1',
        groupJid: 'tg:123',
        containerName: 'Spamhaus investigation',
        slotIndex: 0,
      },
    });

    await vi.advanceTimersByTimeAsync(2000);
    expect(statusText).toContain('ACTIVE');
    expect(statusText).toContain('Spamhaus investigation');

    // Task fails
    bus.emit('task.complete', {
      type: 'task.complete',
      source: 'executor',
      timestamp: Date.now(),
      payload: {
        taskId: 't1',
        groupJid: 'tg:123',
        status: 'error',
        durationMs: 5000,
      },
    });

    await vi.advanceTimersByTimeAsync(2000);
    expect(escalation).toContain('🚨');
    expect(escalation).toContain('failed');

    statusBar.destroy();
  });

  it('auto-approval timer fires and emits event', () => {
    const handler = vi.fn();
    bus.on('plan.auto_approved', handler);

    const timer = new AutoApprovalTimer(bus);
    timer.start('task-1', 5000);

    vi.advanceTimersByTime(5000);
    expect(handler).toHaveBeenCalledTimes(1);

    timer.destroy();
  });
});
