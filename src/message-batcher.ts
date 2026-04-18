export interface MessageBatcherOpts {
  maxItems: number; // Flush after this many items (default: 5)
  maxWaitMs: number; // Flush after this many ms since first buffered item (default: 10000)
  onFlush: (items: string[]) => void;
}

export class MessageBatcher {
  private buffer: string[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private opts: MessageBatcherOpts;

  constructor(opts: MessageBatcherOpts) {
    this.opts = opts;
  }

  add(item: string): void {
    this.buffer.push(item);

    if (this.buffer.length >= this.opts.maxItems) {
      this.flush();
      return;
    }

    // Start timer on first item
    if (this.buffer.length === 1) {
      this.timer = setTimeout(() => this.flush(), this.opts.maxWaitMs);
    }
  }

  /** Force flush — call before sending a higher-priority message */
  flushNow(): void {
    if (this.buffer.length > 0) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.buffer.length === 0) return;

    const items = this.buffer.splice(0);
    this.opts.onFlush(items);
  }

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = [];
  }
}
