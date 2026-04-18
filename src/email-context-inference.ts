/**
 * Heuristic extraction of email context (Gmail thread_id + account) from
 * free-form agent output. Agents don't always remember to pass email_id /
 * email_account to send_message — the email-trigger prompt describes emails
 * as `[personal] From: x, Subject: y (thread: abc123)`, and agents often
 * echo that format back. This module scrapes those markers so the host can
 * attach Expand / Full Email / Archive buttons even when the agent forgot
 * the explicit arguments.
 *
 * Only fires when the text unambiguously names a SINGLE thread. If multiple
 * thread ids appear, we can't know which one the buttons should target —
 * returns null and the agent's explicit arguments (if any) win.
 */

export interface InferredEmailContext {
  emailId: string;
  emailAccount?: string;
}

// Matches patterns like:
//   (thread: abc123)
//   thread: abc123
//   thread_id: abc123
//   (threadId: abc123)
// Thread ids are hex/alphanumeric; capture up to the first non-[A-Za-z0-9_-].
const THREAD_ID_RE =
  /thread[\s_]?id\s*[:=]\s*([A-Za-z0-9_-]+)|thread\s*[:=]\s*([A-Za-z0-9_-]+)/gi;

// Account usually appears as `[personal]` or `[whoisxml]` in the trigger
// summary format the agent parrots back. Match on known-safe alphanumeric
// shortnames only — avoid catching arbitrary bracketed text.
const ACCOUNT_RE = /\[([a-z][a-z0-9_-]{1,24})\]/g;

const ACCOUNT_BLOCKLIST = new Set([
  'email',
  'personal', // still allowed — just a hint this is a likely match
  'internal',
  'debug',
  'warn',
  'info',
  'error',
]);

export function inferEmailContext(text: string): InferredEmailContext | null {
  if (!text) return null;

  // Gather unique thread ids.
  const ids = new Set<string>();
  for (const m of text.matchAll(THREAD_ID_RE)) {
    const id = m[1] ?? m[2];
    // Ignore very short matches — "thread: it" would hit otherwise. Real
    // Gmail thread ids are typically 16+ hex chars.
    if (id && id.length >= 8) ids.add(id);
  }
  if (ids.size !== 1) return null;
  const emailId = [...ids][0];

  // Gather plausible account tags. If multiple distinct accounts appear we
  // can't disambiguate — return the emailId without an account. If exactly
  // one appears and it's not an obvious false-positive word, use it.
  const accounts = new Set<string>();
  for (const m of text.matchAll(ACCOUNT_RE)) {
    const acct = m[1];
    if (!ACCOUNT_BLOCKLIST.has(acct) || acct === 'personal') {
      accounts.add(acct);
    }
  }
  const emailAccount = accounts.size === 1 ? [...accounts][0] : undefined;

  return { emailId, emailAccount };
}
