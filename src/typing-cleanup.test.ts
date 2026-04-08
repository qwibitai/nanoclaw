import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for typing indicator cleanup behavior in processGroupMessages.
 *
 * processGroupMessages is a non-exported function with heavy dependencies,
 * so we test the cleanup patterns in isolation to verify:
 * 1. clearInterval is called before sendMessage (race condition fix)
 * 2. try-finally guarantees cleanup on all exit paths
 * 3. clearInterval idempotency — multiple calls are safe
 */

describe('typing keepalive cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clearInterval before sendMessage prevents race condition', async () => {
    const typingCalls: boolean[] = [];
    const setTyping = vi.fn((_jid: string, isTyping: boolean) => {
      typingCalls.push(isTyping);
      return Promise.resolve();
    });
    const sendMessage = vi.fn((_jid: string, _text: string) =>
      Promise.resolve(),
    );

    // Simulate typing keepalive pattern from processGroupMessages
    await setTyping('chat1', true);
    const typingKeepalive = setInterval(() => {
      setTyping('chat1', true).catch(() => {});
    }, 4000);

    // Simulate streaming callback — clearInterval BEFORE sendMessage
    clearInterval(typingKeepalive);
    await sendMessage('chat1', 'Hello');

    // Advance time to verify no more typing calls fire after clearInterval
    vi.advanceTimersByTime(8000);

    // typing(true) was called once at start, no more after clearInterval
    expect(typingCalls).toEqual([true]);
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('without fix: typing fires after sendMessage (race condition)', async () => {
    const typingCalls: boolean[] = [];
    const setTyping = vi.fn((_jid: string, isTyping: boolean) => {
      typingCalls.push(isTyping);
      return Promise.resolve();
    });
    const sendMessage = vi.fn((_jid: string, _text: string) =>
      Promise.resolve(),
    );

    await setTyping('chat1', true);
    const typingKeepalive = setInterval(() => {
      setTyping('chat1', true).catch(() => {});
    }, 4000);

    // BUG pattern: sendMessage first, clearInterval only after runAgent completes
    await sendMessage('chat1', 'Hello');
    // Simulate delay before cleanup (runAgent still running)
    vi.advanceTimersByTime(4000);
    // Typing fires again AFTER message was sent — this is the bug
    expect(typingCalls.length).toBeGreaterThan(1);

    clearInterval(typingKeepalive);
  });

  it('try-finally guarantees cleanup on error', async () => {
    const setTyping = vi.fn((_jid: string, _isTyping: boolean) =>
      Promise.resolve(),
    );

    const typingKeepalive = setInterval(() => {
      setTyping('chat1', true).catch(() => {});
    }, 4000);

    let idleTimer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => {},
      30000,
    );
    let cleaned = false;

    // Simulate try-finally pattern around runAgent
    try {
      try {
        throw new Error('agent callback error');
      } finally {
        clearInterval(typingKeepalive);
        await setTyping('chat1', false).catch(() => {});
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
        cleaned = true;
      }
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch {
      // error expected
    }

    expect(cleaned).toBe(true);

    // Verify timer is stopped
    vi.advanceTimersByTime(8000);
    // setTyping was called only in the finally block (false), not by the interval
    expect(setTyping).toHaveBeenCalledTimes(1);
    expect(setTyping).toHaveBeenCalledWith('chat1', false);
  });

  it('clearInterval is idempotent — safe to call multiple times', () => {
    let callCount = 0;
    const timer = setInterval(() => {
      callCount++;
    }, 100);

    // First clear
    clearInterval(timer);
    // Second clear (from finally block) — should not throw
    clearInterval(timer);

    vi.advanceTimersByTime(1000);
    expect(callCount).toBe(0);
  });

  it('setTyping error in finally does not mask original error', async () => {
    const setTyping = vi.fn((_jid: string, _isTyping: boolean) =>
      Promise.reject(new Error('channel disconnected')),
    );

    const typingKeepalive = setInterval(() => {}, 4000);
    const originalError = new Error('agent failed');
    let caughtError: Error | null = null;

    try {
      try {
        throw originalError;
      } finally {
        clearInterval(typingKeepalive);
        // .catch() prevents masking
        await setTyping('chat1', false).catch(() => {});
      }
      // eslint-disable-next-line no-catch-all/no-catch-all
    } catch (e) {
      caughtError = e as Error;
    }

    // Original error is preserved, not masked by setTyping failure
    expect(caughtError).toBe(originalError);
  });
});

/**
 * Tests for typing indicator stuck-on bug.
 *
 * processGroupMessages has code paths where typingActive is never set to false
 * on a non-partial (final) result. The keepalive interval (2s) keeps refreshing
 * Telegram's typing indicator indefinitely because setTyping(false) is a no-op
 * for Telegram — only stopping the keepalive actually clears the indicator.
 *
 * The simulation below mirrors the onOutput callback logic in index.ts.
 */
describe('typingActive on final result edge cases', () => {
  /**
   * Simulate the onOutput callback's typingActive logic from processGroupMessages.
   * Returns final typingActive value after processing all results.
   */
  function simulateOnOutputTyping(
    results: Array<{
      result: string | null;
      partial?: boolean;
      status?: 'success' | 'error';
    }>,
    opts?: { initialLastSentText?: string },
  ): { typingActive: boolean } {
    // Mirrors index.ts state
    let typingActive = true;
    let streamMessageId: number | null = null;
    let lastSentText: string | null = opts?.initialLastSentText ?? null;

    // Inline stripInternalTags (same as router.ts)
    const strip = (text: string): string =>
      text
        .replace(/<internal>[\s\S]*?<\/internal>/g, '')
        .replace(/<internal>[\s\S]*$/g, '')
        .replace(/<int(?:e(?:r(?:n(?:a(?:l)?)?)?)?)?$/g, '')
        .trim();

    for (const r of results) {
      if (r.result) {
        const text = strip(r.result);

        if (r.partial) {
          if (!typingActive) {
            typingActive = true;
          }
          continue;
        }

        // Final result
        if (streamMessageId !== null) {
          lastSentText = text;
        } else if (text && text !== lastSentText) {
          lastSentText = text;
        }

        streamMessageId = null;
        lastSentText = null;
      }

      // FIX: unconditionally set typingActive = false for all non-partial results
      if (!r.partial) {
        typingActive = false;
      }
    }

    return { typingActive };
  }

  it('typingActive becomes false when final result has empty text (no streaming)', () => {
    // Agent produces only <internal> content — stripInternalTags returns empty
    const { typingActive } = simulateOnOutputTyping([
      { result: '<internal>tool reasoning</internal>', partial: true },
      { result: '<internal>tool output processed</internal>' },
    ]);
    expect(typingActive).toBe(false);
  });

  it('typingActive becomes false on duplicate suppression without streaming', () => {
    // cleanText === lastSentText with no streaming active
    const { typingActive } = simulateOnOutputTyping(
      [
        { result: 'Hello', partial: true },
        { result: 'Hello' }, // duplicate
      ],
      { initialLastSentText: 'Hello' },
    );
    expect(typingActive).toBe(false);
  });

  it('typingActive becomes false when result.result is null (session update marker)', () => {
    // Session update marker: { status: 'success', result: null }
    // Emitted between IPC queries — typingActive should become false
    const { typingActive } = simulateOnOutputTyping([
      { result: 'Answer', partial: true },
      { result: 'Answer' }, // final → typingActive = false
      { result: null, status: 'success' }, // session update marker
    ]);
    expect(typingActive).toBe(false);
  });

  it('typingActive becomes false for null result even when previously set by partial', () => {
    // Partial sets typingActive = true, then null result should clear it
    const { typingActive } = simulateOnOutputTyping([
      { result: 'thinking...', partial: true }, // typingActive = true
      { result: null, status: 'success' }, // should set typingActive = false
    ]);
    expect(typingActive).toBe(false);
  });
});

describe('message loop typing suppression', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('typing is suppressed when response was sent recently', () => {
    vi.setSystemTime(new Date('2026-04-05T12:00:00Z'));

    const setTyping = vi.fn((_jid: string, _isTyping: boolean) =>
      Promise.resolve(),
    );
    let lastResponseSentAt = 0;

    // Simulate markResponseSent
    lastResponseSentAt = Date.now();

    // Simulate message loop piping path — 2 seconds after response
    vi.setSystemTime(new Date('2026-04-05T12:00:02Z'));
    const isRecent = Date.now() - lastResponseSentAt < 10000;

    if (!isRecent) {
      setTyping('chat1', true);
    }

    // typing should NOT have been called — response was 2s ago
    expect(setTyping).not.toHaveBeenCalled();
  });

  it('typing is shown when response was sent long ago', () => {
    vi.setSystemTime(new Date('2026-04-05T12:00:00Z'));

    const setTyping = vi.fn((_jid: string, _isTyping: boolean) =>
      Promise.resolve(),
    );
    let lastResponseSentAt = 0;

    // Simulate markResponseSent
    lastResponseSentAt = Date.now();

    // Simulate message loop piping path — 15 seconds after response
    vi.setSystemTime(new Date('2026-04-05T12:00:15Z'));
    const isRecent = Date.now() - lastResponseSentAt < 10000;

    if (!isRecent) {
      setTyping('chat1', true);
    }

    // typing SHOULD have been called — response was 15s ago
    expect(setTyping).toHaveBeenCalledWith('chat1', true);
  });
});
