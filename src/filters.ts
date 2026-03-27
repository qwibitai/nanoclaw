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
  // Marketing / sales / cold outreach senders
  '@hubspot.com', '@hubspotmail.com', '@hs-analytics.net',
  '@salesforce.com', '@pardot.com',
  '@constantcontact.com', '@ctctmail.com',
  '@campaign-archive.com', '@list-manage.com',
  '@drip.com', '@convertkit.com', '@beehiiv.com',
  '@substack.com', '@klaviyo.com', '@brevo.com',
  '@sendinblue.com', '@activecampaign.com',
  '@smartlead-team.com', '@smartlead.ai',
  '@lemlist.com', '@woodpecker.co', '@reply.io',
  '@outreach.io', '@salesloft.com', '@apollo.io',
  '@zoominfo.com', '@lusha.com', '@seamless.ai',
  '@intercom.io', '@zendesk.com', '@freshdesk.com',
  '@shopifyemail.com', '@shopify.com',
  '@wordfence.com', '@wordpress.com', '@wp.com',
  '@fubo.tv', '@newsletters.',
  'productmarketing@', 'growth@',
  // Service providers (variant domains)
  '@canva.com', '@engage.canva.com', '@mail.canva.com',
  '@ipostal.com', '@mail.ipostal1.com',
  '@contabo.com', '@contabo.de',
  '@em1.cloudflare.com', '@notify.cloudflare.com',
  '@tawk.to',
  '@10web.io',
  '@link.com', '@e.link.com',
  '@postcardmania.com',
  '@onlinejobs.ph',
  '@newsletters.fubo.tv',
  '@chevronmobileapp.com',
  // Payment/billing (we use Square, these are just receipts)
  '@messaging.squareup.com', '@invoicing.squareup.com',
  '@paypal.com', '@news.paypal.com', '@mail.paypal.com',
  '@stripe.com',
  // Broad patterns that catch most service emails
  '@mail.', '@email.', '@e.', '@em.', '@em1.',
  '@engage.', '@updates.', '@info.', '@news.',
  '@accounts.', '@security.', '@verify.',
  'dmarc@', 'dmarcreport@', 'dmarc-report@',
  'abuse@', 'compliance@', 'security@',
  'feedback@', 'system@', 'admin@', 'webmaster@',
];

// ── Business-relevant keywords (emails without these are skipped) ──
// Uses regex with word boundaries to prevent substring false positives.
export const BUSINESS_KEYWORDS: RegExp[] = [
  // Snak Group / Vending
  /\bvending\b/i, /\bsnack\s*(machine|service)?\b/i, /\bcoffee\s*(machine|service)?\b/i,
  /\bice\s*machine\b/i, /\bbreakroom\b/i, /\bbreak\s*room\b/i,
  /\bsnak\s*group\b/i, /\bsnakgroup\b/i, /\bsnak\b/i,
  /\bsmart\s*cooler\b/i, /\bcooler\b/i,
  /\bIDDI\b/, /\bVitro\b/i,
  // Sheridan Rentals
  /\bsheridan\b/i, /\btrailer\s*(rental|rent)?\b/i, /\brv\s*(rental|rent)?\b/i,
  /\bcamper\b/i, /\btow(ing|ed|able)\b/i,
  /\bcar\s*hauler\b/i, /\blandscaping\s*trailer\b/i,
  // Bookings / Service
  /\bbooking\b/i, /\breservation\b/i, /\bavailability\b/i,
  /\bpickup\b/i, /\bdrop[\s-]?off\b/i,
  /\bquote\b/i, /\bestimate\b/i, /\bpricing\b/i, /\bprice\b/i,
  /\bhow\s*much\b/i, /\bcost\b/i, /\brates?\b/i,
  // Customer intent (real people asking about the business)
  /\binquiry\b/i, /\brestock\b/i, /\bmaintenance\b/i,
  /\bvending\s*service\b/i, /\brental\b/i,
  /\binstallation\b/i, /\binstall\b/i,
  /\binterested\s*(in)?\b/i,
  /\bset\s*up\b/i, /\bget\s*started\b/i,
  /\blearn\s*more\b/i, /\bmore\s*info\b/i, /\binformation\b/i,
  /\bschedule\b/i, /\bappointment\b/i, /\bcall\b/i, /\bmeet(ing)?\b/i,
  /\bcontact\b/i, /\breach\s*out\b/i,
  // Complaint language (must always get through)
  /\brefund\b/i, /\bcharged\b/i, /\bovercharged\b/i,
  /\bcomplaint\b/i, /\bissue\b/i, /\bproblem\b/i,
  /\bnot\s*working\b/i, /\bbroke(n)?\b/i, /\bstuck\b/i,
  /\bmachine\b/i,
  // Reply indicators (customer replying to Andy's previous email)
  /\bthanks?\b/i, /\bsounds?\s*good\b/i, /\byes\b/i, /\byeah\b/i,
  /\bperfect\b/i, /\bgreat\b/i, /\bawesome\b/i,
  /\bok(ay)?\b/i, /\bsure\b/i, /\blet'?s\s*do\b/i,
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
// Limits must support real customer service conversations (multi-turn booking
// flows, owner notifications, follow-ups) without throttling during peak hours.
export const RATE_LIMITS = {
  /** Global per-JID outbound limits (main group exempt). */
  outbound: { perHour: 20, perDay: 80 },
  /** Per-sender/recipient limits by channel. */
  email:     { perHour: 10, perDay: 40 },
  sms:       { perHour: 10, perDay: 40 },
  messenger: { perHour: 15, perDay: 60 },
  web:       { perHour: 20, perDay: 80 },
  whatsapp:  { perHour: 20, perDay: 80 },
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
  // Smart cooler issues
  /\b(hold|pending.{0,10}charge|pre.?auth|authorization)\b.*\b(won.?t|didn.?t|not)\b/i,
  /\b(door.{0,10}(won.?t|didn.?t|not).{0,10}(open|close|unlock))\b/i,
  /\b(card.{0,10}(declined|rejected|not.{0,5}work))\b/i,
  // Equipment / rental issues
  /\b(damaged|not working|broke down|flat tire|won.?t start|malfunction)\b/i,
  /\b(leaking|dirty|filthy|unsanitary|bug|roach|pest)\b/i,
  // General dissatisfaction
  /\b(furious|livid|unacceptable|worst experience|terrible service|horrible)\b/i,
  /\b(disappointed|frustrated|upset|unhappy|dissatisfied)\b/i,
  /\b(lawyer|attorney|sue|legal action|bbb|better business bureau)\b/i,
  /\b(chargeback|dispute|overcharged|fraud|scam)\b/i,
  /\b(cancel|cancellation|terminate|end.{0,5}(contract|service|agreement))\b/i,
  /\b(remove|take.{0,5}(out|away|back)|pick.{0,5}up.{0,5}(machine|equipment))\b/i,
];

// ── High-urgency complaint patterns (owner notified IMMEDIATELY via WhatsApp) ──
export const URGENT_COMPLAINT_PATTERNS: RegExp[] = [
  /\b(lawyer|attorney|sue|legal action|bbb|better business bureau)\b/i,
  /\b(chargeback|dispute|fraud|scam)\b/i,
  /\b(health.{0,10}(department|inspector|violation|hazard))\b/i,
  /\b(police|fire.{0,5}(department|marshal)|osha)\b/i,
  /\b(furious|livid|unacceptable)\b/i,
  /\b(cancel|terminate|remove.{0,10}machine)\b/i,
  /\b(social media|yelp|google review|going public|news|reporter)\b/i,
];

// ── Autoresponder subject prefixes ──
export const AUTO_REPLY_SUBJECT_PREFIXES = [
  'auto:', 'automatic reply:', 'out of office:',
  'delivery status notification', 'undeliverable:',
];

// ── Marketing/sales email subject patterns (skip these — not real customers) ──
export const MARKETING_SUBJECT_PATTERNS: RegExp[] = [
  /\bunsubscribe\b/i,
  /\bwebinar\b/i,
  /\bdemo\s*(request|day|session|slot)\b/i,
  /\bfree\s*trial\b/i,
  /\blimited\s*time\s*offer\b/i,
  /\bexclusive\s*(offer|deal|discount|invitation)\b/i,
  /\b(don.?t miss|last chance|act now|hurry|expires? (soon|today))\b/i,
  /\b(grow your|scale your|boost your|10x|100x)\b/i,
  /\b(cold email|outreach tool|lead gen|sales automation)\b/i,
  /\b(we help (companies|businesses|teams))\b/i,
  /\b(quick question|loved your|saw your (post|company|profile))\b/i,
  /\b(partnership opportunity|collaboration opportunity)\b/i,
  /\b(roi|revenue growth|pipeline)\b.*\b(guaranteed|proven|results)\b/i,
  /\bright (person|contact|team)\b.*\bto (talk|chat|connect|discuss)\b/i,
];

// ── Automated body patterns (detect automated messages even from unknown senders) ──
export const AUTOMATED_BODY_PATTERNS: RegExp[] = [
  /this is an automated (message|email|notification)/i,
  /do not reply to this (message|email)/i,
  /please do not reply/i,
  /this (message|email) was (sent|generated) automatically/i,
  /you('re| are) receiving this (because|email because)/i,
  /this is a (system|service|automated) (notification|alert|message)/i,
  /no-?reply/i,
  /unsubscribe from (these|this|all) (email|notification)/i,
  /manage your (email |notification )?preferences/i,
  /you (have been |were )?(un)?subscribed/i,
  /\bDMARC\b/i,
  /\bSPF\b.*\b(pass|fail|alignment)\b/i,
  /\bDKIM\b.*\b(pass|fail|alignment)\b/i,
  /aggregate report/i,
  /\bxml\.gz\b/i,
];

// ── Automated subject patterns (service/notification subjects, not customer inquiries) ──
export const AUTOMATED_SUBJECT_PATTERNS: RegExp[] = [
  /\b(delivery status|delivery notification|delivery report)\b/i,
  /\b(payment (receipt|confirmation|processed))\b/i,
  /\b(order (confirmation|shipped|delivered))\b/i,
  /\b(invoice #|invoice attached|your invoice)\b/i,
  /\b(account (update|notification|alert|verification))\b/i,
  /\b(password (reset|changed|expir))\b/i,
  /\b(security (alert|notification|update))\b/i,
  /\b(welcome to|thanks for (signing|registering|joining))\b/i,
  /\b(your (subscription|membership|plan|trial))\b/i,
  /\b(system (maintenance|update|notification))\b/i,
  /\b(report for|reporting period|aggregate report)\b/i,
  /\bDMARC\b/i,
  /\b(weekly|monthly|daily) (report|summary|digest|update)\b/i,
  /\bnewsletter\b/i,
  /\bprice (alert|change|update)\b/i,
];
