import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getImapClient, getSmtpTransport } from '../auth.js';
import { ok, err } from '../types.js';
import { marked } from 'marked';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract plain-text body from a raw MIME source string. */
function extractBody(source: string): string {
  // Body starts after the first double CRLF (end of headers)
  const idx = source.indexOf('\r\n\r\n');
  if (idx === -1) return source;
  return source.slice(idx + 4).trim();
}

/** Render markdown text to HTML. */
function renderHtml(markdown: string): string {
  return marked.parse(markdown, { async: false }) as string;
}

/** Build a raw MIME message string for draft/sent append. */
function buildRawMime(fields: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}): string {
  const senderEmail = process.env.ICLOUD_SENDER_EMAIL;
  const boundary = `----nanoclaw-${Date.now()}`;
  const headers: string[] = [];

  if (senderEmail) headers.push(`From: ${senderEmail}`);
  headers.push(
    `To: ${fields.to}`,
    `Subject: ${fields.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    `Date: ${new Date().toUTCString()}`,
  );
  if (fields.cc) headers.push(`Cc: ${fields.cc}`);

  const htmlBody = renderHtml(fields.body);

  const parts = [
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    fields.body,
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    htmlBody,
    `--${boundary}--`,
  ];

  return [...headers, '', ...parts].join('\r\n');
}

// ---------------------------------------------------------------------------
// Handler functions
// ---------------------------------------------------------------------------

export async function handleListFolders() {
  try {
    const client = await getImapClient();
    const folders = await client.list();

    const results = folders.map((f: { name: string; path: string; status?: { messages?: number; unseen?: number } }) => ({
      name: f.name,
      path: f.path,
      messageCount: f.status?.messages ?? 0,
      unread: f.status?.unseen ?? 0,
    }));

    return ok(results);
  } catch (e) {
    return err(`Failed to list folders: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleListMessages(params: {
  folder?: string;
  limit?: number;
}) {
  const folder = params.folder ?? 'INBOX';
  const limit = params.limit ?? 50;

  try {
    const client = await getImapClient();
    const lock = await client.getMailboxLock(folder);
    try {
      const mailbox = client.mailbox;
      if (!mailbox) return ok([]);
      const total = mailbox.exists;
      if (total === 0) {
        return ok([]);
      }

      const start = Math.max(1, total - limit + 1);
      const range = `${start}:*`;

      const messages: Array<{
        id: number;
        subject: string;
        sender: string;
        date: string;
        read: boolean;
        flagged: boolean;
      }> = [];

      for await (const msg of client.fetch(range, { envelope: true, flags: true, uid: true })) {
        const from = msg.envelope!.from?.[0];
        messages.push({
          id: msg.uid,
          subject: msg.envelope!.subject ?? '',
          sender: from?.address ?? '',
          date: msg.envelope!.date?.toISOString?.() ?? String(msg.envelope!.date ?? ''),
          read: msg.flags!.has('\\Seen'),
          flagged: msg.flags!.has('\\Flagged'),
        });
      }

      return ok(messages);
    } finally {
      lock.release();
    }
  } catch (e) {
    return err(`Failed to list messages: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleReadMessage(params: { id: number }) {
  try {
    const client = await getImapClient();
    const lock = await client.getMailboxLock('INBOX');
    try {
      let found = null;

      for await (const msg of client.fetch(params.id, { envelope: true, source: true, uid: true }, { uid: true })) {
        found = msg;
      }

      if (!found) {
        return err(`Message ${params.id} not found`);
      }

      // Mark as read
      await client.messageFlagsAdd(params.id, ['\\Seen'], { uid: true });

      const source = found.source ? found.source.toString() : '';
      const body = extractBody(source);

      const from = found.envelope!.from?.[0];
      const toAddrs = (found.envelope!.to ?? []).map((a: { address?: string }) => a.address).filter(Boolean);
      const ccAddrs = (found.envelope!.cc ?? []).map((a: { address?: string }) => a.address).filter(Boolean);

      return ok({
        subject: found.envelope!.subject ?? '',
        sender: from?.address ?? '',
        to: toAddrs,
        cc: ccAddrs,
        date: found.envelope!.date?.toISOString?.() ?? String(found.envelope!.date ?? ''),
        body,
      });
    } finally {
      lock.release();
    }
  } catch (e) {
    return err(`Failed to read message: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleSend(params: {
  to: string;
  subject: string;
  body: string;
  from?: string;
  cc?: string;
  bcc?: string;
}) {
  try {
    const transport = getSmtpTransport();

    const mailOptions: Record<string, unknown> = {
      to: params.to,
      subject: params.subject,
      text: params.body,
      html: renderHtml(params.body),
    };

    if (params.from) mailOptions.from = params.from;
    if (params.cc) mailOptions.cc = params.cc;
    if (params.bcc) mailOptions.bcc = params.bcc;

    const info = await transport.sendMail(mailOptions);

    // Save copy to Sent Messages
    try {
      const client = await getImapClient();
      const rawMime = buildRawMime({
        to: params.to,
        subject: params.subject,
        body: params.body,
        cc: params.cc,
        bcc: params.bcc,
      });
      await client.append('Sent Messages', rawMime, ['\\Seen']);
    } catch (appendErr) {
      console.error('Failed to save to Sent Messages:', appendErr);
    }

    return ok({ success: true, messageId: info.messageId });
  } catch (e) {
    return err(`Failed to send email: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleReply(params: {
  id: number;
  body: string;
  reply_all?: boolean;
}) {
  try {
    const client = await getImapClient();
    const lock = await client.getMailboxLock('INBOX');
    let original = null;
    try {
      for await (const msg of client.fetch(params.id, { envelope: true, uid: true }, { uid: true })) {
        original = msg;
      }
    } finally {
      lock.release();
    }

    if (!original) {
      return err(`Message ${params.id} not found`);
    }

    const origSubject = original.envelope!.subject ?? '';
    const subject = origSubject.startsWith('Re:') ? origSubject : `Re: ${origSubject}`;
    const from = original.envelope!.from?.[0];
    const messageId = original.envelope!.messageId;

    const replyFrom = process.env.ICLOUD_SENDER_EMAIL;
    const mailOptions: Record<string, unknown> = {
      to: from?.address ?? '',
      subject,
      text: params.body,
      html: renderHtml(params.body),
      inReplyTo: messageId,
    };
    if (replyFrom) mailOptions.from = replyFrom;

    if (params.reply_all) {
      const ccAddrs = (original.envelope!.cc ?? [])
        .map((a: { address?: string }) => a.address)
        .filter(Boolean);
      if (ccAddrs.length > 0) {
        mailOptions.cc = ccAddrs.join(', ');
      }
    }

    const transport = getSmtpTransport();
    const info = await transport.sendMail(mailOptions);

    // Save copy to Sent Messages
    try {
      const sentMime = buildRawMime({
        to: from?.address ?? '',
        subject,
        body: params.body,
        cc: typeof mailOptions.cc === 'string' ? mailOptions.cc : undefined,
      });
      await client.append('Sent Messages', sentMime, ['\\Seen']);
    } catch (appendErr) {
      console.error('Failed to save reply to Sent Messages:', appendErr);
    }

    return ok({ success: true, messageId: info.messageId });
  } catch (e) {
    return err(`Failed to reply: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleForward(params: {
  id: number;
  to: string;
  body?: string;
}) {
  try {
    const client = await getImapClient();
    const lock = await client.getMailboxLock('INBOX');
    let original = null;
    try {
      for await (const msg of client.fetch(params.id, { envelope: true, source: true, uid: true }, { uid: true })) {
        original = msg;
      }
    } finally {
      lock.release();
    }

    if (!original) {
      return err(`Message ${params.id} not found`);
    }

    const origSubject = original.envelope!.subject ?? '';
    const subject = origSubject.startsWith('Fwd:') ? origSubject : `Fwd: ${origSubject}`;

    const source = original.source ? original.source.toString() : '';
    const originalBody = extractBody(source);

    const from = original.envelope!.from?.[0];
    const forwardedBlock = [
      '---------- Forwarded message ----------',
      `From: ${from?.address ?? ''}`,
      `Subject: ${origSubject}`,
      `Date: ${original.envelope!.date ?? ''}`,
      '',
      originalBody,
    ].join('\n');

    const textParts: string[] = [];
    if (params.body) {
      textParts.push(params.body);
      textParts.push('');
    }
    textParts.push(forwardedBlock);

    const fullText = textParts.join('\n');
    const fwdFrom = process.env.ICLOUD_SENDER_EMAIL;
    const fwdOptions: Record<string, unknown> = {
      to: params.to,
      subject,
      text: fullText,
      html: renderHtml(fullText),
    };
    if (fwdFrom) fwdOptions.from = fwdFrom;

    const transport = getSmtpTransport();
    const info = await transport.sendMail(fwdOptions);

    // Save copy to Sent Messages
    try {
      const sentMime = buildRawMime({
        to: params.to,
        subject,
        body: fullText,
      });
      await client.append('Sent Messages', sentMime, ['\\Seen']);
    } catch (appendErr) {
      console.error('Failed to save forward to Sent Messages:', appendErr);
    }

    return ok({ success: true, messageId: info.messageId });
  } catch (e) {
    return err(`Failed to forward: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleSearch(params: {
  query: string;
  folder?: string;
}) {
  const folder = params.folder ?? 'INBOX';

  try {
    const client = await getImapClient();
    const lock = await client.getMailboxLock(folder);
    try {
      const searchResult = await client.search(
        { or: [{ subject: params.query }, { from: params.query }, { body: params.query }] },
        { uid: true },
      );
      const uids: number[] = searchResult || [];

      if (uids.length === 0) {
        return ok([]);
      }

      const results: Array<{
        id: number;
        subject: string;
        sender: string;
        date: string;
      }> = [];

      for await (const msg of client.fetch(uids, { envelope: true, uid: true }, { uid: true })) {
        const from = msg.envelope!.from?.[0];
        results.push({
          id: msg.uid,
          subject: msg.envelope!.subject ?? '',
          sender: from?.address ?? '',
          date: msg.envelope!.date?.toISOString?.() ?? String(msg.envelope!.date ?? ''),
        });
      }

      return ok(results);
    } finally {
      lock.release();
    }
  } catch (e) {
    return err(`Failed to search: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleCreateDraft(params: {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  bcc?: string;
}) {
  try {
    const client = await getImapClient();

    const rawMime = buildRawMime({
      to: params.to,
      subject: params.subject,
      body: params.body,
      cc: params.cc,
      bcc: params.bcc,
    });

    const result = await client.append('Drafts', rawMime, ['\\Draft']);

    return ok({ success: true, id: result && typeof result !== 'boolean' ? result.uid : null });
  } catch (e) {
    return err(`Failed to create draft: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleUpdateDraft(params: {
  id: number;
  to?: string;
  subject?: string;
  body?: string;
}) {
  try {
    const client = await getImapClient();

    let origTo = '';
    let origSubject = '';
    let origBody = '';

    const lock = await client.getMailboxLock('Drafts');
    try {
      let original = null;
      for await (const msg of client.fetch(params.id, { envelope: true, source: true, uid: true }, { uid: true })) {
        original = msg;
      }

      if (!original) {
        return err(`Draft ${params.id} not found`);
      }

      origTo = original.envelope!.to?.[0]?.address ?? '';
      origSubject = original.envelope!.subject ?? '';
      const origSource = original.source ? original.source.toString() : '';
      origBody = extractBody(origSource);

      // Delete old draft while holding the lock
      await client.messageDelete(params.id, { uid: true });
    } finally {
      lock.release();
    }

    const newTo = params.to ?? origTo;
    const newSubject = params.subject ?? origSubject;
    const newBody = params.body ?? origBody;

    const rawMime = buildRawMime({
      to: newTo,
      subject: newSubject,
      body: newBody,
    });

    const result = await client.append('Drafts', rawMime, ['\\Draft']);

    return ok({ success: true, id: result && typeof result !== 'boolean' ? result.uid : null });
  } catch (e) {
    return err(`Failed to update draft: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleFlag(params: { id: number; flagged: boolean }) {
  try {
    const client = await getImapClient();
    const lock = await client.getMailboxLock('INBOX');
    try {
      if (params.flagged) {
        await client.messageFlagsAdd(params.id, ['\\Flagged'], { uid: true });
      } else {
        await client.messageFlagsRemove(params.id, ['\\Flagged'], { uid: true });
      }
      return ok({ success: true });
    } finally {
      lock.release();
    }
  } catch (e) {
    return err(`Failed to update flag: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleMarkRead(params: { id: number; read: boolean }) {
  try {
    const client = await getImapClient();
    const lock = await client.getMailboxLock('INBOX');
    try {
      if (params.read) {
        await client.messageFlagsAdd(params.id, ['\\Seen'], { uid: true });
      } else {
        await client.messageFlagsRemove(params.id, ['\\Seen'], { uid: true });
      }
      return ok({ success: true });
    } finally {
      lock.release();
    }
  } catch (e) {
    return err(`Failed to update read status: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function handleMove(params: { id: number; target_folder: string }) {
  try {
    const client = await getImapClient();
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageMove(params.id, params.target_folder, { uid: true });
      return ok({ success: true });
    } finally {
      lock.release();
    }
  } catch (e) {
    return err(`Failed to move message: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ---------------------------------------------------------------------------
// MCP Registration
// ---------------------------------------------------------------------------

export function registerMail(server: McpServer): void {
  server.tool(
    'icloud_mail_list_folders',
    'List all iCloud Mail folders with message counts',
    {},
    async () => handleListFolders(),
  );

  server.tool(
    'icloud_mail_list_messages',
    'List messages in a mail folder (most recent first)',
    {
      folder: z.string().optional().describe('Folder to list messages from (default: INBOX)'),
      limit: z.number().optional().describe('Maximum number of messages to return (default: 50)'),
    },
    async (params) => handleListMessages(params),
  );

  server.tool(
    'icloud_mail_read_message',
    'Read the full content of an email message',
    {
      id: z.number().describe('UID of the message to read'),
    },
    async (params) => handleReadMessage(params),
  );

  server.tool(
    'icloud_mail_send',
    'Send a new email via iCloud Mail',
    {
      to: z.string().describe('Recipient email address(es)'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Email body text'),
      from: z.string().optional().describe('Sender email address (defaults to ICLOUD_SENDER_EMAIL or account email)'),
      cc: z.string().optional().describe('CC recipient(s)'),
      bcc: z.string().optional().describe('BCC recipient(s)'),
    },
    async (params) => handleSend(params),
  );

  server.tool(
    'icloud_mail_reply',
    'Reply to an existing email message',
    {
      id: z.number().describe('UID of the message to reply to'),
      body: z.string().describe('Reply body text'),
      reply_all: z.boolean().optional().describe('Reply to all recipients (default: false)'),
    },
    async (params) => handleReply(params),
  );

  server.tool(
    'icloud_mail_forward',
    'Forward an email message to another recipient',
    {
      id: z.number().describe('UID of the message to forward'),
      to: z.string().describe('Recipient to forward to'),
      body: z.string().optional().describe('Additional text to prepend to forwarded message'),
    },
    async (params) => handleForward(params),
  );

  server.tool(
    'icloud_mail_search',
    'Search for emails by subject, sender, or body text',
    {
      query: z.string().describe('Search query (matches subject, from, or body)'),
      folder: z.string().optional().describe('Folder to search in (default: INBOX)'),
    },
    async (params) => handleSearch(params),
  );

  server.tool(
    'icloud_mail_create_draft',
    'Create a new email draft',
    {
      to: z.string().describe('Recipient email address(es)'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Email body text'),
      cc: z.string().optional().describe('CC recipient(s)'),
      bcc: z.string().optional().describe('BCC recipient(s)'),
    },
    async (params) => handleCreateDraft(params),
  );

  server.tool(
    'icloud_mail_update_draft',
    'Update an existing email draft (deletes old and creates new)',
    {
      id: z.number().describe('UID of the draft to update'),
      to: z.string().optional().describe('New recipient(s)'),
      subject: z.string().optional().describe('New subject'),
      body: z.string().optional().describe('New body text'),
    },
    async (params) => handleUpdateDraft(params),
  );

  server.tool(
    'icloud_mail_flag',
    'Flag or unflag an email message',
    {
      id: z.number().describe('UID of the message'),
      flagged: z.boolean().describe('Whether to flag (true) or unflag (false)'),
    },
    async (params) => handleFlag(params),
  );

  server.tool(
    'icloud_mail_mark_read',
    'Mark an email message as read or unread',
    {
      id: z.number().describe('UID of the message'),
      read: z.boolean().describe('Whether to mark as read (true) or unread (false)'),
    },
    async (params) => handleMarkRead(params),
  );

  server.tool(
    'icloud_mail_move',
    'Move an email message to a different folder',
    {
      id: z.number().describe('UID of the message to move'),
      target_folder: z.string().describe('Target folder path'),
    },
    async (params) => handleMove(params),
  );
}
