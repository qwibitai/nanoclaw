import type { SSEEmail } from './sse-classifier.js';
import { logger } from './logger.js';

export interface EmailTriggerDebouncerOpts {
  debounceMs: number;
  maxHoldMs: number;
  onFlush: (emails: SSEEmail[], label: string) => void;
}

export class EmailTriggerDebouncer {
  private buffer: Map<string, SSEEmail> = new Map();
  private label: string = '';
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private firstAddedAt: number = 0;
  private opts: EmailTriggerDebouncerOpts;

  constructor(opts: EmailTriggerDebouncerOpts) {
    this.opts = opts;
  }

  add(emails: SSEEmail[], label: string): void {
    if (emails.length === 0) return;

    const wasEmpty = this.buffer.size === 0;

    for (const email of emails) {
      if (!this.buffer.has(email.thread_id)) {
        this.buffer.set(email.thread_id, email);
      }
    }

    if (wasEmpty) {
      this.label = label;
      this.firstAddedAt = Date.now();

      logger.info(
        { threadIds: emails.map((e) => e.thread_id), label },
        'Debouncer: first email(s) buffered, starting timer',
      );

      // Start max-hold safety timer
      if (this.opts.maxHoldMs > 0) {
        this.maxHoldTimer = setTimeout(() => {
          logger.info(
            { bufferSize: this.buffer.size, holdMs: this.opts.maxHoldMs },
            'Debouncer: max hold reached, force-flushing',
          );
          this.doFlush();
        }, this.opts.maxHoldMs);
      }
    } else {
      logger.info(
        {
          newThreadIds: emails.map((e) => e.thread_id),
          bufferSize: this.buffer.size,
          timeSinceFirst: Date.now() - this.firstAddedAt,
        },
        'Debouncer: email(s) merged into buffer',
      );
    }

    // Passthrough mode: debounceMs === 0 means flush immediately
    if (this.opts.debounceMs === 0) {
      this.doFlush();
      return;
    }

    // Reset debounce timer
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.doFlush();
    }, this.opts.debounceMs);
  }

  has(threadId: string): boolean {
    return this.buffer.has(threadId);
  }

  flush(): void {
    if (this.buffer.size > 0) {
      this.doFlush();
    }
  }

  getBufferSize(): number {
    return this.buffer.size;
  }

  destroy(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxHoldTimer) {
      clearTimeout(this.maxHoldTimer);
      this.maxHoldTimer = null;
    }
    this.buffer.clear();
  }

  private doFlush(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxHoldTimer) {
      clearTimeout(this.maxHoldTimer);
      this.maxHoldTimer = null;
    }

    const emails = Array.from(this.buffer.values());
    const label = this.label;

    logger.info(
      {
        count: emails.length,
        threadIds: emails.map((e) => e.thread_id),
        holdMs: Date.now() - this.firstAddedAt,
      },
      'Debouncer: flushing buffered emails',
    );

    this.buffer.clear();
    this.label = '';
    this.firstAddedAt = 0;

    this.opts.onFlush(emails, label);
  }
}
