/**
 * Business relevance gate — skips emails not related to the actual businesses.
 * Only active for email channel. SMS/Messenger/WhatsApp/Web are direct customer conversations.
 */
import { BUSINESS_KEYWORDS } from '../../filters.js';
import { logger } from '../../logger.js';
import { InboundStage, InboundMessage, StageVerdict } from '../types.js';

export class RelevanceGate implements InboundStage {
  name = 'relevance-gate';

  /** Channels that require business keyword match. */
  private gatedChannels = new Set(['gmail']);

  process(msg: InboundMessage): StageVerdict {
    if (!this.gatedChannels.has(msg.channel)) {
      return { action: 'pass' };
    }

    const text = `${msg.subject || ''} ${msg.content.slice(0, 500)}`.toLowerCase();
    const isRelevant = BUSINESS_KEYWORDS.some(re => re.test(text));

    if (!isRelevant) {
      logger.info({ from: msg.sender, subject: msg.subject }, 'Skipped non-business email');
      return { action: 'reject', reason: 'not business relevant' };
    }

    return { action: 'pass' };
  }
}
