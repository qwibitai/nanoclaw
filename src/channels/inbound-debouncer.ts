/**
 * Per-key inbound debouncer.
 *
 * A nervous founder firing five short DMs in two seconds shouldn't wake
 * the runner five times — both the model spend and the reply storm are
 * pure waste. This util coalesces rapid bursts on a per-chat key into a
 * single flush after the burst settles.
 *
 * Generic by design — every channel adapter (Telegram today; WhatsApp,
 * Slack, web-chat tomorrow) constructs its own debouncer and supplies a
 * channel-specific `coalesce` that knows how to merge that channel's
 * message shape.
 *
 * Contract:
 *   - `push` is fire-and-forget — it does NOT return a promise tracking
 *     the eventual flush.
 *   - `dispose()` is best-effort teardown: pending buffers are dropped,
 *     not flushed, so stragglers don't fire as the host shuts down.
 *   - `coalesce` errors and `onFlush` rejections route through
 *     `onError` if provided, otherwise are swallowed (a setTimeout
 *     callback can't bubble to a useful caller).
 */

export interface DebouncerConfig<T> {
  /** Burst settle window in milliseconds. Each `push` (re)arms a timer. */
  flushMs: number;
  /**
   * Combine N buffered items into a single coalesced item. Items are
   * passed in arrival order (oldest first). Called even when N === 1.
   */
  coalesce: (items: T[]) => T;
  /** Invoked once when the timer fires for a key. */
  onFlush: (key: string, coalesced: T) => Promise<void>;
  /**
   * Called when `coalesce` throws or `onFlush` rejects. Without this,
   * errors are swallowed (they cannot bubble out of a setTimeout
   * callback to a useful caller anyway).
   */
  onError?: (err: unknown, key: string) => void;
}

export interface InboundDebouncer<T> {
  /** Buffer an item for `key` and (re)arm the flush timer. */
  push(key: string, item: T): void;
  /** Cancel every pending timer; drop every buffer. No-op after first call. */
  dispose(): void;
}

interface Entry<T> {
  items: T[];
  timer: NodeJS.Timeout;
}

export function createInboundDebouncer<T>(config: DebouncerConfig<T>): InboundDebouncer<T> {
  const { flushMs, coalesce, onFlush, onError } = config;
  const buffers = new Map<string, Entry<T>>();
  let disposed = false;

  async function flush(key: string): Promise<void> {
    const entry = buffers.get(key);
    if (!entry) return;
    buffers.delete(key);
    const coalesced = coalesce(entry.items);
    await onFlush(key, coalesced);
  }

  function scheduleFlush(key: string): NodeJS.Timeout {
    const t = setTimeout(() => {
      // Fire-and-forget. We can't bubble errors out of a timer callback
      // to a meaningful caller, so route them through onError or drop.
      flush(key).catch((err) => {
        if (onError) {
          try {
            onError(err, key);
          } catch {
            /* swallow — onError itself misbehaving is not our problem */
          }
        }
      });
    }, flushMs);
    t.unref?.();
    return t;
  }

  return {
    push(key, item) {
      if (disposed) return;
      const existing = buffers.get(key);
      if (existing) {
        clearTimeout(existing.timer);
        existing.items.push(item);
        existing.timer = scheduleFlush(key);
        return;
      }
      buffers.set(key, { items: [item], timer: scheduleFlush(key) });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of buffers.values()) {
        clearTimeout(entry.timer);
      }
      buffers.clear();
    },
  };
}
