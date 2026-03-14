/**
 * Shared rate limiter — configurable per-key timestamps with hourly/daily limits.
 * Used for both inbound (per-sender) and outbound (per-JID) rate limiting.
 * Replaces the copy-pasted replyTimestamps pattern in every channel.
 */
import { logger } from '../../logger.js';
import {
  InboundStage, InboundMessage, StageVerdict,
  OutboundStage, OutboundMessage, OutboundVerdict,
} from '../types.js';

interface RateLimitConfig {
  perHour: number;
  perDay: number;
}

/** Core rate limiter engine — shared between inbound and outbound stages. */
class RateLimiterCore {
  private timestamps = new Map<string, number[]>();

  constructor(
    private label: string,
    private config: RateLimitConfig,
  ) {}

  check(key: string): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const ts = this.timestamps.get(key) || [];
    const oneHourAgo = now - 3_600_000;
    const oneDayAgo = now - 86_400_000;

    const lastHour = ts.filter(t => t > oneHourAgo).length;
    if (lastHour >= this.config.perHour) {
      return { allowed: false, reason: `${this.label}: ${lastHour}/${this.config.perHour} per hour` };
    }

    const lastDay = ts.filter(t => t > oneDayAgo).length;
    if (lastDay >= this.config.perDay) {
      return { allowed: false, reason: `${this.label}: ${lastDay}/${this.config.perDay} per day` };
    }

    return { allowed: true };
  }

  /**
   * Atomically check the rate limit and record the entry in one step.
   * Prevents the race where two calls both pass `check` before either calls `record`.
   * The entry is added first, then limits are verified; rolled back if over limit.
   */
  checkAndRecord(key: string): { allowed: boolean; reason?: string } {
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    const oneDayAgo = now - 86_400_000;

    // Add the entry first (optimistic insert)
    const ts = this.timestamps.get(key) || [];
    ts.push(now);
    const fresh = ts.filter(t => t > oneDayAgo);
    this.timestamps.set(key, fresh);

    // Check limits (counts include the entry we just added)
    const lastHour = fresh.filter(t => t > oneHourAgo).length;
    if (lastHour > this.config.perHour) {
      // Over limit — roll back
      fresh.pop();
      if (fresh.length === 0) this.timestamps.delete(key);
      return { allowed: false, reason: `${this.label}: ${lastHour - 1}/${this.config.perHour} per hour` };
    }

    if (fresh.length > this.config.perDay) {
      // Over limit — roll back
      fresh.pop();
      if (fresh.length === 0) this.timestamps.delete(key);
      return { allowed: false, reason: `${this.label}: ${fresh.length}/${this.config.perDay} per day` };
    }

    // Prune empty/stale keys globally (cheap scan)
    if (this.timestamps.size > 500) {
      for (const [k, entries] of this.timestamps) {
        if (entries.length === 0 || entries[entries.length - 1] < oneDayAgo) {
          this.timestamps.delete(k);
        }
      }
    }

    return { allowed: true };
  }

  /** Record a successful send against the rate limit for this key. */
  record(key: string): void {
    const now = Date.now();
    const oneDayAgo = now - 86_400_000;
    const ts = this.timestamps.get(key) || [];

    ts.push(now);
    const fresh = ts.filter(t => t > oneDayAgo);
    if (fresh.length === 0) {
      this.timestamps.delete(key);
    } else {
      this.timestamps.set(key, fresh);
    }

    // Prune empty/stale keys globally (cheap scan)
    if (this.timestamps.size > 500) {
      for (const [k, entries] of this.timestamps) {
        if (entries.length === 0 || entries[entries.length - 1] < oneDayAgo) {
          this.timestamps.delete(k);
        }
      }
    }
  }
}

/** Inbound rate limiter — limits how often a sender can trigger the agent. */
export class InboundRateLimiter implements InboundStage {
  name = 'inbound-rate-limiter';
  private core: RateLimiterCore;

  constructor(config: RateLimitConfig) {
    this.core = new RateLimiterCore('inbound', config);
  }

  process(msg: InboundMessage): StageVerdict {
    const result = this.core.checkAndRecord(msg.sender);
    if (!result.allowed) {
      logger.warn({ sender: msg.sender, reason: result.reason }, 'Inbound rate limit hit');
      return { action: 'reject', reason: result.reason! };
    }
    return { action: 'pass' };
  }
}

/** Outbound rate limiter — limits replies to any single JID. */
export class OutboundRateLimiter implements OutboundStage {
  name = 'outbound-rate-limiter';
  private core: RateLimiterCore;
  private exemptFolders: Set<string>;

  constructor(
    config: RateLimitConfig,
    private getGroupFolder: (jid: string) => string | undefined,
    exemptFolders: string[] = [],
  ) {
    this.core = new RateLimiterCore('outbound', config);
    this.exemptFolders = new Set(exemptFolders);
  }

  process(msg: OutboundMessage): OutboundVerdict {
    const folder = this.getGroupFolder(msg.chatJid);
    if (folder && this.exemptFolders.has(folder)) {
      return { action: 'pass' };
    }

    const result = this.core.check(msg.chatJid);
    if (!result.allowed) {
      logger.warn({ jid: msg.chatJid, reason: result.reason }, 'Outbound rate limit hit');
      return { action: 'reject', reason: result.reason! };
    }
    return { action: 'pass' };
  }

  /** Record a successful send against the rate limit. Called AFTER message is actually sent. */
  recordSend(jid: string): void {
    this.core.record(jid);
  }
}
