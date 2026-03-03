/**
 * Gmail (IMAP) Channel
 * Polls Gmail via IMAP for new unread emails, delivers them as inbound messages.
 * Sends replies via nodemailer SMTP.
 * JID format: email:address@domain.com (the business email address)
 */
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

import {
  ASSISTANT_NAME,
  GMAIL_POLL_INTERVAL,
  IMAP_HOST,
  IMAP_PORT,
  IMAP_USER,
  IMAP_PASS,
  EMAIL_SNAK_ADDRESS,
} from '../config.js';
import { getLastSender, messageExists } from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { readEnvFile } from '../env.js';

/**
 * Map recipient domain -> email JID override.
 * When an inbound email's To/Delivered-To header matches a domain here,
 * route it to the corresponding JID instead of the default.
 */
const EMAIL_ALIAS_ROUTING: Record<string, string> = {
  'sheridantrailerrentals.us': 'email:info@sheridantrailerrentals.us',
};

export interface GmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/** Track processed email UIDs to avoid duplicates within a single process lifetime. */
const processedUids = new Set<number>();
const MAX_PROCESSED_CACHE = 5000;

export class GmailChannel implements Channel {
  name = 'gmail';

  private connected = false;
  private opts: GmailChannelOpts;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private transporter: nodemailer.Transporter | null = null;

  /** Map email JID -> last inbound email context for reply routing. */
  private lastInboundByJid = new Map<string, { email: string; subject: string }>();

  constructor(opts: GmailChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Set up SMTP transporter for sending replies
    const smtpEnv = readEnvFile(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM']);
    if (smtpEnv.SMTP_HOST && smtpEnv.SMTP_USER) {
      this.transporter = nodemailer.createTransport({
        host: smtpEnv.SMTP_HOST,
        port: parseInt(smtpEnv.SMTP_PORT || '587', 10),
        secure: parseInt(smtpEnv.SMTP_PORT || '587', 10) === 465,
        auth: {
          user: smtpEnv.SMTP_USER,
          pass: smtpEnv.SMTP_PASS || '',
        },
      });
    } else {
      // Fall back to Gmail SMTP with IMAP credentials
      this.transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: {
          user: IMAP_USER,
          pass: IMAP_PASS,
        },
      });
    }

    // Verify IMAP connection
    const client = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: true,
      auth: {
        user: IMAP_USER,
        pass: IMAP_PASS,
      },
      logger: false,
    });

    try {
      await client.connect();
      this.connected = true;
      logger.info({ user: IMAP_USER }, 'Gmail IMAP connected');
      await client.logout();
    } catch (err) {
      logger.error({ err, user: IMAP_USER }, 'Gmail IMAP connection failed');
      throw err;
    }

    // Start polling
    this.startPolling();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.transporter) {
      logger.warn({ jid }, 'No SMTP transporter configured for Gmail replies');
      return;
    }

    let replyContext = this.lastInboundByJid.get(jid);
    if (!replyContext) {
      // Fallback: look up last sender from DB
      const dbSender = getLastSender(jid);
      if (dbSender) {
        replyContext = { email: dbSender, subject: 'Your inquiry' };
      }
    }
    if (!replyContext) {
      logger.warn({ jid }, 'No customer email known for Gmail reply');
      return;
    }

    // Use the alias address if the JID maps to one, otherwise default
    const jidAddress = jid.replace('email:', '');
    const isAlias = Object.values(EMAIL_ALIAS_ROUTING).includes(jid);
    const fromAddress = isAlias ? jidAddress : (EMAIL_SNAK_ADDRESS || IMAP_USER);
    const fromLabel = jid.includes('sheridantrailerrentals') ? 'Sheridan Trailer Rentals' : `${ASSISTANT_NAME} - Snak Group`;
    const replySubject = replyContext.subject.startsWith('Re: ')
      ? replyContext.subject
      : `Re: ${replyContext.subject}`;

    try {
      await this.transporter.sendMail({
        from: `${fromLabel} <${fromAddress}>`,
        to: replyContext.email,
        subject: replySubject,
        text,
      });
      logger.info({ jid, to: replyContext.email, subject: replySubject, length: text.length }, 'Gmail reply sent');
    } catch (err) {
      logger.error({ jid, err }, 'Gmail send error');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('email:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ── Polling ──────────────────────────────────────────────────────

  private startPolling(): void {
    logger.info(
      { intervalMs: GMAIL_POLL_INTERVAL, user: IMAP_USER },
      'Gmail polling started',
    );

    // Initial poll after short delay
    setTimeout(() => this.pollInbox(), 5000);

    this.pollTimer = setInterval(() => this.pollInbox(), GMAIL_POLL_INTERVAL);
  }

  /** Track the highest UID we've seen so we only process newer messages. */
  private lastSeenUid = 0;

  private async pollInbox(): Promise<void> {
    const client = new ImapFlow({
      host: IMAP_HOST,
      port: IMAP_PORT,
      secure: true,
      auth: {
        user: IMAP_USER,
        pass: IMAP_PASS,
      },
      logger: false,
    });

    try {
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');

      try {
        // Search for messages by UID range instead of unseen flag.
        // Gmail auto-marks emails as read when another message in the same
        // thread is read, so unseen-only search misses legitimate new emails.
        let uids: number[];
        if (this.lastSeenUid > 0) {
          // Fetch messages with UID greater than our last seen
          const searchResult = await client.search(
            { uid: `${this.lastSeenUid + 1}:*` },
            { uid: true },
          );
          uids = (Array.isArray(searchResult) ? searchResult : [])
            .filter(uid => uid > this.lastSeenUid);
        } else {
          // First poll: only get unseen to avoid re-processing old mail
          const searchResult = await client.search({ seen: false }, { uid: true });
          uids = Array.isArray(searchResult) ? searchResult : [];
          // Set lastSeenUid to highest UID in mailbox so future polls only get new mail
          if (uids.length === 0) {
            const allUids = await client.search({ all: true }, { uid: true });
            const allArr = Array.isArray(allUids) ? allUids : [];
            if (allArr.length > 0) {
              this.lastSeenUid = Math.max(...allArr);
              logger.debug({ lastSeenUid: this.lastSeenUid }, 'Gmail initial UID baseline set');
            }
            return;
          }
        }

        if (uids.length === 0) return;

        for (const uid of uids) {
          if (processedUids.has(uid)) continue;

          try {
            // CRITICAL: Mark as read FIRST, before any processing.
            // This prevents re-processing if the service restarts mid-handling.
            await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });

            const message = await client.fetchOne(
              String(uid),
              { envelope: true, source: true, uid: true },
              { uid: true },
            );

            if (!message || !message.envelope) {
              processedUids.add(uid);
              continue;
            }

            const envelope = message.envelope;
            const from = envelope.from?.[0];
            if (!from) {
              processedUids.add(uid);
              continue;
            }

            const senderEmail = (from.address || '').toLowerCase();
            const senderName = from.name || senderEmail;
            const subject = envelope.subject || '(no subject)';
            const messageId = envelope.messageId || `uid-${uid}`;
            const date = envelope.date?.toISOString() || new Date().toISOString();

            // Skip spam, newsletters, bounces, marketing emails
            const rawHeaders = message.source ? message.source.toString('utf-8').split('\r\n\r\n')[0] : '';
            if (shouldSkipEmail(senderEmail, senderName, subject, rawHeaders)) {
              logger.debug({ from: senderEmail, subject, uid }, 'Skipping non-customer email');
              processedUids.add(uid);
              continue;
            }

            // Skip emails from ourselves (case-insensitive, check multiple patterns)
            const selfAddresses = [
              IMAP_USER.toLowerCase(),
              EMAIL_SNAK_ADDRESS.toLowerCase(),
              ...Object.values(EMAIL_ALIAS_ROUTING).map(j => j.replace('email:', '')),
            ].filter(Boolean);
            if (selfAddresses.some(a => senderEmail === a)) {
              processedUids.add(uid);
              continue;
            }

            // Also skip if sender name contains our assistant name (Gmail rewrites From headers)
            if (ASSISTANT_NAME && senderName.toLowerCase().includes(ASSISTANT_NAME.toLowerCase())) {
              processedUids.add(uid);
              continue;
            }

            // DB-level dedup: skip if this messageId was already stored (survives restarts)
            if (messageExists(messageId)) {
              logger.debug({ messageId, uid }, 'Email already processed (DB dedup), skipping');
              processedUids.add(uid);
              continue;
            }

            // Extract plain text body from source
            let body = '';
            if (message.source) {
              body = extractTextFromSource(message.source);
            }

            // Determine the JID based on recipient address
            // Check To/Delivered-To for alias domain routing
            const toAddresses = [
              ...(envelope.to || []).map((a: any) => (a.address || '').toLowerCase()),
              ...(envelope.cc || []).map((a: any) => (a.address || '').toLowerCase()),
            ];
            let jid = `email:${EMAIL_SNAK_ADDRESS || IMAP_USER}`; // default
            for (const [domain, aliasJid] of Object.entries(EMAIL_ALIAS_ROUTING)) {
              if (toAddresses.some(a => a.endsWith('@' + domain))) {
                jid = aliasJid;
                break;
              }
            }

            // Track sender + subject for reply routing
            this.lastInboundByJid.set(jid, { email: senderEmail, subject });

            processedUids.add(uid);

            // Track highest UID for next poll
            if (uid > this.lastSeenUid) this.lastSeenUid = uid;

            // Cap processed cache
            if (processedUids.size > MAX_PROCESSED_CACHE) {
              const entries = [...processedUids];
              processedUids.clear();
              for (const e of entries.slice(-2500)) processedUids.add(e);
            }

            logger.info(
              { from: senderEmail, subject, uid, messageId },
              'Gmail inbound email',
            );

            // Update chat metadata
            this.opts.onChatMetadata(jid, date, `Email ${EMAIL_SNAK_ADDRESS || IMAP_USER}`);

            // Only deliver to registered groups
            const groups = this.opts.registeredGroups();
            if (!groups[jid]) {
              logger.debug({ jid }, 'Email JID not registered, skipping');
              continue;
            }

            const content = `Email from ${senderName} <${senderEmail}>\nSubject: ${subject}\n\n${body}`;

            const newMsg: NewMessage = {
              id: messageId,
              chat_jid: jid,
              sender: senderEmail,
              sender_name: senderName,
              content,
              timestamp: date,
              is_from_me: false,
              is_bot_message: false,
            };

            this.opts.onMessage(jid, newMsg);
          } catch (msgErr) {
            logger.warn({ uid, err: msgErr }, 'Failed to process email');
          }
        }
      } finally {
        lock.release();
      }
    } catch (err) {
      logger.warn({ err }, 'Gmail poll error');
    } finally {
      try {
        await client.logout();
      } catch { /* ignore */ }
    }
  }
}

/**
 * Returns true if the email should be skipped (spam, newsletter, bounce, marketing).
 */
function shouldSkipEmail(senderEmail: string, senderName: string, subject: string, headers?: string): boolean {
  const addr = senderEmail.toLowerCase();
  const subj = subject.toLowerCase();

  // Bounce / delivery status
  if (addr.startsWith('mailer-daemon@') || addr.startsWith('postmaster@')) return true;
  if (subj.includes('delivery status notification')) return true;
  if (subj.includes('undeliverable') || subj.includes('mail delivery failed')) return true;

  // No-reply / automated senders
  if (addr.startsWith('noreply@') || addr.startsWith('no-reply@') || addr.startsWith('no_reply@')) return true;
  if (addr.startsWith('donotreply@') || addr.startsWith('do-not-reply@')) return true;

  // Common newsletter/marketing domains
  const spamDomains = [
    'amazonses.com', 'sendgrid.net', 'mailchimp.com', 'constantcontact.com',
    'hubspot.com', 'marketo.com', 'pardot.com', 'campaign-archive.com',
    'engage.canva.com', 'postcardmania.com', 'newsletters.fubo.tv',
    'shopifyemail.com', 'messaging.squareup.com', 'googlemail.com',
    'mail.chevronmobileapp.com',
  ];
  if (spamDomains.some(d => addr.endsWith('@' + d) || addr.endsWith('.' + d))) return true;

  // Common newsletter patterns in sender address
  const newsletterPatterns = [
    'newsletter', 'marketing', 'promo', 'campaign', 'digest',
    'notifications@', 'updates@', 'info@', 'news@', 'store+',
    'stream@', 'offers@', 'deals@', 'sales@',
  ];
  if (newsletterPatterns.some(p => addr.includes(p))) return true;

  // Unsubscribe indicator in subject
  if (subj.includes('unsubscribe')) return true;

  // Headers-based check: List-Unsubscribe header is a strong newsletter indicator
  if (headers && /list-unsubscribe/i.test(headers)) return true;

  return false;
}

/**
 * Extract plain text body from raw email source.
 * Handles plain text emails and the text/plain part of multipart.
 */
function extractTextFromSource(source: Buffer): string {
  const raw = source.toString('utf-8');

  // Find the boundary between headers and body
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd === -1) return raw.slice(0, 2000);

  const headers = raw.slice(0, headerEnd).toLowerCase();
  const bodyPart = raw.slice(headerEnd + 4);

  // If it is a simple text/plain email
  if (headers.includes('content-type: text/plain') || !headers.includes('content-type: multipart')) {
    if (headers.includes('content-transfer-encoding: base64')) {
      try {
        return Buffer.from(bodyPart.replace(/\s/g, ''), 'base64').toString('utf-8').slice(0, 4000);
      } catch {
        return bodyPart.slice(0, 4000);
      }
    }
    // Strip quoted-printable soft line breaks
    return bodyPart
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
      .slice(0, 4000);
  }

  // Multipart: find the text/plain part
  const boundaryMatch = headers.match(/boundary="?([^"\s;]+)"?/);
  if (!boundaryMatch) return bodyPart.slice(0, 4000);

  const boundary = boundaryMatch[1];
  const parts = bodyPart.split(`--${boundary}`);

  for (const part of parts) {
    const partHeaderEnd = part.indexOf('\r\n\r\n');
    if (partHeaderEnd === -1) continue;
    const partHeaders = part.slice(0, partHeaderEnd).toLowerCase();
    if (partHeaders.includes('text/plain')) {
      const partBody = part.slice(partHeaderEnd + 4);
      const cleanBody = partBody.replace(/--\r?\n?$/, '').trim();
      if (partHeaders.includes('content-transfer-encoding: base64')) {
        try {
          return Buffer.from(cleanBody.replace(/\s/g, ''), 'base64').toString('utf-8').slice(0, 4000);
        } catch {
          return cleanBody.slice(0, 4000);
        }
      }
      return cleanBody
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
        .slice(0, 4000);
    }
  }

  // Fallback: return first 2000 chars of body
  return bodyPart.slice(0, 2000);
}
