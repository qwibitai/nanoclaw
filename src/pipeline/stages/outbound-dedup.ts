/**
 * Outbound dedup — prevents sending identical messages to the same JID within a window.
 * Persists to SQLite so restarts don't cause duplicate sends to customers.
 */
import { createHash } from 'crypto';
import { RATE_LIMITS } from '../../filters.js';
import { hasOutboundDedup, recordOutboundDedup, pruneOldOutboundDedup } from '../../db.js';
import { logger } from '../../logger.js';
import { OutboundStage, OutboundMessage, OutboundVerdict } from '../types.js';

export class OutboundDedup implements OutboundStage {
  name = 'outbound-dedup';

  private insertCount = 0;
  private readonly PRUNE_INTERVAL = 50;
  private readonly windowMs = RATE_LIMITS.dedup.windowMs;

  process(msg: OutboundMessage): OutboundVerdict {
    const hash = createHash('sha256').update(msg.text).digest('hex').slice(0, 16);
    const key = `${msg.chatJid}:${hash}`;

    if (hasOutboundDedup(key)) {
      logger.warn({ jid: msg.chatJid }, 'Duplicate outbound message suppressed (persisted)');
      return { action: 'reject', reason: 'duplicate content' };
    }

    recordOutboundDedup(key);
    this.insertCount++;

    // Prune stale entries periodically
    if (this.insertCount % this.PRUNE_INTERVAL === 0) {
      pruneOldOutboundDedup(this.windowMs);
    }

    return { action: 'pass' };
  }
}
