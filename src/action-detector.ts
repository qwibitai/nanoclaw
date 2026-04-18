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

// Person-name forward: captures 1-3 capitalized words (e.g. "Philip Ye",
// "Dr. Smith", "Alice"). The agent is expected to resolve the name via
// search_contacts when the button is clicked. Requires the question-mark
// suffix so we only fire on actual questions like "Want me to forward X
// to Philip Ye?", not declarative "Forwarded to Philip Ye."
const FORWARD_PERSON_PATTERN =
  /forward[^.]*?to\s+((?:[A-Z][A-Za-z.'-]+)(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s*\??$/im;

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

  // Person-name forward: no email in the question, but the agent named a
  // human. Emit a Yes/No-style button pair that carries the name so the
  // callback handler can tell the agent "resolve this name to an email
  // and forward." Only fires when the email-address forward did not match.
  if (
    !results.some((r) => r.type === 'forward') &&
    FORWARD_PERSON_PATTERN.test(tail)
  ) {
    const match = tail.match(FORWARD_PERSON_PATTERN);
    const person = match?.[1]?.trim();
    // Reject single-word matches that are common false positives (e.g. "Yes",
    // "Here"). Require either 2+ words OR explicit contact-like suffix.
    const multiWord = person && /\s/.test(person);
    if (person && multiWord) {
      const aid = nextActionId();
      const shortName = person.length > 25 ? person.slice(0, 22) + '…' : person;
      results.push({
        type: 'forward',
        recipient: person,
        actions: [
          {
            label: `📨 Forward to ${shortName}`,
            callbackData: `forward_person:${aid}:${encodeURIComponent(person)}`,
            style: 'primary',
          },
          {
            label: '❌ No',
            callbackData: `answer:${aid}:no`,
            style: 'destructive-safe',
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
