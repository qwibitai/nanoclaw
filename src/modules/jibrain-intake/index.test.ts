import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock router so importing the module doesn't try to register against the
// real router observer slot.
vi.mock('../../router.js', () => ({
  setInboundObserver: vi.fn(),
}));

vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub child_process.execFile so tests don't actually invoke /bin/bash.
const execFileSpy = vi.fn((_bin: string, _args: string[], _opts: object, cb: (err: Error | null) => void) => {
  // Default: success
  cb(null);
});
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => {
    // Match the (bin, args, opts, cb) signature the module uses.
    return (execFileSpy as unknown as (...a: unknown[]) => void)(...args);
  },
}));

import { jibrainIntakeObserver, _resetBatchesForTests, _batchCountForTests } from './index.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { MessagingGroup } from '../../types.js';

function makeEvent(overrides: Partial<InboundEvent> = {}, contentObj: Record<string, unknown> = {}): InboundEvent {
  const base: InboundEvent = {
    channelType: 'whatsapp',
    platformId: '120363399876069532@g.us',
    threadId: null,
    message: {
      id: 'wa-1',
      kind: 'chat',
      content: JSON.stringify({
        text: 'this is a substantive message that exceeds the threshold',
        sender: '208358225248451@lid',
        senderName: 'Nat',
        fromMe: false,
        isBotMessage: false,
        ...contentObj,
      }),
      timestamp: '2026-05-09T16:00:00Z',
    },
  };
  return { ...base, ...overrides, message: { ...base.message, ...overrides.message } };
}

function makeMg(overrides: Partial<MessagingGroup> = {}): MessagingGroup {
  return {
    id: 'mg-test-1',
    channel_type: 'whatsapp',
    platform_id: '120363399876069532@g.us',
    name: 'vibez',
    is_group: 1,
    unknown_sender_policy: 'strict',
    listening_mode: 'silent',
    confidential_intake: 0,
    capture_mode: 'digest',
    created_at: '2026-05-09T00:00:00Z',
    ...overrides,
  };
}

describe('jibrainIntakeObserver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetBatchesForTests();
    execFileSpy.mockClear();
  });

  afterEach(() => {
    _resetBatchesForTests();
    vi.useRealTimers();
  });

  it('queues a single message and flushes after the quiet window', () => {
    jibrainIntakeObserver(makeEvent(), makeMg());
    expect(_batchCountForTests()).toBe(1);
    expect(execFileSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3 * 60 * 1000 + 100);

    expect(execFileSpy).toHaveBeenCalledTimes(1);
    const args = execFileSpy.mock.calls[0][1] as string[];
    // [hookScript, 'process', ch, sender, merged, slug, capture_mode]
    expect(args[1]).toBe('process');
    // WA channel arg is the platform_id (hook normalizes @g.us → 'wa').
    expect(args[2]).toBe('120363399876069532@g.us');
    expect(args[3]).toBe('208358225248451@lid');
    expect(args[4]).toContain('substantive message');
    expect(args[5]).toBe('vibez');
    expect(args[6]).toBe('digest');
  });

  it('coalesces a burst from the same sender into one hook call', () => {
    jibrainIntakeObserver(makeEvent({}, { text: 'message one is twenty chars long here.' }), makeMg());
    vi.advanceTimersByTime(60 * 1000);
    jibrainIntakeObserver(makeEvent({}, { text: 'message two is also twenty chars or so.' }), makeMg());
    vi.advanceTimersByTime(60 * 1000);
    jibrainIntakeObserver(makeEvent({}, { text: 'message three is also twenty chars or so.' }), makeMg());

    // Quiet window resets on each new message; only one flush after the
    // last one settles for 3 min.
    vi.advanceTimersByTime(3 * 60 * 1000 + 100);
    expect(execFileSpy).toHaveBeenCalledTimes(1);

    const merged = (execFileSpy.mock.calls[0][1] as string[])[4];
    expect(merged).toContain('message one');
    expect(merged).toContain('message two');
    expect(merged).toContain('message three');
    expect(merged.split('---').length).toBe(3); // 2 separators between 3 msgs
  });

  it('skips when confidential_intake = 1', () => {
    jibrainIntakeObserver(makeEvent(), makeMg({ confidential_intake: 1 }));
    expect(_batchCountForTests()).toBe(0);
    vi.advanceTimersByTime(3 * 60 * 1000 + 100);
    expect(execFileSpy).not.toHaveBeenCalled();
  });

  it('skips when fromMe is true', () => {
    jibrainIntakeObserver(makeEvent({}, { fromMe: true }), makeMg());
    expect(_batchCountForTests()).toBe(0);
  });

  it('skips when isBotMessage is true', () => {
    jibrainIntakeObserver(makeEvent({}, { isBotMessage: true }), makeMg());
    expect(_batchCountForTests()).toBe(0);
  });

  it('skips when text is shorter than the noise threshold', () => {
    jibrainIntakeObserver(makeEvent({}, { text: 'short' }), makeMg());
    expect(_batchCountForTests()).toBe(0);
  });

  it('skips chat-sdk events (only chat events are captured)', () => {
    const ev = makeEvent();
    ev.message = { ...ev.message, kind: 'chat-sdk' };
    jibrainIntakeObserver(ev, makeMg());
    expect(_batchCountForTests()).toBe(0);
  });

  it('respects JIBRAIN_DISABLE=1', () => {
    const prev = process.env.JIBRAIN_DISABLE;
    process.env.JIBRAIN_DISABLE = '1';
    try {
      jibrainIntakeObserver(makeEvent(), makeMg());
      expect(_batchCountForTests()).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.JIBRAIN_DISABLE;
      else process.env.JIBRAIN_DISABLE = prev;
    }
  });

  it('uses the short channel prefix for non-WhatsApp adapters', () => {
    jibrainIntakeObserver(
      makeEvent({ channelType: 'signal', platformId: '+1555' }),
      makeMg({ channel_type: 'signal', platform_id: '+1555', capture_mode: 'standalone', name: 'joi-dm' }),
    );
    vi.advanceTimersByTime(3 * 60 * 1000 + 100);
    expect(execFileSpy).toHaveBeenCalledTimes(1);
    const args = execFileSpy.mock.calls[0][1] as string[];
    expect(args[2]).toBe('sig');
    expect(args[5]).toBe('joi-dm');
    expect(args[6]).toBe('standalone');
  });

  it('separates batches by sender even within the same channel', () => {
    jibrainIntakeObserver(
      makeEvent({}, { sender: 'A@lid', text: 'message from sender a, twenty chars or so.' }),
      makeMg(),
    );
    jibrainIntakeObserver(
      makeEvent({}, { sender: 'B@lid', text: 'message from sender b, twenty chars or so.' }),
      makeMg(),
    );
    expect(_batchCountForTests()).toBe(2);
    vi.advanceTimersByTime(3 * 60 * 1000 + 100);
    expect(execFileSpy).toHaveBeenCalledTimes(2);
  });
});
