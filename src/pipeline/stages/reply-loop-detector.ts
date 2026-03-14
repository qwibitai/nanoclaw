/**
 * Reply-loop detector — prevents Andy from getting stuck in back-and-forth
 * loops with the same sender. Tracks inbound and outbound message timestamps
 * per JID and rejects when round-trip count exceeds threshold within a window.
 */
import { logger } from '../../logger.js';
import { RATE_LIMITS } from '../../filters.js';
import { InboundStage, InboundMessage, StageVerdict } from '../types.js';

const { maxRoundTrips, windowMs } = RATE_LIMITS.replyLoop;

export class ReplyLoopDetector implements InboundStage {
  name = 'reply-loop-detector';

  private inbound = new Map<string, number[]>();
  private outbound = new Map<string, number[]>();

  /** Prune a single key's timestamps to only those within the window, removing the key if empty. */
  private pruneKey(map: Map<string, number[]>, key: string, cutoff: number): number[] {
    const ts = map.get(key) || [];
    const fresh = ts.filter(t => t > cutoff);
    if (fresh.length === 0) {
      map.delete(key);
    } else {
      map.set(key, fresh);
    }
    return fresh;
  }

  /** Called by outbound pipeline after sending a reply. */
  recordOutbound(jid: string): void {
    const now = Date.now();
    const cutoff = now - windowMs;
    const ts = this.outbound.get(jid) || [];
    ts.push(now);
    this.outbound.set(jid, ts);
    this.pruneKey(this.outbound, jid, cutoff);
  }

  process(msg: InboundMessage): StageVerdict {
    const now = Date.now();
    const jid = msg.chatJid;
    const cutoff = now - windowMs;

    // Record inbound timestamp and prune inline
    const inTs = this.inbound.get(jid) || [];
    inTs.push(now);
    this.inbound.set(jid, inTs);
    const freshIn = this.pruneKey(this.inbound, jid, cutoff);

    // Prune outbound for this key inline too
    const freshOut = this.pruneKey(this.outbound, jid, cutoff);

    if (freshIn.length > maxRoundTrips && freshOut.length > maxRoundTrips) {
      logger.warn(
        { jid, inbound: freshIn.length, outbound: freshOut.length, windowMs },
        'Reply loop detected',
      );
      return {
        action: 'reject',
        reason: `reply loop detected: ${freshIn.length} in / ${freshOut.length} out in ${windowMs / 60_000}m`,
      };
    }

    return { action: 'pass' };
  }
}
