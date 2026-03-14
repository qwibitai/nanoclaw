/**
 * Gmail (IMAP) Channel — thin I/O adapter
 * Polls Gmail via IMAP for new unread emails, delivers them as inbound messages.
 * Sends replies via nodemailer SMTP.
 * JID format: email:address@domain.com:sender@domain.com (per-sender isolation)
 *
 * All filtering (ignore patterns, autoresponder detection, business relevance,
 * rate limiting, in-memory dedup) is handled by the shared inbound pipeline.
 */
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

import { CircuitBreaker } from '../circuit-breaker.js';
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
  HealthInfo,
  NewMessage,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';
import { readEnvFile } from '../env.js';

export interface GmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerDerivedGroup?: (childJid: string, parentJid: string) => void;
  /** Pipeline filter: return false to skip the message before delivery. */
  shouldProcess?: (msg: {
    id: string;
    sender: string;
    content: string;
    channel: string;
    rawHeaders?: string;
    subject?: string;
  }) => boolean;
}

export class GmailChannel implements Channel {
  name = 'gmail';

  private connected = false;
  private opts: GmailChannelOpts;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private transporter: nodemailer.Transporter | null = null;
  private imapBreaker = new CircuitBreaker('gmail-imap', { maxFailures: 3, resetMs: 30_000, maxBackoffMs: 300_000 });
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Map email JID -> last sender address for reply routing. */
  private lastSenderByJid = new Map<string, string>();

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

    // Verify IMAP connection (wrapped in circuit breaker — never throws)
    await this.attemptImapConnect();

    // Start polling (runs even if IMAP is down — pollInbox checks connected flag)
    this.startPolling();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.transporter) {
      logger.warn({ jid }, 'No SMTP transporter configured for Gmail replies');
      return;
    }

    // Parse customer email from per-sender JID (email:biz:sender)
    const jidParts = jid.split(':');
    let customerEmail: string | undefined;
    if (jidParts.length >= 3) {
      customerEmail = jidParts.slice(2).join(':'); // handle colons in email (unlikely but safe)
    }

    if (!customerEmail) {
      // Fallback for old-format JIDs (email:biz)
      customerEmail = this.lastSenderByJid.get(jid);
      if (!customerEmail) {
        customerEmail = getLastSender(jid) ?? undefined;
        if (customerEmail) {
          this.lastSenderByJid.set(jid, customerEmail);
        }
      }
    }
    if (!customerEmail) {
      logger.warn({ jid }, 'No customer email known for Gmail reply');
      return;
    }

    const fromAddress = EMAIL_SNAK_ADDRESS || IMAP_USER;

    // Sanitize header values to prevent email header injection
    const safeName = ASSISTANT_NAME.replace(/[\r\n\x00-\x1f]/g, '');
    const safeCustomerEmail = customerEmail.trim();
    if (/[\r\n,;]/.test(safeCustomerEmail) || safeCustomerEmail.includes(' ')) {
      logger.warn({ jid, customerEmail }, 'Invalid customer email address, refusing to send');
      return;
    }

    try {
      await this.transporter.sendMail({
        from: `${safeName} - Snak Group <${fromAddress}>`,
        to: safeCustomerEmail,
        subject: 'Re: Your inquiry',
        text,
      });
      logger.info({ jid, to: customerEmail, length: text.length }, 'Gmail reply sent');
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

  getHealthInfo(): HealthInfo {
    return {
      connected: this.connected,
      lastConnectedAt: null,
      recentDisconnects: [],
      protocolErrorCount: 0,
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ── IMAP Connection & Reconnection ──────────────────────────────

  private async attemptImapConnect(): Promise<void> {
    if (this.imapBreaker.state === 'open') {
      logger.warn({ breaker: 'gmail-imap' }, 'IMAP circuit breaker open, skipping connection attempt');
      this.connected = false;
      this.scheduleReconnect();
      return;
    }

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
      await this.imapBreaker.call(async () => {
        await client.connect();
        await client.logout();
      });
      this.connected = true;
      logger.info({ user: IMAP_USER }, 'Gmail IMAP connected');
    } catch (err) {
      logger.error({ err, user: IMAP_USER }, 'Gmail IMAP connection failed');
      this.connected = false;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return; // prevent stacking

    const delayMs = this.imapBreaker.backoffMs;
    logger.info({ delayMs }, 'Gmail IMAP scheduling reconnect');
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.attemptImapConnect();
    }, delayMs);
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

  private async pollInbox(): Promise<void> {
    if (!this.connected) {
      logger.debug('Gmail IMAP not connected, skipping poll');
      this.scheduleReconnect();
      return;
    }

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
        // Search for unseen messages
        const searchResult = await client.search({ seen: false }, { uid: true });
        const uids = Array.isArray(searchResult) ? searchResult : [];

        if (uids.length === 0) return;

        for (const uid of uids) {
          try {
            const message = await client.fetchOne(
              String(uid),
              { envelope: true, source: true, uid: true },
              { uid: true },
            );

            if (!message || !message.envelope) continue;

            const envelope = message.envelope;
            const from = envelope.from?.[0];
            if (!from) continue;

            const senderEmail = (from.address || '').toLowerCase();
            const senderName = from.name || senderEmail;
            const subject = envelope.subject || '(no subject)';
            const messageId = envelope.messageId || `uid-${uid}`;
            const date = envelope.date?.toISOString() || new Date().toISOString();

            // Skip emails from ourselves (case-insensitive, check multiple patterns)
            const selfAddresses = [
              IMAP_USER.toLowerCase(),
              EMAIL_SNAK_ADDRESS.toLowerCase(),
            ].filter(Boolean);
            if (selfAddresses.some(a => senderEmail === a)) continue;

            // Also skip if sender name contains our assistant name (Gmail rewrites From headers)
            if (ASSISTANT_NAME && senderName.toLowerCase().includes(ASSISTANT_NAME.toLowerCase())) {
              continue;
            }

            // DB-level dedup: skip if this messageId was already stored (survives restarts)
            if (messageExists(messageId)) {
              logger.debug({ messageId, uid }, 'Email already processed (DB dedup), skipping');
              continue;
            }

            // Determine the JID — per-sender isolation
            const baseJid = `email:${EMAIL_SNAK_ADDRESS || IMAP_USER}`;
            const jid = `${baseJid}:${senderEmail}`;

            // Track sender for reply routing (fallback for old-format JIDs)
            this.lastSenderByJid.set(jid, senderEmail);

            // Extract raw headers and body from source
            let rawHeaders = '';
            let body = '';
            if (message.source) {
              const raw = message.source.toString('utf-8');
              const headerEnd = raw.indexOf('\r\n\r\n');
              if (headerEnd !== -1) {
                rawHeaders = raw.slice(0, headerEnd);
              }
              body = extractTextFromSource(message.source);
            }

            const content = `Email from ${senderName} <${senderEmail}>\nSubject: ${subject}\n\n${body}`;

            // Pipeline filter: let index.ts decide whether to process this message
            if (this.opts.shouldProcess) {
              const shouldProcess = this.opts.shouldProcess({
                id: messageId,
                sender: senderEmail,
                content,
                channel: 'gmail',
                rawHeaders,
                subject,
              });
              if (!shouldProcess) {
                logger.debug({ from: senderEmail, subject }, 'Message rejected by pipeline filter');
                continue;
              }
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
              // Auto-register per-sender JID from parent if parent is registered
              if (groups[baseJid] && this.opts.registerDerivedGroup) {
                this.opts.registerDerivedGroup(jid, baseJid);
              } else {
                logger.debug({ jid }, 'Email JID not registered, skipping');
                continue;
              }
            }

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

            // Mark as read AFTER successful processing.
            // If processing throws, the email stays unread and gets retried on next poll.
            await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          } catch (msgErr) {
            logger.warn({ uid, err: msgErr }, 'Failed to process email — leaving unread for retry');
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
