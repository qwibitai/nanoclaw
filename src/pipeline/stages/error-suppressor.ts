/**
 * Error suppressor — prevents internal error messages from being sent to customers.
 * Catches "Credit balance is too low", "rate_limit_error", etc.
 */
import { ERROR_PATTERNS } from '../../filters.js';
import { logger } from '../../logger.js';
import { OutboundStage, OutboundMessage, OutboundVerdict } from '../types.js';

export class ErrorSuppressor implements OutboundStage {
  name = 'error-suppressor';

  /** Messages longer than this are assumed to be real responses, not bare errors. */
  private static MAX_ERROR_LENGTH = 500;

  process(msg: OutboundMessage): OutboundVerdict {
    const text = msg.text.trim();
    if (text.length > ErrorSuppressor.MAX_ERROR_LENGTH) {
      return { action: 'pass' };
    }
    if (ERROR_PATTERNS.some(p => p.test(text))) {
      logger.warn({ jid: msg.chatJid }, 'Suppressed error message from outbound, sending friendly fallback');
      return {
        action: 'transform',
        text: 'Let me look into that and get back to you shortly.',
      };
    }
    return { action: 'pass' };
  }
}
