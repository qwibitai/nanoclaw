import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PendingSendRegistry } from './pending-send.js';

describe('PendingSendRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onFire after delayMs', async () => {
    const reg = new PendingSendRegistry();
    const onFire = vi.fn().mockResolvedValue(undefined);
    const { sendAt } = reg.schedule('draft1', 'personal', 1000, onFire);
    expect(sendAt).toBeGreaterThan(Date.now());
    expect(reg.has('draft1')).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFire).toHaveBeenCalledOnce();
    expect(reg.has('draft1')).toBe(false);
  });

  it('schedule with same draftId replaces prior timer', async () => {
    const reg = new PendingSendRegistry();
    const onFire1 = vi.fn().mockResolvedValue(undefined);
    const onFire2 = vi.fn().mockResolvedValue(undefined);
    reg.schedule('draft1', 'personal', 1000, onFire1);
    reg.schedule('draft1', 'personal', 1000, onFire2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFire1).not.toHaveBeenCalled();
    expect(onFire2).toHaveBeenCalledOnce();
  });

  it('cancel before fire returns true and prevents fire', async () => {
    const reg = new PendingSendRegistry();
    const onFire = vi.fn().mockResolvedValue(undefined);
    reg.schedule('draft1', 'personal', 1000, onFire);
    expect(reg.cancel('draft1')).toBe(true);
    expect(reg.has('draft1')).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFire).not.toHaveBeenCalled();
  });

  it('cancel after fire returns false', async () => {
    const reg = new PendingSendRegistry();
    const onFire = vi.fn().mockResolvedValue(undefined);
    reg.schedule('draft1', 'personal', 1000, onFire);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reg.cancel('draft1')).toBe(false);
  });

  it('cancel of unknown draftId returns false', () => {
    const reg = new PendingSendRegistry();
    expect(reg.cancel('never-scheduled')).toBe(false);
  });

  it('shutdown clears all timers without firing', async () => {
    const reg = new PendingSendRegistry();
    const onFire1 = vi.fn().mockResolvedValue(undefined);
    const onFire2 = vi.fn().mockResolvedValue(undefined);
    reg.schedule('draft1', 'personal', 1000, onFire1);
    reg.schedule('draft2', 'personal', 1000, onFire2);
    reg.shutdown();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFire1).not.toHaveBeenCalled();
    expect(onFire2).not.toHaveBeenCalled();
    expect(reg.has('draft1')).toBe(false);
    expect(reg.has('draft2')).toBe(false);
  });

  it('onFire rejection is caught and does not crash', async () => {
    const reg = new PendingSendRegistry();
    const onFire = vi.fn().mockRejectedValue(new Error('gmail api down'));
    reg.schedule('draft1', 'personal', 1000, onFire);
    await vi.advanceTimersByTimeAsync(1000);
    expect(onFire).toHaveBeenCalledOnce();
    // no uncaught rejection; registry cleaned up
    expect(reg.has('draft1')).toBe(false);
  });
});
