/**
 * Complaint detector — identifies ANY customer issue or complaint.
 * Does NOT reject — always passes. Fires a callback so the owner
 * is notified of every complaint, no matter how small.
 *
 * Two urgency levels:
 * - URGENT: Legal threats, BBB, chargeback, cancellation, health hazard → immediate WhatsApp alert
 * - NORMAL: Machine issues, food quality, overcharge → standard notification
 *
 * Andy still responds (with scripted complaint handling), but Blayk
 * always knows about it so he can process refunds and pull product.
 */
import { COMPLAINT_PATTERNS, URGENT_COMPLAINT_PATTERNS } from '../../filters.js';
import { logger } from '../../logger.js';
import { InboundStage, InboundMessage, StageVerdict } from '../types.js';

export type ComplaintCallback = (msg: InboundMessage, matches: string[], urgent: boolean) => void;

export class EscalationDetector implements InboundStage {
  name = 'complaint-detector';

  constructor(private onComplaint?: ComplaintCallback) {}

  process(msg: InboundMessage): StageVerdict {
    const text = msg.content;
    const matches: string[] = [];
    let urgent = false;

    for (const pattern of COMPLAINT_PATTERNS) {
      const match = text.match(pattern);
      if (match) matches.push(match[0]);
    }

    // Check if any matches are high-urgency
    if (matches.length > 0) {
      for (const pattern of URGENT_COMPLAINT_PATTERNS) {
        if (pattern.test(text)) {
          urgent = true;
          break;
        }
      }

      logger.info(
        { jid: msg.chatJid, sender: msg.sender, matches, channel: msg.channel, urgent },
        urgent ? 'URGENT complaint detected — immediate owner alert' : 'Customer complaint detected — notifying owner',
      );
      this.onComplaint?.(msg, matches, urgent);
    }

    // Always pass — Andy responds, owner is notified
    return { action: 'pass' };
  }
}
