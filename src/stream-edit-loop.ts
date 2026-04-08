/**
 * Non-blocking streaming edit loop for Telegram message updates.
 *
 * Inspired by OpenClaw's DraftStreamLoop. Buffers pending text and flushes
 * on a throttled schedule, so update() is always synchronous and never
 * blocks the caller's promise chain.
 */

export interface StreamEditLoop {
  /** Buffer text for delivery. Synchronous — never blocks. */
  update(text: string): void;
  /** Force-send any pending text (waits for in-flight first). */
  flush(): Promise<void>;
  /** Cancel everything: clear pending, cancel timer, reject future updates. */
  stop(): void;
  /** Wait for any in-flight sendOrEdit call to settle. */
  waitForInFlight(): Promise<void>;
  /** Reset state for the next IPC query without stopping the loop. */
  resetForNextQuery(): void;
}

export function createStreamEditLoop(params: {
  throttleMs?: number;
  /**
   * Called to send or edit the streaming message.
   * Return values:
   *   void/true  — success
   *   false      — skip this send (text put back as pending, e.g. minInitialChars not met)
   *   throw      — stop streaming (loop marks itself stopped)
   */
  sendOrEdit(text: string): Promise<void | boolean>;
}): StreamEditLoop {
  const throttleMs = params.throttleMs ?? 500;

  let pendingText = '';
  let lastSentAt = 0;
  let inFlightPromise: Promise<void | boolean> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const flush = async (): Promise<void> => {
    clearTimer();
    while (!stopped) {
      if (inFlightPromise) {
        await inFlightPromise;
        continue;
      }
      const text = pendingText;
      if (!text.trim()) {
        pendingText = '';
        return;
      }
      pendingText = '';
      try {
        const current = params.sendOrEdit(text).finally(() => {
          if (inFlightPromise === current) {
            inFlightPromise = undefined;
          }
        });
        inFlightPromise = current;
        const result = await current;
        if (result === false) {
          // Caller signalled skip (e.g. minInitialChars not met) — put back
          pendingText = text;
          return;
        }
        lastSentAt = Date.now();
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch {
        stopped = true;
        return;
      }
      // If more text arrived while we were sending, loop continues
      if (!pendingText) {
        return;
      }
    }
  };

  const schedule = () => {
    if (timer) return;
    const delay = Math.max(0, throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
  };

  return {
    update(text: string) {
      if (stopped) return;
      pendingText = text;
      if (inFlightPromise) {
        schedule();
        return;
      }
      if (!timer && Date.now() - lastSentAt >= throttleMs) {
        void flush();
        return;
      }
      schedule();
    },

    flush,

    stop() {
      stopped = true;
      pendingText = '';
      clearTimer();
    },

    async waitForInFlight() {
      if (inFlightPromise) {
        await inFlightPromise;
      }
    },

    resetForNextQuery() {
      stopped = false;
      pendingText = '';
      lastSentAt = 0;
      clearTimer();
    },
  };
}
