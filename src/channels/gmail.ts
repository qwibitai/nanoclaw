import fs from 'fs';
import os from 'os';
import path from 'path';

import { google, gmail_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import { GROUPS_DIR } from '../config.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface GmailChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface ThreadMeta {
  sender: string;
  senderName: string;
  subject: string;
  messageId: string; // RFC 2822 Message-ID for In-Reply-To
}

interface AttachmentInfo {
  filename: string;
  mimeType: string;
  containerPath: string;
}

export class GmailChannel implements Channel {
  name = 'gmail';

  private oauth2Client: OAuth2Client | null = null;
  private gmail: gmail_v1.Gmail | null = null;
  private opts: GmailChannelOpts;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private processedIds = new Set<string>();
  private threadMeta = new Map<string, ThreadMeta>();
  private consecutiveErrors = 0;
  private userEmail = '';

  constructor(opts: GmailChannelOpts, pollIntervalMs = 60000) {
    this.opts = opts;
    this.pollIntervalMs = pollIntervalMs;
  }

  async connect(): Promise<void> {
    const credDir = path.join(os.homedir(), '.gmail-mcp');
    const keysPath = path.join(credDir, 'gcp-oauth.keys.json');
    const tokensPath = path.join(credDir, 'credentials.json');

    if (!fs.existsSync(keysPath) || !fs.existsSync(tokensPath)) {
      logger.warn(
        'Gmail credentials not found in ~/.gmail-mcp/. Skipping Gmail channel. Run /add-gmail to set up.',
      );
      return;
    }

    const keys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
    const tokens = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));

    const clientConfig = keys.installed || keys.web || keys;
    const { client_id, client_secret, redirect_uris } = clientConfig;
    this.oauth2Client = new google.auth.OAuth2(
      client_id,
      client_secret,
      redirect_uris?.[0],
    );
    this.oauth2Client.setCredentials(tokens);

    // Persist refreshed tokens
    this.oauth2Client.on('tokens', (newTokens) => {
      try {
        const current = JSON.parse(fs.readFileSync(tokensPath, 'utf-8'));
        Object.assign(current, newTokens);
        fs.writeFileSync(tokensPath, JSON.stringify(current, null, 2));
        logger.debug('Gmail OAuth tokens refreshed');
      } catch (err) {
        logger.warn({ err }, 'Failed to persist refreshed Gmail tokens');
      }
    });

    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

    // Verify connection
    const profile = await this.gmail.users.getProfile({ userId: 'me' });
    this.userEmail = profile.data.emailAddress || '';
    logger.info({ email: this.userEmail }, 'Gmail channel connected');

    // Start polling with error backoff
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
          .catch((err) => logger.error({ err }, 'Gmail poll error'))
          .finally(() => {
            if (this.gmail) schedulePoll();
          });
      }, backoffMs);
    };

    // Initial poll
    await this.pollForMessages();
    schedulePoll();
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.gmail) {
      logger.warn('Gmail not initialized');
      return;
    }

    const threadId = jid.replace(/^gmail:/, '');
    let meta = this.threadMeta.get(threadId);

    // Fallback: fetch thread metadata from Gmail API if not cached
    if (!meta) {
      meta = await this.fetchThreadMeta(threadId);
      if (meta) {
        this.threadMeta.set(threadId, meta);
      }
    }

    if (!meta) {
      logger.warn({ jid }, 'No thread metadata for reply, cannot send');
      return;
    }

    const raw = this.buildTextMessage(meta, threadId, text);

    try {
      await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw, threadId },
      });
      logger.info({ to: meta.sender, threadId }, 'Gmail reply sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Gmail reply');
    }
  }

  async sendImage(
    jid: string,
    imagePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.gmail) {
      logger.warn('Gmail not initialized');
      return;
    }

    const threadId = jid.replace(/^gmail:/, '');
    let meta = this.threadMeta.get(threadId);
    if (!meta) {
      meta = await this.fetchThreadMeta(threadId);
      if (meta) this.threadMeta.set(threadId, meta);
    }
    if (!meta) {
      logger.warn({ jid }, 'No thread metadata for image reply, cannot send');
      return;
    }

    try {
      const fileData = fs.readFileSync(imagePath);
      const filename = path.basename(imagePath);
      const mimeType = mimeTypeFromExtension(filename);
      const raw = this.buildMultipartMessage(
        meta,
        threadId,
        caption || '',
        fileData,
        filename,
        mimeType,
        'inline',
      );

      await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw, threadId },
      });
      logger.info({ to: meta.sender, threadId, imagePath }, 'Gmail image sent');
    } catch (err) {
      logger.error({ jid, imagePath, err }, 'Failed to send Gmail image');
      // Fallback to text
      await this.sendMessage(
        jid,
        caption || '(Image could not be sent via email)',
      );
    }
  }

  async sendDocument(
    jid: string,
    documentPath: string,
    filename?: string,
    caption?: string,
  ): Promise<void> {
    if (!this.gmail) {
      logger.warn('Gmail not initialized');
      return;
    }

    const threadId = jid.replace(/^gmail:/, '');
    let meta = this.threadMeta.get(threadId);
    if (!meta) {
      meta = await this.fetchThreadMeta(threadId);
      if (meta) this.threadMeta.set(threadId, meta);
    }
    if (!meta) {
      logger.warn(
        { jid },
        'No thread metadata for document reply, cannot send',
      );
      return;
    }

    try {
      const fileData = fs.readFileSync(documentPath);
      const attachFilename = filename || path.basename(documentPath);
      const mimeType = mimeTypeFromExtension(attachFilename);
      const raw = this.buildMultipartMessage(
        meta,
        threadId,
        caption || '',
        fileData,
        attachFilename,
        mimeType,
        'attachment',
      );

      await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw, threadId },
      });
      logger.info(
        { to: meta.sender, threadId, documentPath },
        'Gmail document sent',
      );
    } catch (err) {
      logger.error({ jid, documentPath, err }, 'Failed to send Gmail document');
      await this.sendMessage(
        jid,
        caption || '(Document could not be sent via email)',
      );
    }
  }

  isConnected(): boolean {
    return this.gmail !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('gmail:');
  }

  async disconnect(): Promise<void> {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.gmail = null;
    this.oauth2Client = null;
    logger.info('Gmail channel stopped');
  }

  // --- Private helpers ---

  private buildQuery(): string {
    return 'is:unread category:primary';
  }

  /** Fetch thread metadata from Gmail API for reply threading. */
  private async fetchThreadMeta(
    threadId: string,
  ): Promise<ThreadMeta | undefined> {
    if (!this.gmail) return undefined;

    try {
      const thread = await this.gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'metadata',
        metadataHeaders: ['From', 'Subject', 'Message-ID'],
      });

      const messages = thread.data.messages;
      if (!messages || messages.length === 0) return undefined;

      // Use the last message in the thread for In-Reply-To
      const lastMsg = messages[messages.length - 1];
      const msgHeaders = lastMsg.payload?.headers || [];
      const getHeader = (name: string) =>
        msgHeaders.find((h) => h.name?.toLowerCase() === name.toLowerCase())
          ?.value || '';

      const from = getHeader('From');
      const subject = getHeader('Subject');
      const rfc2822MessageId = getHeader('Message-ID');

      // Find the most recent non-self sender for the To address
      let sender = '';
      let senderName = '';
      for (let i = messages.length - 1; i >= 0; i--) {
        const hdrs = messages[i].payload?.headers || [];
        const msgFrom =
          hdrs.find((h) => h.name?.toLowerCase() === 'from')?.value || '';
        const match = msgFrom.match(/^(.+?)\s*<(.+?)>$/);
        const email = match ? match[2] : msgFrom;
        if (email && email !== this.userEmail) {
          sender = email;
          senderName = match ? match[1].replace(/"/g, '') : msgFrom;
          break;
        }
      }

      if (!sender) {
        // All messages are from self — extract from first message
        const match = from.match(/^(.+?)\s*<(.+?)>$/);
        sender = match ? match[2] : from;
        senderName = match ? match[1].replace(/"/g, '') : from;
      }

      return { sender, senderName, subject, messageId: rfc2822MessageId };
    } catch (err) {
      logger.warn({ threadId, err }, 'Failed to fetch thread metadata');
      return undefined;
    }
  }

  private buildReplyHeaders(meta: ThreadMeta, threadId: string): string[] {
    const subject = meta.subject.startsWith('Re:')
      ? meta.subject
      : `Re: ${meta.subject}`;

    const headers = [
      `To: ${meta.sender}`,
      `From: ${this.userEmail}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
    ];

    if (meta.messageId) {
      headers.push(`In-Reply-To: ${meta.messageId}`);
      headers.push(`References: ${meta.messageId}`);
    }

    return headers;
  }

  private buildTextMessage(
    meta: ThreadMeta,
    threadId: string,
    text: string,
  ): string {
    const headers = [
      ...this.buildReplyHeaders(meta, threadId),
      'Content-Type: text/plain; charset=utf-8',
      '',
      text,
    ];

    return base64UrlEncode(headers.join('\r\n'));
  }

  private buildMultipartMessage(
    meta: ThreadMeta,
    threadId: string,
    text: string,
    fileData: Buffer,
    filename: string,
    mimeType: string,
    disposition: 'inline' | 'attachment',
  ): string {
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    const headers = [
      ...this.buildReplyHeaders(meta, threadId),
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
    ];

    const parts: string[] = [];

    // Text body part
    if (text) {
      parts.push(
        [
          `--${boundary}`,
          'Content-Type: text/plain; charset=utf-8',
          '',
          text,
        ].join('\r\n'),
      );
    }

    // File attachment part
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${mimeType}; name="${filename}"`,
        `Content-Disposition: ${disposition}; filename="${filename}"`,
        'Content-Transfer-Encoding: base64',
        '',
        fileData.toString('base64'),
      ].join('\r\n'),
    );

    const raw = [
      headers.join('\r\n'),
      parts.join('\r\n'),
      `\r\n--${boundary}--`,
    ].join('\r\n');

    return base64UrlEncode(raw);
  }

  private async pollForMessages(): Promise<void> {
    if (!this.gmail) return;

    try {
      const query = this.buildQuery();
      const res = await this.gmail.users.messages.list({
        userId: 'me',
        q: query,
        maxResults: 10,
      });

      const messages = res.data.messages || [];

      for (const stub of messages) {
        if (!stub.id || this.processedIds.has(stub.id)) continue;
        this.processedIds.add(stub.id);

        await this.processMessage(stub.id);
      }

      // Cap processed ID set to prevent unbounded growth
      if (this.processedIds.size > 5000) {
        const ids = [...this.processedIds];
        this.processedIds = new Set(ids.slice(ids.length - 2500));
      }

      this.consecutiveErrors = 0;
    } catch (err) {
      this.consecutiveErrors++;
      const backoffMs = Math.min(
        this.pollIntervalMs * Math.pow(2, this.consecutiveErrors),
        30 * 60 * 1000,
      );
      logger.error(
        {
          err,
          consecutiveErrors: this.consecutiveErrors,
          nextPollMs: backoffMs,
        },
        'Gmail poll failed',
      );
    }
  }

  private async processMessage(messageId: string): Promise<void> {
    if (!this.gmail) return;

    const msg = await this.gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });

    const headers = msg.data.payload?.headers || [];
    const getHeader = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())
        ?.value || '';

    const from = getHeader('From');
    const subject = getHeader('Subject');
    const rfc2822MessageId = getHeader('Message-ID');
    const threadId = msg.data.threadId || messageId;
    const timestamp = new Date(
      parseInt(msg.data.internalDate || '0', 10),
    ).toISOString();

    // Extract sender name and email
    const senderMatch = from.match(/^(.+?)\s*<(.+?)>$/);
    const senderName = senderMatch ? senderMatch[1].replace(/"/g, '') : from;
    const senderEmail = senderMatch ? senderMatch[2] : from;

    // Skip emails from self (our own replies)
    if (senderEmail === this.userEmail) return;

    // Extract body text
    const body = this.extractTextBody(msg.data.payload);

    // Find the main group to deliver the email notification
    const groups = this.opts.registeredGroups();
    const mainEntry = Object.entries(groups).find(([, g]) => g.isMain === true);

    if (!mainEntry) {
      logger.debug({ subject }, 'No main group registered, skipping email');
      return;
    }

    const mainJid = mainEntry[0];
    const mainFolder = mainEntry[1].folder;

    // Extract and download attachments
    const attachments = await this.extractAttachments(
      msg.data.payload,
      messageId,
      mainFolder,
    );

    // Skip emails with no text body AND no attachments
    if (!body && attachments.length === 0) {
      logger.debug({ messageId, subject }, 'Skipping email with no content');
      return;
    }

    const chatJid = `gmail:${threadId}`;

    // Cache thread metadata for replies
    this.threadMeta.set(threadId, {
      sender: senderEmail,
      senderName,
      subject,
      messageId: rfc2822MessageId,
    });

    // Store chat metadata for group discovery
    this.opts.onChatMetadata(chatJid, timestamp, subject, 'gmail', false);

    // Build content with attachment info
    let content = `[Email from ${senderName} <${senderEmail}>]\nSubject: ${subject}\n\n${body}`;

    if (attachments.length > 0) {
      const attachmentLines = attachments.map((a) => {
        if (a.mimeType.startsWith('image/')) {
          return `[Image: ${a.containerPath} — use Read tool to view] (${a.filename})`;
        }
        return `[Attachment: ${a.containerPath}] (${a.filename}, ${a.mimeType})`;
      });
      content += '\n\nAttachments:\n' + attachmentLines.join('\n');
    }

    this.opts.onMessage(mainJid, {
      id: messageId,
      chat_jid: mainJid,
      sender: senderEmail,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: false,
    });

    // Mark as read
    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] },
      });
    } catch (err) {
      logger.warn({ messageId, err }, 'Failed to mark email as read');
    }

    logger.info(
      {
        mainJid,
        from: senderName,
        subject,
        attachmentCount: attachments.length,
      },
      'Gmail email delivered to main group',
    );
  }

  private extractTextBody(
    payload: gmail_v1.Schema$MessagePart | undefined,
  ): string {
    if (!payload) return '';

    // Direct text/plain body
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }

    // Multipart: search parts recursively
    if (payload.parts) {
      // Prefer text/plain
      for (const part of payload.parts) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
      }
      // Recurse into nested multipart
      for (const part of payload.parts) {
        const text = this.extractTextBody(part);
        if (text) return text;
      }
    }

    return '';
  }

  /** Extract and download attachments from an email message. */
  private async extractAttachments(
    payload: gmail_v1.Schema$MessagePart | undefined,
    messageId: string,
    groupFolder: string,
  ): Promise<AttachmentInfo[]> {
    if (!payload || !this.gmail) return [];

    const parts = this.collectAttachmentParts(payload);
    const results: AttachmentInfo[] = [];

    for (const part of parts) {
      try {
        let data: Buffer;

        if (part.body?.attachmentId) {
          // Large attachment — fetch separately
          const attachment = await this.gmail.users.messages.attachments.get({
            userId: 'me',
            messageId,
            id: part.body.attachmentId,
          });
          if (!attachment.data.data) continue;
          data = Buffer.from(attachment.data.data, 'base64');
        } else if (part.body?.data) {
          // Small inline attachment — data already present
          data = Buffer.from(part.body.data, 'base64');
        } else {
          continue;
        }

        const mimeType = part.mimeType || 'application/octet-stream';
        const isImage = mimeType.startsWith('image/');
        const subDir = isImage ? 'images' : 'uploads';
        const filename =
          part.filename || `attachment-${messageId}-${results.length}`;
        const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, '_');

        const destDir = path.join(GROUPS_DIR, groupFolder, subDir);
        fs.mkdirSync(destDir, { recursive: true });

        const destPath = path.join(destDir, safeFilename);
        fs.writeFileSync(destPath, data);

        const containerPath = `/workspace/group/${subDir}/${safeFilename}`;
        results.push({ filename, mimeType, containerPath });

        logger.info(
          { messageId, filename, mimeType, destPath },
          'Gmail attachment saved',
        );
      } catch (err) {
        logger.warn(
          { messageId, filename: part.filename, err },
          'Failed to download Gmail attachment',
        );
      }
    }

    return results;
  }

  /** Recursively collect all parts that represent attachments (have filename or attachmentId). */
  private collectAttachmentParts(
    payload: gmail_v1.Schema$MessagePart,
  ): gmail_v1.Schema$MessagePart[] {
    const results: gmail_v1.Schema$MessagePart[] = [];

    if (payload.filename && payload.filename.length > 0) {
      results.push(payload);
    } else if (
      payload.body?.attachmentId &&
      payload.mimeType !== 'text/plain' &&
      payload.mimeType !== 'text/html'
    ) {
      // Inline content with attachmentId but no filename (e.g., inline images via CID)
      results.push(payload);
    }

    if (payload.parts) {
      for (const part of payload.parts) {
        results.push(...this.collectAttachmentParts(part));
      }
    }

    return results;
  }
}

// Helpers

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.html': 'text/html',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
};

export function mimeTypeFromExtension(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

registerChannel('gmail', (opts: ChannelOpts) => {
  const credDir = path.join(os.homedir(), '.gmail-mcp');
  if (
    !fs.existsSync(path.join(credDir, 'gcp-oauth.keys.json')) ||
    !fs.existsSync(path.join(credDir, 'credentials.json'))
  ) {
    logger.warn('Gmail: credentials not found in ~/.gmail-mcp/');
    return null;
  }
  return new GmailChannel(opts);
});
