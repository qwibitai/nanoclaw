/**
 * Sender filter — blocks automated/noreply senders and detects autoresponder headers.
 * Replaces IGNORE_PATTERNS in gmail.ts and the isAutoResponse() function.
 * Only active for email channel by default (SMS/Messenger don't have these issues).
 */
import { IGNORE_SENDER_PATTERNS, AUTO_REPLY_SUBJECT_PREFIXES } from '../../filters.js';
import { logger } from '../../logger.js';
import { InboundStage, InboundMessage, StageVerdict } from '../types.js';

export class SenderFilter implements InboundStage {
  name = 'sender-filter';

  /** Channels where sender pattern filtering applies. */
  private filteredChannels = new Set(['gmail']);

  process(msg: InboundMessage): StageVerdict {
    // Sender pattern filtering (email only — SMS/Messenger senders are real people)
    if (this.filteredChannels.has(msg.channel)) {
      const lower = msg.sender.toLowerCase();
      if (IGNORE_SENDER_PATTERNS.some(p => lower.includes(p))) {
        logger.debug({ from: msg.sender, channel: msg.channel }, 'Blocked by sender pattern');
        return { action: 'reject', reason: `sender pattern: ${msg.sender}` };
      }
    }

    // Autoresponder header detection (email only, requires rawHeaders)
    if (msg.rawHeaders) {
      if (isAutoResponse(msg.rawHeaders)) {
        logger.info({ from: msg.sender, subject: msg.subject }, 'Blocked autoresponder email');
        return { action: 'reject', reason: 'autoresponder headers detected' };
      }
    }

    return { action: 'pass' };
  }
}

/** Detect autoresponder emails via standard RFC headers. */
function isAutoResponse(rawHeaders: string): boolean {
  const headers = rawHeaders.toLowerCase();

  // RFC 3834: Auto-Submitted header (any value except "no")
  const autoSub = headers.match(/^auto-submitted:\s*(\S+)/m);
  if (autoSub && autoSub[1] !== 'no') return true;

  // X-Auto-Response-Suppress (Microsoft)
  if (headers.includes('x-auto-response-suppress')) return true;

  // Precedence: bulk/junk/list
  if (/^precedence:\s*(bulk|junk|list)/m.test(headers)) return true;

  // List-Unsubscribe header (mailing lists)
  if (/^list-unsubscribe:/m.test(headers)) return true;

  // Check subject for auto-reply patterns
  const subjectMatch = headers.match(/^subject:\s*(.+)/m);
  if (subjectMatch) {
    const subj = subjectMatch[1].trim();
    if (AUTO_REPLY_SUBJECT_PREFIXES.some(p => subj.startsWith(p))) return true;
  }

  return false;
}
