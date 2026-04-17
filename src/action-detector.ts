import type { Action, MessageMeta } from './types.js';

export interface DetectedAction {
  type: 'forward' | 'rsvp' | 'open_url';
  actions: Action[];
  recipient?: string;
  eventTitle?: string;
}

let actionCounter = 0;

function nextActionId(): string {
  return `act_${Date.now()}_${++actionCounter}`;
}

const FORWARD_PATTERN = /forward.*?to\s+(\S+@\S+)/i;
const FORWARD_ALT_PATTERN = /forward\s+(?:this|it)\s+to\s+(\S+@\S+)/i;

const RSVP_PATTERNS = [
  /RSVP\b/i,
  /want to attend/i,
  /like to attend/i,
  /going to (?:the|this)/i,
  /shall I (?:RSVP|accept|confirm)/i,
];

// Patterns that describe the link (passive — suppressed when forward already present)
const OPEN_URL_PASSIVE_PATTERNS = [/magic.*link/i, /sign-?in.*link/i];
// Patterns that explicitly request opening (active — kept even alongside forward)
const OPEN_URL_ACTIVE_PATTERNS = [
  /click.*(?:link|it|this)/i,
  /open.*(?:link|it|this|URL)/i,
];

/**
 * Detect actionable items in agent output text and return structured buttons.
 * Actions take priority over generic Yes/No from question-detector.
 */
export function detectActions(
  text: string,
  meta: MessageMeta,
): DetectedAction[] {
  const results: DetectedAction[] = [];
  const tail = text.slice(-500);

  // Forward detection — requires threadId + email recipient
  if (meta.threadId) {
    const fwdMatch =
      tail.match(FORWARD_PATTERN) || tail.match(FORWARD_ALT_PATTERN);
    if (fwdMatch) {
      const recipient = fwdMatch[1].replace(/[?.!,;)]+$/, ''); // strip trailing punctuation
      const account = meta.account || '';
      results.push({
        type: 'forward',
        recipient,
        actions: [
          {
            label: `📨 Forward to ${recipient.length > 25 ? recipient.slice(0, 22) + '...' : recipient}`,
            callbackData: `forward:${meta.threadId}:${recipient}:${account}`,
            style: 'primary',
          },
        ],
      });
    }
  }

  // RSVP detection
  if (RSVP_PATTERNS.some((p) => p.test(tail))) {
    const aid = nextActionId();
    results.push({
      type: 'rsvp',
      actions: [
        {
          label: '✅ RSVP Yes',
          callbackData: `rsvp:${aid}:accepted`,
          style: 'primary',
        },
        {
          label: '❌ Decline',
          callbackData: `rsvp:${aid}:declined`,
          style: 'destructive-safe',
        },
      ],
    });
  }

  // Open URL detection:
  // Active patterns (explicit click/open request) always emit a button.
  // Passive patterns (magic link / sign-in link description) are suppressed
  // when a forward action is already present — the link is being forwarded, not opened.
  const alreadyHasForward = results.some((r) => r.type === 'forward');
  const hasActiveOpenUrl = OPEN_URL_ACTIVE_PATTERNS.some((p) => p.test(tail));
  const hasPassiveOpenUrl =
    !alreadyHasForward && OPEN_URL_PASSIVE_PATTERNS.some((p) => p.test(tail));
  if (hasActiveOpenUrl || hasPassiveOpenUrl) {
    const aid = nextActionId();
    results.push({
      type: 'open_url',
      actions: [
        {
          label: '🔗 Open Link',
          callbackData: `open_url:${aid}`,
          style: 'primary',
        },
      ],
    });
  }

  return results;
}
