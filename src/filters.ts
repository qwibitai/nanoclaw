/**
 * Centralized configuration for all message filtering.
 * ONE file to edit when adding patterns, keywords, or adjusting limits.
 */

// ── Sender patterns to ignore (automated/noreply/service accounts) ──
export const IGNORE_SENDER_PATTERNS = [
  // Generic automated senders
  'noreply@', 'no-reply@', 'donotreply@', 'do-not-reply@',
  'notify@', 'notification@', 'notifications@', 'alert@', 'alerts@',
  'mailer-daemon@', 'postmaster@',
  'service@', 'support@', 'ticket@', 'tickets@',
  'billing@', 'invoice@', 'receipt@', 'order@',
  'newsletter@', 'news@', 'marketing@', 'promo@',
  'bounce@', 'daemon@',
  // Domain patterns
  '@notify.', '@noreply.', '@messaging.',
  // Known automated senders
  'drive-shares-dm-noreply@', 'calendar-notification@',
  '@google.com', '@cloudflare.com', '@squareup.com',
  '@github.com', '@linkedin.com', '@facebookmail.com',
  '@ipostal1.com', '@mailchimp.com',
  '@sendgrid.net', '@amazonses.com', '@contaboserver.net',
];

// ── Business-relevant keywords (emails without these are skipped) ──
// Uses regex with word boundaries to prevent substring false positives.
export const BUSINESS_KEYWORDS: RegExp[] = [
  // Snak Group / Vending (specific phrases)
  /\bvending\b/i, /\bsnack\s*(machine|service)\b/i, /\bcoffee\s*(machine|service)\b/i,
  /\bice\s*machine\b/i, /\bbreakroom\b/i, /\bbreak\s*room\b/i,
  /\bsnak\s*group\b/i, /\bsnakgroup\b/i,
  // Sheridan Rentals (word-boundary)
  /\bsheridan\b/i, /\btrailer\s*(rental|rent)\b/i, /\brv\s*(rental|rent)\b/i,
  /\bcamper\b/i, /\btow(ing|ed|able)\b/i,
  // Bookings / Service (specific phrases)
  /\bbooking\b/i, /\breservation\b/i, /\bavailability\b/i,
  /\bpickup\b/i, /\bdrop[\s-]?off\b/i,
  /\bquote\b/i, /\bestimate\b/i, /\bpricing\b/i,
  // Customer intent (specific to business inquiries)
  /\binquiry\b/i, /\brestock\b/i, /\bmaintenance\b/i,
  /\bvending\s*service\b/i, /\brental\b/i,
  /\binstallation\b/i,
];

// ── Error patterns that must NEVER be sent to customers ──
export const ERROR_PATTERNS: RegExp[] = [
  // API/billing errors
  /credit.{0,30}(low|insufficient|depleted)/i,
  /daily spend cap reached/i,
  /insufficient.{0,20}(quota|credits?|funds?|balance)/i,
  /billing.{0,20}(not active|inactive|suspended|disabled)/i,

  // Rate limiting / overload
  /rate.?limit.{0,20}(error|exceeded|reached)/i,
  /overloaded.?error/i,
  /too many requests/i,
  /429\b.*retry/i,

  // Infrastructure errors
  /container.{0,20}(timed? ?out|failed|crashed|killed)/i,
  /connection.{0,20}(reset|refused|timed? ?out)/i,
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT/i,
  /5[0-9]{2}\s+(internal|bad gateway|service unavailable|gateway time)/i,

  // Auth errors
  /authentication.{0,20}(error|failed|invalid)/i,
  /api.?key.{0,20}(invalid|expired|revoked)/i,
  /unauthorized|forbidden/i,

  // Generic error wrappers (only if the ENTIRE message is an error)
  /^(error|failed|an error occurred)[:\s]/i,
  /^I('m| am) (unable|not able) to process/i,
  /please try again later/i,
];

// ── Rate limits (per-channel and global) ──
export const RATE_LIMITS = {
  /** Global per-JID outbound limits (main group exempt). */
  outbound: { perHour: 5, perDay: 20 },
  /** Per-sender/recipient limits by channel. */
  email:     { perHour: 2, perDay: 10 },
  sms:       { perHour: 3, perDay: 15 },
  messenger: { perHour: 3, perDay: 15 },
  web:       { perHour: 10, perDay: 50 },
  whatsapp:  { perHour: 10, perDay: 50 },
  /** Inbound webhook IP rate limit. */
  webhookPerIp: { perMinute: 30 },
  /** Outbound dedup window. */
  dedup: { windowMs: 30_000, maxCache: 5000 },
  /** Reply-loop detection thresholds. */
  replyLoop: { maxRoundTrips: 3, windowMs: 10 * 60_000 },
} as const;

// ── Complaint detection (any customer issue — always notify owner) ──
export const COMPLAINT_PATTERNS: RegExp[] = [
  // Vending machine issues
  /\b(didn.?t (dispense|vend|open|work)|stuck|jammed|won.?t open|nothing came out)\b/i,
  /\b(stale|expired|old|gross|nasty|moldy|bad taste)\b/i,
  /\b(charged|took my money|ate my (money|dollar|card)|double.?charged)\b/i,
  /\b(refund|money back|get my money|want my money)\b/i,
  /\b(wrong (item|product|snack|drink)|got .{0,20} instead)\b/i,
  /\b(too expensive|overpriced|price is (too )?high|rip.?off)\b/i,
  // Equipment / rental issues
  /\b(damaged|not working|broke down|flat tire|won.?t start|malfunction)\b/i,
  // General dissatisfaction (higher bar than before — avoids false positives)
  /\b(furious|livid|unacceptable|worst experience|terrible service|horrible)\b/i,
  /\b(lawyer|attorney|sue|legal action|bbb|better business bureau)\b/i,
  /\b(chargeback|dispute|overcharged|fraud|scam)\b/i,
];

// ── Autoresponder subject prefixes ──
export const AUTO_REPLY_SUBJECT_PREFIXES = [
  'auto:', 'automatic reply:', 'out of office:',
  'delivery status notification', 'undeliverable:',
];
