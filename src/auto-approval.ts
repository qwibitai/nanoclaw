import type { EventBus } from './event-bus.js';
import type { PlanAutoApprovedEvent, PlanCancelledEvent } from './events.js';

interface TimerEntry {
  taskId: string;
  handle: ReturnType<typeof setTimeout>;
  expiresAt: number;
}

export class AutoApprovalTimer {
  private timers = new Map<string, TimerEntry>();
  private bus: EventBus;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  start(taskId: string, durationMs: number): void {
    // Cancel existing timer for this task if any — but don't emit cancelled for replacement
    const existing = this.timers.get(taskId);
    if (existing) {
      clearTimeout(existing.handle);
      this.timers.delete(taskId);
    }

    const expiresAt = Date.now() + durationMs;
    const handle = setTimeout(() => {
      this.timers.delete(taskId);
      this.bus.emit('plan.auto_approved', {
        type: 'plan.auto_approved',
        source: 'auto-approval',
        timestamp: Date.now(),
        payload: { taskId },
      } as PlanAutoApprovedEvent);
    }, durationMs);

    this.timers.set(taskId, { taskId, handle, expiresAt });
  }

  cancel(taskId: string): void {
    const entry = this.timers.get(taskId);
    if (entry) {
      clearTimeout(entry.handle);
      this.timers.delete(taskId);
      this.bus.emit('plan.cancelled', {
        type: 'plan.cancelled',
        source: 'auto-approval',
        timestamp: Date.now(),
        payload: { taskId },
      } as PlanCancelledEvent);
    }
  }

  getRemainingMs(taskId: string): number | null {
    const entry = this.timers.get(taskId);
    if (!entry) return null;
    return Math.max(0, entry.expiresAt - Date.now());
  }

  destroy(): void {
    for (const entry of this.timers.values()) {
      clearTimeout(entry.handle);
    }
    this.timers.clear();
  }
}
