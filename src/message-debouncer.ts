import { logger } from './logger.js';
import type { NewMessage } from './types.js';

/**
 * Buffers incoming messages to reassemble fragments that Telegram splits.
 *
 * When a message arrives from a sender in a chat, we hold it for a short
 * window. If more fragments arrive from the same sender in the same chat
 * within that window, they're accumulated. Only after the window expires
 * with no new fragments do we flush the merged message to the store.
 *
 * This ensures the agent never sees a partial message — it always gets the
 * complete reassembled content.
 */
export class MessageDebouncer {
  private pending = new Map<
    string,
    { msg: NewMessage; timer: ReturnType<typeof setTimeout> }
  >();
  private flushCallback: (chatJid: string, msg: NewMessage) => void;
  private debounceMs: number;

  /**
   * @param flushCallback Called when a message (or merged group of fragments) is ready to store
   * @param debounceMs How long to wait after the last fragment before flushing (default: 3000ms)
   */
  constructor(
    flushCallback: (chatJid: string, msg: NewMessage) => void,
    debounceMs = 3000,
  ) {
    this.flushCallback = flushCallback;
    this.debounceMs = debounceMs;
  }

  /** Generate a merge key from sender + chat */
  private mergeKey(chatJid: string, sender: string): string {
    return `${chatJid}::${sender}`;
  }

  /**
   * Accept a message for debounced storage.
   * If a pending message exists from the same sender in the same chat,
   * merge the content and reset the timer. Otherwise, start a new timer.
   */
  push(chatJid: string, msg: NewMessage): void {
    // Bot messages and messages from self are never debounced — they're
    // already properly split by the outbound handler.
    if (msg.is_bot_message || msg.is_from_me) {
      this.flushCallback(chatJid, msg);
      return;
    }

    const key = this.mergeKey(chatJid, msg.sender);
    const existing = this.pending.get(key);

    if (existing) {
      // Merge: append content and update timestamp to the latest fragment
      clearTimeout(existing.timer);
      existing.msg.content += '\n' + msg.content;
      existing.msg.timestamp = msg.timestamp;
      logger.debug(
        {
          chatJid,
          sender: msg.sender,
          contentLength: existing.msg.content.length,
        },
        'Merged message fragment',
      );
      existing.timer = setTimeout(() => this.flush(key), this.debounceMs);
    } else {
      // New message — start debounce timer
      const timer = setTimeout(() => this.flush(key), this.debounceMs);
      this.pending.set(key, { msg, timer });
    }
  }

  /** Flush a pending message to the store callback */
  private flush(key: string): void {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    this.flushCallback(entry.msg.chat_jid, entry.msg);
  }

  /** Flush all pending messages immediately (for graceful shutdown) */
  flushAll(): void {
    for (const key of this.pending.keys()) {
      this.flush(key);
    }
  }

  /** Number of pending (un-flushed) message groups — for testing */
  get pendingCount(): number {
    return this.pending.size;
  }
}
