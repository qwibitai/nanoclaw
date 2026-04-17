import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createIdleTimer } from './timeout-manager.js';

describe('createIdleTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires after the configured timeout when not reset', () => {
    const onFire = vi.fn();
    createIdleTimer(1000, onFire);
    vi.advanceTimersByTime(999);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('reset() postpones the fire', () => {
    const onFire = vi.fn();
    const t = createIdleTimer(1000, onFire);
    vi.advanceTimersByTime(800);
    t.reset();
    vi.advanceTimersByTime(800);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it('clear() cancels the timer permanently', () => {
    const onFire = vi.fn();
    const t = createIdleTimer(1000, onFire);
    t.clear();
    vi.advanceTimersByTime(10_000);
    expect(onFire).not.toHaveBeenCalled();
  });
});
