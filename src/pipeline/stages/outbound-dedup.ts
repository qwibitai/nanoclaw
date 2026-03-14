/**
 * Outbound dedup — prevents sending identical messages to the same JID within a window.
 * Replaces the recentOutbound Map in index.ts.
 */
import { createHash } from 'crypto';
import { RATE_LIMITS } from '../../filters.js';
import { logger } from '../../logger.js';
import { OutboundStage, OutboundMessage, OutboundVerdict } from '../types.js';

export class OutboundDedup implements OutboundStage {
  name = 'outbound-dedup';

  private recent = new Map<string, number>();
  private windowMs = RATE_LIMITS.dedup.windowMs;
  private insertCount = 0;
  private readonly PRUNE_INTERVAL = 50;

  process(msg: OutboundMessage): OutboundVerdict {
    const hash = createHash('sha256').update(msg.text).digest('hex').slice(0, 16);
    const key = `${msg.chatJid}:${hash}`;
    const now = Date.now();

    const lastSent = this.recent.get(key);
    if (lastSent && now - lastSent < this.windowMs) {
      logger.warn({ jid: msg.chatJid }, 'Duplicate outbound message suppressed');
      return { action: 'reject', reason: 'duplicate content' };
    }

    this.recent.set(key, now);
    this.insertCount++;

    // Prune stale entries every N inserts to bound memory
    if (this.insertCount % this.PRUNE_INTERVAL === 0) {
      for (const [k, t] of this.recent) {
        if (now - t > this.windowMs) this.recent.delete(k);
      }
    }

    return { action: 'pass' };
  }
}
