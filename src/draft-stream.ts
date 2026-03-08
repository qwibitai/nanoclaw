/**
 * Draft Stream — progressive message editing for streaming responses.
 *
 * Sends an initial message, then throttles subsequent edits so Telegram
 * (or any channel with edit support) isn't hammered with API calls.
 *
 * Based on the draft-stream pattern from AtomicBot.
 */

import { logger } from './logger.js';

export interface DraftStream {
  /** Update the streaming preview with new text (throttled). */
  update(text: string): void;
  /**
   * Finalize the stream with the final text.
   * Returns true if delivered via the draft stream (edit or new send).
   * Returns false if the text was too long or the stream failed — caller
   * should fall back to channel.sendMessage().
   */
  finish(text: string): Promise<boolean>;
  /** Cancel the stream and delete the preview message if any. */
  cancel(): Promise<void>;
}

export interface DraftStreamOpts {
  /** Send a new message, return its platform message ID. */
  sendMessage(text: string): Promise<number | undefined>;
  /** Edit an existing message by ID. */
  editMessage(messageId: number, text: string): Promise<void>;
  /** Delete a message by ID. */
  deleteMessage(messageId: number): Promise<void>;
  /** Throttle interval in ms (default 1000). */
  throttleMs?: number;
  /** Max message length (default 4096 for Telegram). */
  maxLength?: number;
  /** Minimum chars before sending first message (debounce for push notifications). */
  minInitialChars?: number;
}

export function createDraftStream(opts: DraftStreamOpts): DraftStream {
  const throttleMs = Math.max(250, opts.throttleMs ?? 1000);
  const maxLength = opts.maxLength ?? 4096;
  const minInitialChars = opts.minInitialChars ?? 30;

  let messageId: number | undefined;
  let lastSentText = '';
  let pendingText = '';
  let stopped = false;
  let inFlight: Promise<boolean> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSentAt = 0;

  const doSendOrEdit = async (text: string): Promise<boolean> => {
    if (stopped) return false;
    const trimmed = text.trimEnd();
    if (!trimmed || trimmed === lastSentText) return true;
    if (trimmed.length > maxLength) {
      // Text exceeds platform limit — stop streaming, caller will handle.
      stopped = true;
      logger.debug(
        { length: trimmed.length, maxLength },
        'Draft stream stopped: text exceeds max length',
      );
      return false;
    }

    // Debounce first message to avoid noisy push notifications for short prefixes.
    if (messageId === undefined && trimmed.length < minInitialChars) {
      return false;
    }

    lastSentText = trimmed;
    try {
      if (messageId !== undefined) {
        await opts.editMessage(messageId, trimmed);
      } else {
        messageId = await opts.sendMessage(trimmed);
        if (messageId === undefined) {
          stopped = true;
          return false;
        }
      }
      return true;
    } catch (err) {
      logger.debug({ err }, 'Draft stream send/edit failed');
      stopped = true;
      return false;
    }
  };

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    while (!stopped) {
      if (inFlight) {
        await inFlight;
        continue;
      }
      const text = pendingText;
      if (!text.trim()) {
        pendingText = '';
        return;
      }
      pendingText = '';
      const p = doSendOrEdit(text).finally(() => {
        if (inFlight === p) inFlight = undefined;
      });
      inFlight = p;
      const ok = await p;
      if (!ok) {
        pendingText = text;
        return;
      }
      lastSentAt = Date.now();
      if (!pendingText) return;
    }
  };

  const schedule = (): void => {
    if (timer) return;
    const delay = Math.max(0, throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, delay);
  };

  return {
    update(text: string): void {
      if (stopped) return;
      pendingText = text;
      if (inFlight) {
        schedule();
        return;
      }
      if (!timer && Date.now() - lastSentAt >= throttleMs) {
        void flush();
        return;
      }
      schedule();
    },

    async finish(text: string): Promise<boolean> {
      // Re-enable sending for the final flush even if previously stopped
      // due to length (the final text might be shorter/different).
      const wasStopped = stopped;
      stopped = false;
      pendingText = text;
      await flush();

      // If we never managed to send anything (debounce or earlier failure),
      // try one direct send now.
      if (messageId === undefined && text.trim()) {
        const ok = await doSendOrEdit(text);
        stopped = true;
        return ok;
      }

      stopped = true;
      // If the stream was stopped due to length and we couldn't edit, report failure
      if (wasStopped && messageId === undefined) return false;
      return true;
    },

    async cancel(): Promise<void> {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (inFlight) await inFlight;
      if (messageId !== undefined) {
        try {
          await opts.deleteMessage(messageId);
        } catch (err) {
          logger.debug({ err }, 'Draft stream cleanup failed');
        }
      }
    },
  };
}
