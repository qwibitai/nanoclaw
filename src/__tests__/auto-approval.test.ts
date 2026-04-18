import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AutoApprovalTimer } from '../auto-approval.js';
import { EventBus } from '../event-bus.js';

describe('AutoApprovalTimer', () => {
  let bus: EventBus;
  let timer: AutoApprovalTimer;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new EventBus();
    timer = new AutoApprovalTimer(bus);
  });

  afterEach(() => {
    timer.destroy();
    bus.removeAllListeners();
    vi.useRealTimers();
  });

  it('emits plan.auto_approved after timeout', () => {
    const handler = vi.fn();
    bus.on('plan.auto_approved', handler);

    timer.start('task-1', 15 * 60 * 1000);

    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'plan.auto_approved',
        payload: { taskId: 'task-1' },
      }),
    );
  });

  it('emits plan.cancelled when cancelled', () => {
    const approvedHandler = vi.fn();
    const cancelledHandler = vi.fn();
    bus.on('plan.auto_approved', approvedHandler);
    bus.on('plan.cancelled', cancelledHandler);

    timer.start('task-1', 15 * 60 * 1000);
    timer.cancel('task-1');

    vi.advanceTimersByTime(15 * 60 * 1000);
    expect(approvedHandler).not.toHaveBeenCalled();
    expect(cancelledHandler).toHaveBeenCalledTimes(1);
  });

  it('reports remaining time', () => {
    timer.start('task-1', 15 * 60 * 1000);

    vi.advanceTimersByTime(5 * 60 * 1000);
    const remaining = timer.getRemainingMs('task-1');
    expect(remaining).toBeLessThanOrEqual(10 * 60 * 1000);
    expect(remaining).toBeGreaterThan(9 * 60 * 1000);
  });

  it('returns null for unknown task', () => {
    expect(timer.getRemainingMs('nonexistent')).toBeNull();
  });
});
