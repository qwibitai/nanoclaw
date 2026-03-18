/**
 * IMAP MCP Server for NanoClaw — multi-account
 *
 * Loads accounts from two config files (merged):
 *   /home/node/.imap-mcp-global/config.json   — shared accounts (info@, etc.)
 *   /home/node/.imap-mcp-local/config.json    — local (per-channel) accounts
 *
 * Config format:
 *   { "accounts": { "<name>": { imap, smtp, from, archiveFolder? } } }
 *
 * All tools accept an optional "account" parameter.
 * Use list_accounts to discover available account names.
 *
 * Tools:
 *   list_accounts  — discover configured accounts
 *   list_emails    — list or search emails (search params optional)
 *   get_email      — fetch full email by UID
 *   compose_email  — compose new, reply, or forward — saves draft by default
 *   move_email     — move to any folder; use 'Trash' to delete, 'Archive' to archive
 *   list_folders   — list all IMAP folders
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
// @ts-ignore — nodemailer internal, no type declarations
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

const GLOBAL_CONFIG_PATH = '/home/node/.imap-mcp-global/config.json';
const LOCAL_CONFIG_PATH = '/home/node/.imap-mcp-local/config.json';

interface AccountConfig {
  imap: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } };
  smtp: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } };
  from: string;
  archiveFolder?: string; // override if server special-use detection is wrong
}

// Cache of special-use folder paths per account (user → { '\trash': path, '\drafts': path, ... })
const specialFolderCache = new Map<string, Record<string, string>>();

async function resolveSpecialFolders(cfg: AccountConfig): Promise<Record<string, string>> {
  const key = cfg.imap.auth.user;
  if (specialFolderCache.has(key)) return specialFolderCache.get(key)!;
  const client = makeClient(cfg);
  const map: Record<string, string> = {};
  try {
    await client.connect();
    const list = await client.list();
    for (const f of list) {
      if (f.specialUse) map[f.specialUse.toLowerCase()] = f.path;
    }
  } finally {
    await client.logout().catch(() => {});
  }
  specialFolderCache.set(key, map);
  return map;
}

// Resolve a logical folder name ('Trash', 'Archive', 'Drafts', 'Sent', 'Junk')
// to the actual server path using RFC 6154 special-use attributes.
async function resolveFolder(cfg: AccountConfig, logical: string, override?: string): Promise<string> {
  if (override) return override;
  const special = await resolveSpecialFolders(cfg);
  const logicalLower = logical.toLowerCase();
  // RFC 6154 special-use names map
  const rfcKey: Record<string, string> = {
    trash: '\\trash', archive: '\\archive', drafts: '\\drafts',
    sent: '\\sent', junk: '\\junk', spam: '\\junk',
  };
  const key = rfcKey[logicalLower];
  if (key && special[key]) return special[key];
  // Fall back to the literal name the caller passed
  return logical;
}

function loadAccounts(): Record<string, AccountConfig> {
  const accounts: Record<string, AccountConfig> = {};
  for (const configPath of [GLOBAL_CONFIG_PATH, LOCAL_CONFIG_PATH]) {
    if (!fs.existsSync(configPath)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { accounts: Record<string, AccountConfig> };
      Object.assign(accounts, cfg.accounts ?? {});
    } catch { /* ignore malformed files */ }
  }
  return accounts;
}

function getAccount(accounts: Record<string, AccountConfig>, name?: string): [string, AccountConfig] {
  if (name) {
    if (!accounts[name]) throw new Error(`Account "${name}" not found. Use list_accounts to see available accounts.`);
    return [name, accounts[name]];
  }
  const first = Object.entries(accounts)[0];
  if (!first) throw new Error('No IMAP accounts configured.');
  return first;
}

function makeClient(cfg: AccountConfig): ImapFlow {
  return new ImapFlow({
    host: cfg.imap.host,
    port: cfg.imap.port,
    secure: cfg.imap.secure,
    auth: cfg.imap.auth,
    logger: false,
  });
}

function makeTransport(cfg: AccountConfig) {
  return nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.secure,
    auth: cfg.smtp.auth,
  });
}

const ACCOUNT_PARAM = z.string().optional().describe(
  'Account name to use. Call list_accounts to see available accounts. Defaults to first account.',
);

const server = new McpServer({ name: 'imap', version: '2.0.0' });

// ─── list_accounts ────────────────────────────────────────────────────────────

server.tool(
  'list_accounts',
  'List all configured email accounts available to you.',
  {},
  async () => {
    const accounts = loadAccounts();
    const entries = Object.entries(accounts);
    if (entries.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No email accounts configured.' }] };
    }
    const lines = entries.map(([name, cfg]) => `${name}: ${cfg.from}`);
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  },
);

// ─── list_emails ──────────────────────────────────────────────────────────────

server.tool(
  'list_emails',
  'List or search emails. Omit search params to list recent emails. Add from/subject/body/since/before to filter.',
  {
    account: ACCOUNT_PARAM,
    folder: z.string().default('INBOX').describe('Folder to list/search (default: INBOX)'),
    limit: z.number().int().min(1).max(100).default(20).describe('Max emails to return (default: 20)'),
    offset: z.number().int().min(0).default(0).describe('Skip this many emails for pagination (default: 0)'),
    unseen_only: z.boolean().default(false).describe('Only return unread emails'),
    from: z.string().optional().describe('Filter by sender address or name'),
    subject: z.string().optional().describe('Filter by subject text'),
    body: z.string().optional().describe('Filter by body text'),
    since: z.string().optional().describe('ISO date — only emails on or after this date'),
    before: z.string().optional().describe('ISO date — only emails before this date'),
  },
  async (args) => {
    const [accountName, cfg] = getAccount(loadAccounts(), args.account);
    const client = makeClient(cfg);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(args.folder);
      try {
        // Build search criteria — empty object returns all messages
        const criteria: Record<string, unknown> = {};
        if (args.unseen_only) criteria['seen'] = false;
        if (args.from) criteria['from'] = args.from;
        if (args.subject) criteria['subject'] = args.subject;
        if (args.body) criteria['body'] = args.body;
        if (args.since) criteria['since'] = new Date(args.since);
        if (args.before) criteria['before'] = new Date(args.before);

        const allUids = await client.search(criteria, { uid: true });
        if (!allUids || allUids.length === 0) {
          return { content: [{ type: 'text' as const, text: `No emails found in ${args.folder} (${accountName}).` }] };
        }
        allUids.sort((a, b) => b - a);
        const total = allUids.length;
        const pageUids = allUids.slice(args.offset, args.offset + args.limit);
        if (pageUids.length === 0) {
          return { content: [{ type: 'text' as const, text: `No more emails (total: ${total}, offset: ${args.offset}).` }] };
        }
        const results: string[] = [];
        for await (const msg of client.fetch(pageUids, { uid: true, envelope: true, flags: true }, { uid: true })) {
          const envelope = msg.envelope;
          const from = envelope?.from?.[0]
            ? `${envelope.from[0].name ?? ''} <${envelope.from[0].address ?? ''}>`.trim()
            : 'Unknown';
          const subject = envelope?.subject ?? '(no subject)';
          const date = envelope?.date?.toISOString().split('T')[0] ?? '';
          const seen = (msg.flags ?? new Set<string>()).has('\\Seen');
          results.push(`UID ${msg.uid} | ${seen ? 'READ' : 'UNREAD'} | ${date} | From: ${from} | Subject: ${subject}`);
        }
        const header = `[${accountName}] Showing ${args.offset + 1}–${args.offset + results.length} of ${total} in ${args.folder}:`;
        return { content: [{ type: 'text' as const, text: `${header}\n${results.join('\n')}` }] };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  },
);

// ─── get_email ────────────────────────────────────────────────────────────────

server.tool(
  'get_email',
  'Get full email by UID — returns headers and body.',
  {
    account: ACCOUNT_PARAM,
    uid: z.number().int().describe('UID of the email to fetch'),
    folder: z.string().default('INBOX').describe('Folder containing the email (default: INBOX)'),
  },
  async (args) => {
    const [, cfg] = getAccount(loadAccounts(), args.account);
    const client = makeClient(cfg);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(args.folder);
      try {
        const msg = await client.fetchOne(
          String(args.uid),
          { uid: true, envelope: true, flags: true, bodyStructure: true, source: true },
          { uid: true },
        );
        if (!msg) return { content: [{ type: 'text' as const, text: `Email UID ${args.uid} not found.` }] };
        const envelope = msg.envelope;
        const from = envelope?.from?.map((a) => `${a.name ?? ''} <${a.address ?? ''}>`.trim()).join(', ') ?? '';
        const to = envelope?.to?.map((a) => `${a.name ?? ''} <${a.address ?? ''}>`.trim()).join(', ') ?? '';
        const subject = envelope?.subject ?? '(no subject)';
        const date = envelope?.date?.toISOString() ?? '';
        const messageId = envelope?.messageId ?? '';
        let bodyText = '';
        if (msg.source) {
          const raw = Buffer.isBuffer(msg.source) ? msg.source.toString('utf-8') : String(msg.source);
          const bodyStart = raw.indexOf('\r\n\r\n');
          bodyText = bodyStart !== -1 ? raw.slice(bodyStart + 4) : raw;
          if (bodyText.length > 8000) bodyText = bodyText.slice(0, 8000) + '\n... (truncated)';
        }
        return {
          content: [{ type: 'text' as const, text: [
            `UID: ${args.uid}`, `Message-ID: ${messageId}`, `Date: ${date}`,
            `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, '', bodyText,
          ].join('\n') }],
        };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
  },
);

// ─── compose_email ────────────────────────────────────────────────────────────

server.tool(
  'compose_email',
  [
    'Compose a new email, reply, or forward. Saves as draft by default (send: false) — set send: true to send immediately.',
    'For replies: set reply_to_uid to auto-fill recipient, subject (Re: ...), and threading headers.',
    'For forwards: set forward_uid to fetch and append the original email body.',
  ].join(' '),
  {
    account: ACCOUNT_PARAM,
    to: z.string().describe('Recipient(s), comma-separated. Auto-filled when reply_to_uid is set.'),
    subject: z.string().optional().describe('Subject. Auto-filled for replies (Re: ...) and forwards (Fwd: ...).'),
    body: z.string().describe('Plain-text body'),
    cc: z.string().optional().describe('CC address(es), comma-separated'),
    bcc: z.string().optional().describe('BCC address(es), comma-separated'),
    html: z.string().optional().describe('Optional HTML body'),
    send: z.boolean().default(false).describe('If false (default), saves as draft. If true, sends immediately.'),
    reply_to_uid: z.number().int().optional().describe('UID of email to reply to — sets threading headers and auto-fills recipient/subject'),
    forward_uid: z.number().int().optional().describe('UID of email to forward — appends original message body'),
    source_folder: z.string().default('INBOX').describe('Folder for reply_to_uid/forward_uid lookup (default: INBOX)'),
    drafts_folder: z.string().optional().describe('Folder to save draft in (auto-detected via IMAP special-use)'),
    reply_all: z.boolean().default(false).describe('When replying, also include original To/CC recipients'),
  },
  async (args) => {
    const [accountName, cfg] = getAccount(loadAccounts(), args.account);

    let to = args.to;
    let subject = args.subject ?? '';
    let inReplyTo = '';
    let references = '';
    let prependBody = '';

    // Fetch original email for reply or forward
    const refUid = args.reply_to_uid ?? args.forward_uid;
    if (refUid !== undefined) {
      const client = makeClient(cfg);
      try {
        await client.connect();
        const lock = await client.getMailboxLock(args.source_folder);
        try {
          const msg = await client.fetchOne(String(refUid), { uid: true, envelope: true, source: true }, { uid: true });
          if (!msg) throw new Error(`Email UID ${refUid} not found`);
          const envelope = msg.envelope;

          if (args.reply_to_uid !== undefined) {
            // Reply: set threading headers, auto-fill recipient and subject
            inReplyTo = envelope?.messageId ?? '';
            references = inReplyTo;
            if (!args.subject) {
              const orig = envelope?.subject ?? '';
              subject = orig.startsWith('Re:') ? orig : `Re: ${orig}`;
            }
            const replyAddr = envelope?.replyTo?.[0]?.address ?? envelope?.from?.[0]?.address ?? '';
            to = to || replyAddr;
            if (args.reply_all) {
              const extras = [...(envelope?.to ?? []), ...(envelope?.cc ?? [])]
                .map((a) => a.address ?? '')
                .filter((a) => a && a !== cfg.smtp.auth.user)
                .join(', ');
              to = [to, extras].filter(Boolean).join(', ');
            }
          } else {
            // Forward: prepend original message info
            const origFrom = envelope?.from?.[0]?.address ?? '';
            const origDate = envelope?.date?.toISOString() ?? '';
            const origSubject = envelope?.subject ?? '(no subject)';
            if (!args.subject) subject = `Fwd: ${origSubject}`;
            let origBody = '';
            if (msg.source) {
              const raw = Buffer.isBuffer(msg.source) ? msg.source.toString('utf-8') : String(msg.source);
              const bodyStart = raw.indexOf('\r\n\r\n');
              origBody = bodyStart !== -1 ? raw.slice(bodyStart + 4) : raw;
              if (origBody.length > 8000) origBody = origBody.slice(0, 8000);
            }
            prependBody = [
              '---------- Forwarded message ----------',
              `From: ${origFrom}`, `Date: ${origDate}`, `Subject: ${origSubject}`, '',
              origBody, '',
            ].join('\n');
          }
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => {});
      }
    }

    const fullBody = prependBody ? `${args.body}\n\n${prependBody}` : args.body;
    const mailOptions = {
      from: cfg.from, to, cc: args.cc, bcc: args.bcc,
      subject, text: fullBody, html: args.html,
      ...(inReplyTo ? { inReplyTo, references } : {}),
    };

    if (args.send) {
      const transport = makeTransport(cfg);
      await transport.sendMail(mailOptions);
      return { content: [{ type: 'text' as const, text: `Email sent from ${accountName} (${cfg.from}) to ${to}.` }] };
    } else {
      // Save as draft
      const raw = await new Promise<Buffer>((resolve, reject) => {
        const composer = new MailComposer(mailOptions);
        composer.compile().build((err: Error | null, msg: Buffer) => {
          if (err) reject(err); else resolve(msg);
        });
      });
      const client = makeClient(cfg);
      try {
        const draftsFolder = await resolveFolder(cfg, 'Drafts', args.drafts_folder);
        await client.connect();
        await client.append(draftsFolder, raw, ['\\Draft', '\\Seen']);
        return { content: [{ type: 'text' as const, text: `Draft saved to ${draftsFolder} (${accountName}).` }] };
      } finally {
        await client.logout().catch(() => {});
      }
    }
  },
);

// ─── move_email ───────────────────────────────────────────────────────────────

server.tool(
  'move_email',
  'Move an email to any folder. Use "Trash" to delete, "Archive" to archive — actual paths are auto-detected.',
  {
    account: ACCOUNT_PARAM,
    uid: z.number().int().describe('UID of the email to move'),
    from_folder: z.string().default('INBOX').describe('Source folder (default: INBOX)'),
    to_folder: z.string().describe('Destination folder — use "Trash", "Archive", "Sent", "Junk", or an exact path'),
  },
  async (args) => {
    const [, cfg] = getAccount(loadAccounts(), args.account);
    const archiveOverride = args.to_folder === 'Archive' ? cfg.archiveFolder : undefined;
    const dest = await resolveFolder(cfg, args.to_folder, archiveOverride);
    const client = makeClient(cfg);
    try {
      await client.connect();
      const lock = await client.getMailboxLock(args.from_folder);
      try {
        await client.messageMove(String(args.uid), dest, { uid: true });
        return { content: [{ type: 'text' as const, text: `UID ${args.uid} moved to ${dest}.` }] };
      } finally { lock.release(); }
    } finally { await client.logout().catch(() => {}); }
  },
);

// ─── list_folders ─────────────────────────────────────────────────────────────

server.tool(
  'list_folders',
  'List all IMAP folders/mailboxes for an account.',
  { account: ACCOUNT_PARAM },
  async (args) => {
    const [, cfg] = getAccount(loadAccounts(), args.account);
    const client = makeClient(cfg);
    try {
      await client.connect();
      const list = await client.list();
      const folders = list.map((f) => f.path);
      return {
        content: [{ type: 'text' as const, text: folders.length === 0 ? 'No folders found.' : folders.join('\n') }],
      };
    } finally { await client.logout().catch(() => {}); }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
