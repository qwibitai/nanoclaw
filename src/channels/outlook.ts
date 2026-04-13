import { Client } from '@microsoft/microsoft-graph-client';
import { readFileSync } from 'fs';
import { request as httpRequest } from 'http';
import { homedir } from 'os';
import { join } from 'path';

import { CREDENTIAL_PROXY_PORT, DATA_DIR } from '../config.js';
import { closeOpenItemByConversationId, logAudit } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  markConnected,
  markDisconnected,
  markEvent,
} from '../runtime-status.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// Descriptive category vocabulary (what the email IS), matching Gabe's existing
// Outlook master category list. Nano's internal COO triage (CRITICAL, APPROVAL,
// DELEGATE, FYI, IGNORE) is applied separately when generating digests.
// IGNORE is returned when an email is cold outreach, pure noise, or already
// handled. IGNORE emails receive NO category.
const VALID_CATEGORIES = [
  'Needs Response',
  'Approval Required',
  'FYI - Urgent',
  'Waiting for Reply',
  'FYI',
  'Meeting Updates',
  'Notifications',
  'Marketing',
  'Negative Review',
  'Positive Review',
];

const CATEGORY_PROMPT = `You are Gabriel Ratner's inbox categorizer. Gabe is COO of Proper Hospitality, a multi-property hotel group. Classify this incoming email into exactly one category from the table below. Categories describe WHAT the email is, not what to do about it.

| Category | When to use |
|---|---|
| Needs Response | Use ONLY when the email contains a DIRECT ASK of Gabe personally. A direct ask is an explicit question or request addressed to Gabe that requires him to reply with an answer, decision, or action. If the email mentions him but doesn't ask him anything directly, use FYI or another category. This category should be rare and precise. |
| Approval Required | Needs Gabe's sign-off, signature, or explicit decision. Contracts, hires, terminations, PTO above a day, spend approvals. |
| FYI - Urgent | Important info, time-sensitive, Gabe needs to be aware immediately. No direct action required but worth knowing now. |
| Waiting for Reply | A reply came in on a thread where Gabe previously asked something. |
| FYI | Informational, business-relevant, no urgency. Portfolio awareness only. Policy updates, routine status, general communication. |
| Meeting Updates | Calendar invites, meeting confirmations, reschedules, cancellations, agendas for upcoming meetings. |
| Notifications | Automated system alerts, routine reports, internal tooling notifications, scheduled digests from other systems. |
| Marketing | Newsletters, promotions, vendor pitches, product announcements, cold sales from services Gabe already uses. |
| Negative Review | Guest complaint or negative review, usually from Revinate or a similar system. |
| Positive Review | Positive guest review. |
| IGNORE | True noise: cold outreach from unknown senders, recruiters pitching services, mass marketing blasts with no relevance, bounce notifications, automated confirmations with zero signal. Respond with literally the word IGNORE. |

Rules:
1. Prefer IGNORE over Marketing for cold unsolicited outreach from UNKNOWN senders. Marketing category is for known vendors and newsletters Gabe has signed up for.
2. ALICE glitch reports ALWAYS get IGNORE, UNLESS the glitch describes: police involvement, fire/EMS, guest injury, security breach, legal liability, or major employee incident. Routine ops issues are IGNORE.
3. Revinate and similar guest review alerts get Negative Review or Positive Review ONLY if Gabe needs to know (named GM, pattern, serious complaint). Routine pillow-was-cold feedback gets IGNORE.
4. Anything from Brad Korzen (CEO) or Brian Delowe (President) is at minimum FYI, usually Needs Response or Approval Required.
5. Calendar invites and meeting confirmations from attendees go to Meeting Updates.

Respond with ONLY the category name from the list above. Nothing else.`;

async function classifyEmail(
  sender: string,
  subject: string,
  body: string,
): Promise<string | null> {
  const truncatedBody = body.slice(0, 2000);
  const prompt = `${CATEGORY_PROMPT}\n\nFrom: ${sender}\nSubject: ${subject}\n\n${truncatedBody}`;

  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      messages: [{ role: 'user', content: prompt }],
    });

    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: CREDENTIAL_PROXY_PORT,
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-api-key': 'placeholder',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            const text = data.content?.[0]?.text?.trim();
            if (!text) { resolve(null); return; }
            // IGNORE items get no category at all
            if (text.toUpperCase() === 'IGNORE') { resolve(null); return; }
            const match = VALID_CATEGORIES.find(
              (c) => c.toLowerCase() === text.toLowerCase(),
            );
            resolve(match || null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', (err) => {
      logger.warn({ err }, 'classifyEmail request failed');
      resolve(null);
    });
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.write(payload);
    req.end();
  });
}

export interface OutlookChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface ThreadMeta {
  sender: string;
  senderName: string;
  subject: string;
  conversationId: string;
}

const TOKENS_PATH = join(homedir(), '.outlook-mcp-tokens.json');
const CONTACTS_PATH = join(DATA_DIR, 'contacts', 'macos-contacts.json');
const CONTACTS_CACHE_TTL = 5 * 60 * 1000;

interface Contact {
  name: string;
  organization: string;
  title: string;
  emails: string[];
  phones: string[];
}

let contactsCache: { data: Map<string, Contact>; at: number } | null = null;

function loadContacts(): Map<string, Contact> {
  if (contactsCache && Date.now() - contactsCache.at < CONTACTS_CACHE_TTL) {
    return contactsCache.data;
  }
  try {
    const raw = readFileSync(CONTACTS_PATH, 'utf-8');
    const contacts: Contact[] = JSON.parse(raw);
    const emailMap = new Map<string, Contact>();
    for (const c of contacts) {
      for (const email of c.emails) {
        if (email) emailMap.set(email.toLowerCase(), c);
      }
    }
    contactsCache = { data: emailMap, at: Date.now() };
    logger.info(
      { count: emailMap.size },
      'Contacts loaded for sender enrichment',
    );
    return emailMap;
  } catch {
    return contactsCache?.data ?? new Map();
  }
}

function enrichSenderLine(senderEmail: string, senderName: string): string {
  const contacts = loadContacts();
  const contact = contacts.get(senderEmail.toLowerCase());
  if (!contact) return `${senderName} <${senderEmail}>`;
  const parts = [contact.name || senderName];
  if (contact.title) parts.push(contact.title);
  if (contact.organization) parts.push(contact.organization);
  return `${parts.join(', ')} <${senderEmail}>`;
}

export class OutlookChannel implements Channel {
  name = 'outlook';

  private client: Client | null = null;
  private opts: OutlookChannelOpts;
  private userEmail: string;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedIds = new Set<string>();
  private consecutiveErrors = 0;
  private threadMeta = new Map<string, ThreadMeta>();

  constructor(
    opts: OutlookChannelOpts,
    userEmail: string,
    pollIntervalMs = 60000,
  ) {
    this.opts = opts;
    this.userEmail = userEmail;
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    // Read delegated token from tokens file (refreshed by cron)
    const token = this.readToken();
    if (!token) {
      logger.error('Outlook: no token found in ' + TOKENS_PATH);
      return;
    }

    this.client = Client.init({
      authProvider: async (done) => {
        const t = this.readToken();
        if (t) {
          done(null, t);
        } else {
          done(new Error('Failed to read Outlook token'), null);
        }
      },
    });

    // Verify connection — use /me since this is a delegated token
    try {
      const user = await this.client
        .api('/me')
        .select('mail,displayName,userPrincipalName')
        .get();
      logger.info(
        { email: user.mail || this.userEmail, name: user.displayName },
        'Outlook channel connected (delegated)',
      );
      markConnected('outlook', {
        email: user.mail || this.userEmail,
        name: user.displayName,
      });
    } catch (err) {
      logger.error({ err }, 'Outlook: failed to verify connection');
      markDisconnected('outlook');
      this.client = null;
      return;
    }

    // Initial poll then schedule
    await this.pollForMessages();

    const schedulePoll = () => {
      const backoffMs =
        this.consecutiveErrors > 0
          ? Math.min(
              this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
              30 * 60 * 1000,
            )
          : this.pollIntervalMs;
      this.pollTimer = setTimeout(() => {
        this.pollForMessages()
          .catch((err) => logger.error({ err }, 'Outlook poll error'))
          .finally(() => {
            if (this.client) schedulePoll();
          });
      }, backoffMs);
    };

    schedulePoll();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Outlook not initialized');
      return;
    }

    const conversationId = jid.replace(/^outlook:/, '');
    const meta = this.threadMeta.get(conversationId);

    if (!meta) {
      logger.warn({ jid }, 'No thread metadata for Outlook reply, cannot send');
      return;
    }

    const subject = meta.subject.startsWith('Re:')
      ? meta.subject
      : `Re: ${meta.subject}`;

    try {
      await this.client.api('/me/sendMail').post({
        message: {
          subject,
          body: { contentType: 'text', content: text },
          toRecipients: [
            { emailAddress: { address: meta.sender, name: meta.senderName } },
          ],
          conversationId: meta.conversationId,
        },
      });
      logger.info({ to: meta.sender, conversationId }, 'Outlook reply sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Outlook reply');
    }
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('outlook:');
  }

  async categorizeEmail(emailId: string, categories: string[]): Promise<void> {
    if (!this.client) {
      logger.warn('Outlook not initialized, cannot categorize');
      return;
    }

    await this.client
      .api(`/me/messages/${emailId}`)
      .patch({ categories });

    logger.info({ emailId, categories }, 'Outlook email categories set');
  }

  async flagEmail(emailId: string, status: 'flagged' | 'complete' | 'notFlagged'): Promise<void> {
    if (!this.client) {
      logger.warn('Outlook not initialized, cannot flag');
      return;
    }

    await this.client
      .api(`/me/messages/${emailId}`)
      .patch({ flag: { flagStatus: status } });

    logger.info({ emailId, status }, 'Outlook email flag set');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.client = null;
    markDisconnected('outlook');
    logger.info('Outlook channel stopped');
  }

  // --- Private ---

  private readToken(): string | null {
    try {
      const data = JSON.parse(readFileSync(TOKENS_PATH, 'utf-8'));
      if (!data.access_token) {
        logger.error('Outlook: no access_token in tokens file');
        return null;
      }
      return data.access_token;
    } catch (err) {
      logger.error({ err }, 'Outlook: failed to read tokens file');
      return null;
    }
  }

  private async pollForMessages(): Promise<void> {
    if (!this.client) return;

    try {
      const res = await this.client
        .api(`/me/messages`)
        .filter('isRead eq false')
        .orderby('receivedDateTime desc')
        .top(10)
        .select('id,subject,from,receivedDateTime,body,conversationId,categories')
        .get();

      const messages: any[] = res.value || [];

      for (const msg of messages) {
        if (!msg.id || this.processedIds.has(msg.id)) continue;
        this.processedIds.add(msg.id);
        await this.processMessage(msg);
      }

      // Cap set size
      if (this.processedIds.size > 5000) {
        const ids = [...this.processedIds];
        this.processedIds = new Set(ids.slice(ids.length - 2500));
      }

      this.consecutiveErrors = 0;
      markEvent('outlook');
    } catch (err) {
      this.consecutiveErrors++;
      logger.error(
        { err, consecutiveErrors: this.consecutiveErrors },
        'Outlook poll failed',
      );
      // Three strikes: treat channel as disconnected so the dashboard
      // flips to down and alerts can fire. Transient hiccups don't flap.
      if (this.consecutiveErrors >= 3) {
        markDisconnected('outlook');
      }
    }
  }

  private async processMessage(msg: any): Promise<void> {
    if (!this.client) return;

    const from = msg.from?.emailAddress;
    const senderEmail = from?.address || 'unknown';
    const senderName = from?.name || senderEmail;

    // Skip self
    if (senderEmail.toLowerCase() === this.userEmail.toLowerCase()) return;

    const subject = msg.subject || '(no subject)';
    const timestamp = msg.receivedDateTime || new Date().toISOString();
    const conversationId = msg.conversationId || msg.id;
    const chatJid = `outlook:${conversationId}`;

    // Extract plain text body
    let body = '';
    if (msg.body?.contentType === 'text') {
      body = msg.body.content || '';
    } else if (msg.body?.content) {
      // Strip HTML tags
      body = msg.body.content
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    if (!body) {
      logger.debug(
        { msgId: msg.id, subject },
        'Skipping Outlook email with no body',
      );
      return;
    }

    // Cache thread metadata for replies
    this.threadMeta.set(conversationId, {
      sender: senderEmail,
      senderName,
      subject,
      conversationId,
    });

    // Cap thread meta cache
    if (this.threadMeta.size > 2000) {
      const keys = [...this.threadMeta.keys()];
      for (let i = 0; i < keys.length - 1000; i++) {
        this.threadMeta.delete(keys[i]);
      }
    }

    // Existing categories from Outlook
    const existingCategories: string[] = msg.categories || [];

    // Pre-filter noisy operational alerts that don't need COO attention.
    // ALICE glitch reports and Revinate review alerts are IGNORE by default
    // per nanoclawrules.md Inbox Hard Rules. Drop them before they reach the
    // main group unless the content contains a C-suite escalation keyword.
    const senderLower = senderEmail.toLowerCase();
    const isRevinate = senderLower.endsWith('@revinate.com');
    const isAliceGlitch =
      senderLower.endsWith('@actabl.com') && /\bALICE\b/i.test(subject);
    if (isRevinate || isAliceGlitch) {
      const escalationRegex =
        /\bpolice\b|\bfire (department|dept|brigade|rescue)\b|\bambulance\b|\bparamedic|\bEMS\b|\bEMT\b|\binjur(y|ed|ies)\b|\bmedical emergency\b|\blawsuit\b|\bliability\b|\bassault\b|\bdiscriminat|\bharass|unauthorized access|security breach/i;
      const haystack = `${subject}\n${body}`;
      if (!escalationRegex.test(haystack)) {
        logger.info(
          {
            source: isRevinate ? 'revinate' : 'alice',
            senderName,
            subject,
          },
          'Outlook noisy alert filtered (no C-suite escalation keyword)',
        );
        try {
          await this.client.api(`/me/messages/${msg.id}`).patch({
            isRead: true,
          });
        } catch (err) {
          logger.warn(
            { msgId: msg.id, err },
            'Failed to mark filtered email as read',
          );
        }
        return;
      }
      logger.info(
        {
          source: isRevinate ? 'revinate' : 'alice',
          senderName,
          subject,
        },
        'Outlook noisy alert escalated (matched C-suite keyword)',
      );
    }

    this.opts.onChatMetadata(chatJid, timestamp, subject, 'outlook', false);

    const groups = this.opts.registeredGroups();
    const mainEntry = Object.entries(groups).find(([, g]) => g.isMain === true);

    if (!mainEntry) {
      logger.debug(
        { chatJid, subject },
        'No main group registered, skipping Outlook email',
      );
      return;
    }

    const mainJid = mainEntry[0];
    const categoryLine = existingCategories.length > 0
      ? `\nCategories: ${existingCategories.join(', ')}`
      : '';
    const enrichedSender = enrichSenderLine(senderEmail, senderName);
    const content = `[Outlook email from ${enrichedSender}]\nEmail ID: ${msg.id}\nSubject: ${subject}${categoryLine}\n\n${body}`;

    this.opts.onMessage(mainJid, {
      id: msg.id,
      chat_jid: mainJid,
      sender: senderEmail,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    // Reply matcher: if this incoming email matches a tracked sent email
    // (same conversationId, waiting for reply), auto-close the open_item.
    try {
      const closed = closeOpenItemByConversationId(conversationId);
      if (closed > 0) {
        logAudit(
          'open_item_updated',
          conversationId,
          `Auto-closed follow-up: ${subject} (reply from ${senderName})`,
          'outlook_reply_matcher',
        );
        logger.info(
          { conversationId, senderName, subject, rowsClosed: closed },
          'Auto-closed follow-up on reply received',
        );
      }
    } catch (err) {
      logger.warn({ err, conversationId }, 'Reply matcher failed');
    }

    // Mark as read
    try {
      await this.client.api(`/me/messages/${msg.id}`).patch({ isRead: true });
    } catch (err) {
      logger.warn(
        { msgId: msg.id, err },
        'Failed to mark Outlook email as read',
      );
    }

    // Auto-categorize via Haiku. Enable by setting OUTLOOK_AUTO_CATEGORIZE=true in .env.
    // Reads via readEnvFile because process.env is not populated from .env on launchd.
    const catEnv = readEnvFile(['OUTLOOK_AUTO_CATEGORIZE']);
    const autoCategorize = catEnv.OUTLOOK_AUTO_CATEGORIZE === 'true';
    if (autoCategorize && existingCategories.length === 0) {
      try {
        const category = await classifyEmail(
          `${senderName} <${senderEmail}>`,
          subject,
          body,
        );
        if (category) {
          await this.client.api(`/me/messages/${msg.id}`).patch({
            categories: [category],
          });
          logger.info(
            { emailId: msg.id, category },
            'Outlook email auto-categorized',
          );
        }
      } catch (err) {
        logger.warn(
          { msgId: msg.id, err },
          'Auto-categorization failed',
        );
      }
    }

    logger.info(
      { mainJid, from: senderName, subject, categories: existingCategories },
      'Outlook email delivered to main group',
    );
  }
}

registerChannel('outlook', (opts: ChannelOpts) => {
  const secrets = readEnvFile([
    'MS_TENANT_ID',
    'MS_CLIENT_ID',
    'MS_CLIENT_SECRET',
    'MS_USER_EMAIL',
  ]);
  if (
    !secrets.MS_TENANT_ID ||
    !secrets.MS_CLIENT_ID ||
    !secrets.MS_CLIENT_SECRET ||
    !secrets.MS_USER_EMAIL
  ) {
    logger.warn(
      'Outlook: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_USER_EMAIL required in .env. Skipping.',
    );
    return null;
  }
  return new OutlookChannel(opts, secrets.MS_USER_EMAIL);
});
