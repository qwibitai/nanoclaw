// src/inbound-debounce.ts

/**
 * Per-group inbound message debouncer.
 *
 * Delays dispatch of `enqueueMessageCheck` by `debounceMs` after the most
 * recent push for a group. If debounceMs is 0, dispatches synchronously.
 *
 * Inspired by NullClaw's InboundDebouncer (src/inbound_debounce.zig).
 */
export class InboundDebouncer {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly debounceMs: number,
    private readonly dispatch: (groupJid: string) => void,
  ) {}

  /** Record a new message for a group and (re)start its debounce timer. */
  push(groupJid: string): void {
    if (this.debounceMs === 0) {
      this.dispatch(groupJid);
      return;
    }

    const existing = this.timers.get(groupJid);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(groupJid);
      this.dispatch(groupJid);
    }, this.debounceMs);

    this.timers.set(groupJid, timer);
  }

  /** Cancel any pending debounce for a group (e.g. when message was piped to active agent). */
  cancel(groupJid: string): void {
    const timer = this.timers.get(groupJid);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(groupJid);
    }
  }

  /** Cancel all pending timers (used on shutdown). */
  cancelAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
