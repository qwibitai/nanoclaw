import {
  NOTIFICATION_BATCH_WINDOW_CRITICAL,
  NOTIFICATION_BATCH_WINDOW_ERROR,
  NOTIFICATION_BATCH_WINDOW_INFO,
  NOTIFICATION_BATCH_WINDOW_WARNING,
} from './config.js';
import { logger } from './logger.js';

// --- Types ---

export type NotificationSeverity = 'critical' | 'error' | 'warning' | 'info';

export interface Notification {
  severity: NotificationSeverity;
  text: string;
  timestamp: number;
}

/** Map of severity → batch window in ms. */
const BATCH_WINDOWS: Record<NotificationSeverity, number> = {
  critical: NOTIFICATION_BATCH_WINDOW_CRITICAL,
  error: NOTIFICATION_BATCH_WINDOW_ERROR,
  warning: NOTIFICATION_BATCH_WINDOW_WARNING,
  info: NOTIFICATION_BATCH_WINDOW_INFO,
};

/** Severity ordering for rendering (most urgent first). */
const SEVERITY_ORDER: NotificationSeverity[] = [
  'critical',
  'error',
  'warning',
  'info',
];

/** Emoji prefix per severity for the batched summary. */
const SEVERITY_EMOJI: Record<NotificationSeverity, string> = {
  critical: '🔴',
  error: '🔴',
  warning: '⚠️',
  info: 'ℹ️',
};

// --- Batch Bucket ---

/** A bucket collects notifications for a single (jid, severity) pair. */
interface BatchBucket {
  jid: string;
  severity: NotificationSeverity;
  items: Notification[];
  timer: ReturnType<typeof setTimeout> | null;
}

// --- NotificationBatcher ---

export type SendFn = (jid: string, text: string) => Promise<void>;

/**
 * Collects notifications and groups them by (jid, severity).
 *
 * - Critical/error notifications are delivered immediately (window = 0ms).
 * - Warning/info notifications are held for a configurable window and
 *   flushed as a single batched message to reduce Telegram spam.
 */
export class NotificationBatcher {
  private buckets = new Map<string, BatchBucket>();
  private sendFn: SendFn;

  constructor(sendFn: SendFn) {
    this.sendFn = sendFn;
  }

  /** Unique key for a (jid, severity) bucket. */
  private bucketKey(jid: string, severity: NotificationSeverity): string {
    return `${jid}:${severity}`;
  }

  /**
   * Enqueue a notification. Immediate severities are sent right away;
   * batched severities start (or extend) a flush timer.
   */
  async send(
    jid: string,
    text: string,
    severity: NotificationSeverity,
  ): Promise<void> {
    const windowMs = BATCH_WINDOWS[severity];
    const notification: Notification = {
      severity,
      text,
      timestamp: Date.now(),
    };

    // Immediate delivery for zero-window severities
    if (windowMs <= 0) {
      await this.sendFn(jid, text);
      return;
    }

    // Batched delivery: add to bucket and start/reset timer
    const key = this.bucketKey(jid, severity);
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { jid, severity, items: [], timer: null };
      this.buckets.set(key, bucket);
    }

    bucket.items.push(notification);

    // Start timer on first item; subsequent items join the existing window
    if (!bucket.timer) {
      bucket.timer = setTimeout(() => {
        this.flushBucket(key).catch((err) =>
          logger.error(
            { err, jid, severity },
            'Failed to flush notification batch',
          ),
        );
      }, windowMs);
    }
  }

  /** Flush a single bucket — sends all collected items as one message. */
  private async flushBucket(key: string): Promise<void> {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.items.length === 0) {
      this.buckets.delete(key);
      return;
    }

    const { jid, severity, items } = bucket;

    // Clear the bucket before sending (so new notifications during send
    // start a fresh window)
    if (bucket.timer) clearTimeout(bucket.timer);
    this.buckets.delete(key);

    // Single item — send as-is (no batching chrome)
    if (items.length === 1) {
      await this.sendFn(jid, items[0].text);
      return;
    }

    // Multiple items — format as a batched summary
    const emoji = SEVERITY_EMOJI[severity];
    const header = `${emoji} *${items.length} ${severity} notifications (batched)*`;
    const body = items.map((n, i) => `${i + 1}. ${n.text}`).join('\n');
    const message = `${header}\n\n${body}`;

    await this.sendFn(jid, message);
  }

  /**
   * Flush all pending buckets immediately (used during shutdown).
   * Returns a promise that resolves when all flushes complete.
   */
  async flushAll(): Promise<void> {
    const keys = [...this.buckets.keys()];
    await Promise.allSettled(keys.map((key) => this.flushBucket(key)));
  }

  /** Number of pending (unflushed) buckets. */
  get pendingCount(): number {
    return this.buckets.size;
  }

  /**
   * Format a multi-severity batch summary from an array of notifications
   * destined for the same JID. Groups by severity (most urgent first).
   *
   * Exported as a static utility for callers that want to compose their
   * own batched message without going through the timer-based pipeline.
   */
  static formatBatchSummary(items: Notification[]): string {
    const bySeverity = new Map<NotificationSeverity, Notification[]>();
    for (const item of items) {
      const list = bySeverity.get(item.severity) ?? [];
      list.push(item);
      bySeverity.set(item.severity, list);
    }

    const sections: string[] = [];
    for (const severity of SEVERITY_ORDER) {
      const group = bySeverity.get(severity);
      if (!group || group.length === 0) continue;

      const emoji = SEVERITY_EMOJI[severity];
      sections.push(
        `${emoji} *${severity}* (${group.length})`,
        ...group.map((n) => `  • ${n.text}`),
      );
    }

    return sections.join('\n');
  }
}
