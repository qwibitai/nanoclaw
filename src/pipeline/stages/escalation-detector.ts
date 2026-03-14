/**
 * Complaint detector — identifies ANY customer issue or complaint.
 * Does NOT reject — always passes. Fires a callback so the owner
 * is notified of every complaint, no matter how small.
 *
 * Andy still responds (with scripted complaint handling), but Blayk
 * always knows about it so he can process refunds and pull product.
 */
import { COMPLAINT_PATTERNS } from '../../filters.js';
import { logger } from '../../logger.js';
import { InboundStage, InboundMessage, StageVerdict } from '../types.js';

export type ComplaintCallback = (msg: InboundMessage, matches: string[]) => void;

export class EscalationDetector implements InboundStage {
  name = 'complaint-detector';

  constructor(private onComplaint?: ComplaintCallback) {}

  process(msg: InboundMessage): StageVerdict {
    const text = msg.content;
    const matches: string[] = [];

    for (const pattern of COMPLAINT_PATTERNS) {
      const match = text.match(pattern);
      if (match) matches.push(match[0]);
    }

    if (matches.length > 0) {
      logger.info(
        { jid: msg.chatJid, sender: msg.sender, matches, channel: msg.channel },
        'Customer complaint detected — notifying owner',
      );
      this.onComplaint?.(msg, matches);
    }

    // Always pass — Andy responds, owner is notified
    return { action: 'pass' };
  }
}
