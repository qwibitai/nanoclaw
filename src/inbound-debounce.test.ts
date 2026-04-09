// src/inbound-debounce.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InboundDebouncer } from './inbound-debounce.js';

describe('InboundDebouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not dispatch immediately when debounce > 0', () => {
    const dispatched: string[] = [];
    const db = new InboundDebouncer(500, (jid) => dispatched.push(jid));

    db.push('group-a');
    expect(dispatched).toEqual([]);
  });

  it('dispatches after debounce window expires', () => {
    const dispatched: string[] = [];
    const db = new InboundDebouncer(500, (jid) => dispatched.push(jid));

    db.push('group-a');
    vi.advanceTimersByTime(500);
    expect(dispatched).toEqual(['group-a']);
  });

  it('resets timer on second push within window', () => {
    const dispatched: string[] = [];
    const db = new InboundDebouncer(500, (jid) => dispatched.push(jid));

    db.push('group-a');
    vi.advanceTimersByTime(300);
    db.push('group-a'); // resets the 500ms window
    vi.advanceTimersByTime(300);
    expect(dispatched).toEqual([]); // still waiting
    vi.advanceTimersByTime(200);
    expect(dispatched).toEqual(['group-a']);
  });

  it('dispatches each group independently', () => {
    const dispatched: string[] = [];
    const db = new InboundDebouncer(500, (jid) => dispatched.push(jid));

    db.push('group-a');
    db.push('group-b');
    vi.advanceTimersByTime(500);
    expect(dispatched.sort()).toEqual(['group-a', 'group-b']);
  });

  it('dispatches immediately when debounceMs is 0', () => {
    const dispatched: string[] = [];
    const db = new InboundDebouncer(0, (jid) => dispatched.push(jid));

    db.push('group-a');
    expect(dispatched).toEqual(['group-a']);
  });

  it('cancels pending timer on cancel()', () => {
    const dispatched: string[] = [];
    const db = new InboundDebouncer(500, (jid) => dispatched.push(jid));

    db.push('group-a');
    db.cancel('group-a');
    vi.advanceTimersByTime(500);
    expect(dispatched).toEqual([]);
  });

  it('dispatches only once even if pushed multiple times', () => {
    const dispatched: string[] = [];
    const db = new InboundDebouncer(500, (jid) => dispatched.push(jid));

    db.push('group-a');
    db.push('group-a');
    db.push('group-a');
    vi.advanceTimersByTime(500);
    expect(dispatched).toEqual(['group-a']);
  });
});
