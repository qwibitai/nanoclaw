/**
 * IMAP/SMTP email service for NanoClaw.
 * Runs host-side; containers never touch credentials directly.
 * Credentials: IMAP_PASSWORD env var (set in launchd plist).
 */

import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { ImapFlow } from 'imapflow';

import { ImapConfig } from './types.js';
import { logger } from './logger.js';

export interface ImapResult {
  data?: unknown;
  error?: string;
  exitCode: number;
}

const DEFAULT_ALLOWED_FOLDERS = ['INBOX'];
const DEFAULT_ALLOWED_OPERATIONS = ['list', 'read', 'search', 'send', 'delete'];
const MAX_LIMIT = 50;

function deny(message: string): ImapResult {
  return { error: message, exitCode: 1 };
}

function createImapClient(config: ImapConfig): ImapFlow {
  const password = process.env.IMAP_PASSWORD;
  if (!password) throw new Error('IMAP_PASSWORD environment variable not set');
  return new ImapFlow({
    host: config.host,
    port: config.port ?? 993,
    secure: true,
    auth: { user: config.username, pass: password },
    logger: false,
  });
}

export async function executeImapCommand(
  config: ImapConfig | undefined,
  operation: string,
  params: Record<string, unknown>,
): Promise<ImapResult> {
  if (!config) return deny('IMAP not configured for this group.');

  const allowedOps = config.allowedOperations ?? DEFAULT_ALLOWED_OPERATIONS;
  if (!allowedOps.includes(operation)) {
    return deny(`Operation '${operation}' is not allowed for this group.`);
  }

  try {
    switch (operation) {
      case 'list':
        return await listEmails(config, params);
      case 'read':
        return await readEmail(config, params);
      case 'search':
        return await searchEmails(config, params);
      case 'send':
        return await sendEmail(config, params);
      case 'delete':
        return await deleteEmail(config, params);
      default:
        return deny(`Unknown operation: ${operation}`);
    }
  } catch (err) {
    logger.error({ err, operation }, 'IMAP command failed');
    return {
      error: err instanceof Error ? err.message : String(err),
      exitCode: 1,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function checkFolder(config: ImapConfig, folder: string): ImapResult | null {
  const allowed = config.allowedFolders ?? DEFAULT_ALLOWED_FOLDERS;
  if (!allowed.includes(folder))
    return deny(`Folder '${folder}' is not allowed.`);
  return null;
}

// ── Operations ───────────────────────────────────────────────────────────────

async function listEmails(
  config: ImapConfig,
  params: Record<string, unknown>,
): Promise<ImapResult> {
  const folder = String(params.folder ?? 'INBOX');
  const folderDenied = checkFolder(config, folder);
  if (folderDenied) return folderDenied;

  const limit = Math.min(Number(params.limit ?? 20), MAX_LIMIT);
  const unreadOnly = params.unread_only === true;
  const fromFilter = params.from ? String(params.from) : undefined;
  const since = params.since ? new Date(String(params.since)) : undefined;

  const client = createImapClient(config);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      // Build search criteria
      const criteria: Record<string, unknown> = {};
      if (unreadOnly) criteria['seen'] = false;
      if (fromFilter) criteria['from'] = fromFilter;
      if (since) criteria['since'] = since;

      let uids: number[];
      if (Object.keys(criteria).length > 0) {
        uids = (await client.search(criteria, { uid: true })) as number[];
      } else {
        const status = await client.status(folder, { messages: true });
        const total = status.messages ?? 0;
        if (total === 0)
          return { data: { emails: [], total: 0, folder }, exitCode: 0 };
        uids = [];
        for await (const msg of client.fetch(
          `${Math.max(1, total - limit + 1)}:*`,
          { uid: true },
        )) {
          uids.push(msg.uid);
        }
      }

      const selectedUids = uids.slice(-limit);
      const emails: object[] = [];

      if (selectedUids.length > 0) {
        for await (const msg of client.fetch(
          selectedUids.join(','),
          { envelope: true, flags: true, uid: true },
          { uid: true },
        )) {
          const env = msg.envelope;
          emails.push({
            uid: msg.uid,
            subject: env?.subject ?? '(no subject)',
            from: env?.from?.[0]
              ? `${env.from[0].name ?? ''} <${env.from[0].address}>`.trim()
              : '',
            date: env?.date?.toISOString() ?? '',
            read: msg.flags?.has('\\Seen') ?? false,
          });
        }
      }

      return {
        data: { emails: emails.reverse(), total: uids.length, folder },
        exitCode: 0,
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function readEmail(
  config: ImapConfig,
  params: Record<string, unknown>,
): Promise<ImapResult> {
  if (!params.uid) return deny('uid is required for read.');
  const uid = Number(params.uid);
  const folder = String(params.folder ?? 'INBOX');
  const folderDenied = checkFolder(config, folder);
  if (folderDenied) return folderDenied;

  const client = createImapClient(config);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const message = await client.fetchOne(
        String(uid),
        { source: true, flags: true, envelope: true },
        { uid: true },
      );
      if (!message) return deny(`Email UID ${uid} not found.`);

      const parsed = await simpleParser(message.source as Buffer);
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });

      return {
        data: {
          uid,
          subject: parsed.subject ?? '(no subject)',
          from: parsed.from?.text ?? '',
          to: Array.isArray(parsed.to)
            ? parsed.to.map((a) => a.text).join(', ')
            : (parsed.to?.text ?? ''),
          cc: Array.isArray(parsed.cc)
            ? parsed.cc.map((a) => a.text).join(', ')
            : (parsed.cc?.text ?? ''),
          date: parsed.date?.toISOString() ?? '',
          body: parsed.text ?? '',
          html: parsed.html || undefined,
          attachments: (parsed.attachments ?? []).map((a: any) => ({
            filename: a.filename ?? 'attachment',
            contentType: a.contentType,
            size: a.size,
          })),
        },
        exitCode: 0,
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function searchEmails(
  config: ImapConfig,
  params: Record<string, unknown>,
): Promise<ImapResult> {
  if (!params.query) return deny('query is required for search.');
  const folder = String(params.folder ?? 'INBOX');
  const folderDenied = checkFolder(config, folder);
  if (folderDenied) return folderDenied;

  const limit = Math.min(Number(params.limit ?? 20), MAX_LIMIT);
  const client = createImapClient(config);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const uids = (await client.search(
        { text: String(params.query) },
        { uid: true },
      )) as number[];
      const selectedUids = uids.slice(-limit);
      const emails: object[] = [];

      if (selectedUids.length > 0) {
        for await (const msg of client.fetch(
          selectedUids.join(','),
          { envelope: true, flags: true, uid: true },
          { uid: true },
        )) {
          const env = msg.envelope;
          emails.push({
            uid: msg.uid,
            subject: env?.subject ?? '(no subject)',
            from: env?.from?.[0]
              ? `${env.from[0].name ?? ''} <${env.from[0].address}>`.trim()
              : '',
            date: env?.date?.toISOString() ?? '',
            read: msg.flags?.has('\\Seen') ?? false,
          });
        }
      }

      return {
        data: {
          emails: emails.reverse(),
          total: uids.length,
          folder,
          query: params.query,
        },
        exitCode: 0,
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

async function sendEmail(
  config: ImapConfig,
  params: Record<string, unknown>,
): Promise<ImapResult> {
  if (!params.to) return deny('to is required for send.');
  if (!params.subject) return deny('subject is required for send.');
  if (!params.body && !params.html)
    return deny('body or html is required for send.');

  const password = process.env.IMAP_PASSWORD;
  if (!password) return deny('IMAP_PASSWORD environment variable not set.');

  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.smtpPort ?? 465,
    secure: true,
    auth: { user: config.username, pass: password },
  });

  const info = await transporter.sendMail({
    from: config.username,
    to: String(params.to),
    subject: String(params.subject),
    text: params.body ? String(params.body) : undefined,
    html: params.html ? String(params.html) : undefined,
    cc: params.cc ? String(params.cc) : undefined,
  });

  return {
    data: { messageId: info.messageId, accepted: info.accepted },
    exitCode: 0,
  };
}

async function deleteEmail(
  config: ImapConfig,
  params: Record<string, unknown>,
): Promise<ImapResult> {
  if (!params.uid) return deny('uid is required for delete.');
  const uid = Number(params.uid);
  const folder = String(params.folder ?? 'INBOX');
  const folderDenied = checkFolder(config, folder);
  if (folderDenied) return folderDenied;

  const client = createImapClient(config);
  await client.connect();
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      // Try common Trash folder names in order
      const trashCandidates = [
        'Trash',
        'Deleted Messages',
        'Deleted Items',
        '[Gmail]/Trash',
      ];
      let movedTo = '';
      for (const trashName of trashCandidates) {
        try {
          await client.messageMove(String(uid), trashName, { uid: true });
          movedTo = trashName;
          break;
        } catch {
          // Try next candidate
        }
      }
      if (!movedTo) {
        // Fallback: flag as \Deleted
        await client.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true });
        movedTo = '\\Deleted (flagged for expunge)';
      }
      return { data: { uid, moved_to: movedTo, folder }, exitCode: 0 };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}
